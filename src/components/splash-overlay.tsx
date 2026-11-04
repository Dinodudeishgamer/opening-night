import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';

// Must match the expo-splash-screen plugin config in app.json so the native
// splash hands off to this overlay without a visible jump.
const SPLASH_BACKGROUND = '#0C0D10';
const MARK_WIDTH = 120;
const EXIT_DURATION = 500;
/** Longest we'll wait for the native splash to confirm it's gone. */
const HIDE_TIMEOUT = 400;

/**
 * Recreates the native splash (dark background, gold star mark) in JS, then
 * fades it out once the app underneath has rendered. This hides the abrupt cut
 * between the OS splash and the first frame of the app.
 *
 * The fade uses React Native's own Animated rather than reanimated's layout
 * animations: this view is fully opaque, so it has to be impossible to get
 * stuck. Reanimated's web exit path both fails to clean up its DOM node and
 * depends on callbacks that don't reliably fire there — either one would leave
 * the app unreachable behind a black screen.
 */
export function SplashOverlay() {
  const [visible, setVisible] = useState(true);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;

    // Never wait on hideAsync indefinitely — on web it can stay pending.
    Promise.race([
      SplashScreen.hideAsync().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, HIDE_TIMEOUT)),
    ]).then(() => {
      if (cancelled) return;

      Animated.timing(progress, {
        toValue: 1,
        duration: EXIT_DURATION,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        if (!cancelled) setVisible(false);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [progress]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.overlay,
        {
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) },
          ],
        },
      ]}>
      <Image style={styles.mark} source={require('@/assets/images/splash-icon.png')} contentFit="contain" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SPLASH_BACKGROUND,
  },
  mark: { width: MARK_WIDTH, height: MARK_WIDTH },
});
