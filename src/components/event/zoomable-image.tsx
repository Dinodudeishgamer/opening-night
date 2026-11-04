import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
/** How far a vertical pull has to travel before release closes the viewer. */
const DISMISS_DISTANCE = 110;

type ZoomableImageProps = {
  uri?: string;
  width: number;
  height: number;
  /** Told when this page leaves 1× so the pager can stop stealing the drag. */
  onZoomChange: (zoomed: boolean) => void;
  /** Single tap — used to show/hide the viewer chrome. */
  onTap: () => void;
  /** Pull-away-to-close, the gesture every native photo viewer answers to. */
  onDismiss: () => void;
};

/**
 * One page of the photo viewer: pinch to zoom, drag to pan once zoomed, double
 * tap to zoom toward the tapped spot, and — at 1× — pull vertically to
 * dismiss. Horizontal swipes are deliberately left alone so an un-zoomed photo
 * still pages through to the next one.
 */
export function ZoomableImage({ uri, width, height, onZoomChange, onTap, onDismiss }: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  /** Dismiss drag offset. Only ever non-zero while un-zoomed. */
  const dragY = useSharedValue(0);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  /**
   * Mirrors `scale > 1` on the JS side. The pan gestures below need it as a
   * plain value, because whether a gesture is *enabled* has to be decided
   * before the touch starts — a shared value read inside a callback is far too
   * late to stop it claiming the swipe.
   */
  const [isZoomed, setIsZoomed] = useState(false);

  const reportZoom = useCallback(
    (next: boolean) => {
      setIsZoomed(next);
      onZoomChange(next);
    },
    [onZoomChange]
  );

  function reset() {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
    runOnJS(reportZoom)(false);
  }

  // How far the image can travel at a given scale before its edge pulls into view.
  function maxOffsetAt(axis: 'x' | 'y', atScale: number) {
    'worklet';
    const size = axis === 'x' ? width : height;
    return Math.max(0, (size * atScale - size) / 2);
  }

  function clamp(value: number, limit: number) {
    'worklet';
    return Math.min(limit, Math.max(-limit, value));
  }

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(0.8, savedScale.value * e.scale));
    })
    .onEnd(() => {
      if (scale.value <= 1) {
        reset();
        return;
      }
      savedScale.value = scale.value;
      translateX.value = clamp(translateX.value, maxOffsetAt('x', scale.value));
      translateY.value = clamp(translateY.value, maxOffsetAt('y', scale.value));
      savedX.value = translateX.value;
      savedY.value = translateY.value;
      runOnJS(reportZoom)(true);
    });

  /**
   * Panning a zoomed-in photo. Disabled entirely at 1×, and that is the whole
   * reason paging works: a Pan gesture claims the touch the moment it activates,
   * regardless of what its callback then decides to do. This one used to be
   * always-on and simply `return`ed early when un-zoomed — so every horizontal
   * swipe was captured here, did nothing, and never reached the pager
   * underneath. That was the "can't swipe to the other photos" bug.
   */
  const zoomPan = Gesture.Pan()
    .enabled(isZoomed)
    .onUpdate((e) => {
      translateX.value = clamp(savedX.value + e.translationX, maxOffsetAt('x', scale.value));
      translateY.value = clamp(savedY.value + e.translationY, maxOffsetAt('y', scale.value));
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  // Pull the photo away to close. Only while un-zoomed — once you're zoomed in,
  // a vertical drag means "pan the photo", not "put it away". `failOffsetX`
  // hands anything horizontal straight to the pager underneath.
  const dismissPan = Gesture.Pan()
    .enabled(!isZoomed)
    .maxPointers(1)
    .activeOffsetY([-14, 14])
    .failOffsetX([-10, 10])
    .onUpdate((e) => {
      dragY.value = e.translationY;
    })
    .onEnd((e) => {
      if (Math.abs(e.translationY) > DISMISS_DISTANCE) {
        dragY.value = withTiming(e.translationY > 0 ? height : -height, { duration: 180 });
        runOnJS(onDismiss)();
      } else {
        dragY.value = withTiming(0);
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (scale.value > 1) {
        reset();
        return;
      }
      // Zoom toward the tapped spot: the point under the finger stays put.
      const target = DOUBLE_TAP_SCALE;
      const tx = clamp((width / 2 - e.x) * (target - 1), maxOffsetAt('x', target));
      const ty = clamp((height / 2 - e.y) * (target - 1), maxOffsetAt('y', target));
      scale.value = withTiming(target);
      savedScale.value = target;
      translateX.value = withTiming(tx);
      translateY.value = withTiming(ty);
      savedX.value = tx;
      savedY.value = ty;
      runOnJS(reportZoom)(true);
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(onTap)();
    });

  // Double tap has to win outright, or every one of them fires a single tap first.
  const gesture = Gesture.Race(
    Gesture.Simultaneous(pinch, zoomPan, dismissPan),
    Gesture.Exclusive(doubleTap, singleTap)
  );

  const animatedStyle = useAnimatedStyle(() => {
    // The photo shrinks and fades slightly as it's pulled away, so the release
    // threshold reads as "letting go of something already leaving".
    const pull = Math.abs(dragY.value);
    return {
      opacity: interpolate(pull, [0, 420], [1, 0.35], 'clamp'),
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value + dragY.value },
        { scale: scale.value * interpolate(pull, [0, 600], [1, 0.82], 'clamp') },
      ],
    };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height }, animatedStyle]}>
        <Image
          source={uri ? { uri } : undefined}
          style={{ width, height }}
          contentFit="contain"
          transition={200}
          cachePolicy="memory-disk"
          onLoad={() => setLoadState('ready')}
          onError={() => setLoadState('failed')}
        />

        {loadState !== 'ready' && (
          <View style={styles.overlay} pointerEvents="none">
            {loadState === 'loading' ? (
              <ActivityIndicator size="large" color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="image-outline" size={32} color="rgba(255,255,255,0.7)" />
                <ThemedText type="small" style={styles.failedText}>
                  Couldn’t load this photo
                </ThemedText>
              </>
            )}
          </View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  failedText: { color: 'rgba(255,255,255,0.7)' },
});
