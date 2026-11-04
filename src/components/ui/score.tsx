// Scores, 0.00 to 5.00: picking one, and showing a group's.
import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MAX_SCORE, score } from '@/lib/format';
import { haptic } from '@/lib/haptics';

const within = (value: number) => Math.min(MAX_SCORE, Math.max(0, value));
// Dragging lands on tenths; the buttons move a hundredth at a time, for a 4.88.
const toTenth = (value: number) => Math.round(within(value) * 10) / 10;
const toHundredth = (value: number) => Math.round(within(value) * 100) / 100;

/**
 * Picks a score without a keyboard: drag (or tap) along the bar for the
 * number to the tenth, and fine-tune by a hundredth with the buttons either
 * side of it.
 */
export function ScorePicker({ value, onChange, label }: { value: number | null; onChange: (value: number) => void; label: string }) {
  const theme = useTheme();
  const bar = useRef<View>(null);
  // Where the bar sits on screen, so a touch can be turned into a score.
  const frame = useRef({ left: 0, width: 1 });

  const measure = () => bar.current?.measureInWindow((left, _top, width) => (frame.current = { left, width: Math.max(width, 1) }));
  // Every tenth that goes by is felt, like the notches of a dial.
  const set = (next: number) => {
    if (next === value) return;
    haptic.tick();
    onChange(next);
  };
  const fromTouch = (pageX: number) => set(toTenth(((pageX - frame.current.left) / frame.current.width) * MAX_SCORE));
  const nudge = (by: number) => set(toHundredth((value ?? MAX_SCORE / 2) + by));
  const position = `${((value ?? 0) / MAX_SCORE) * 100}%` as const;

  const stepper = (icon: 'remove' | 'add', by: number, name: string) => (
    <Pressable
      onPress={() => nudge(by)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={name}
      style={({ pressed }) => [styles.stepper, { borderColor: theme.border, backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
      <Ionicons name={icon} size={22} color={theme.text} />
    </Pressable>
  );

  return (
    <View style={styles.picker}>
      <View style={styles.readout}>
        {stepper('remove', -0.01, 'Lower by a hundredth')}
        <View style={styles.number}>
          <ThemedText style={[styles.big, { color: value === null ? theme.border : theme.text }]}>{value === null ? '0.00' : score(value)}</ThemedText>
          <ThemedText type="eyebrow" themeColor="textSecondary">
            {value === null ? 'Slide to choose' : `Out of ${MAX_SCORE}`}
          </ThemedText>
        </View>
        {stepper('add', 0.01, 'Raise by a hundredth')}
      </View>

      <View
        ref={bar}
        style={styles.barHit}
        onLayout={measure}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        // Keep the touch once it has started: the page behind should not scroll while a score is being dragged.
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          measure();
          fromTouch(event.nativeEvent.pageX);
        }}
        onResponderMove={(event) => fromTouch(event.nativeEvent.pageX)}
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: MAX_SCORE, now: value ?? undefined }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => nudge(event.nativeEvent.actionName === 'increment' ? 0.25 : -0.25)}>
        <View style={[styles.rail, { backgroundColor: theme.border }]} pointerEvents="none">
          <View style={[styles.railFill, { width: position, backgroundColor: theme.accent }]} />
        </View>
        <View style={[styles.thumbTrack]} pointerEvents="none">
          <View style={[styles.thumb, { left: position, backgroundColor: theme.accent, borderColor: theme.backgroundElement, opacity: value === null ? 0.45 : 1 }]} />
        </View>
      </View>
      <View style={styles.scale} pointerEvents="none">
        {[0, 1, 2, 3, 4, 5].map((mark) => (
          <ThemedText key={mark} type="small" themeColor="textSecondary" style={styles.mark}>
            {mark}
          </ThemedText>
        ))}
      </View>
    </View>
  );
}

/** How a set of scores is spread, as ten bars from 0 to 5, half a point each. */
function Histogram({ values, height = 56 }: { values: number[]; height?: number }) {
  const theme = useTheme();
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const value of values) buckets[Math.min(9, Math.max(0, Math.floor(value * 2)))] += 1;
  const tallest = Math.max(1, ...buckets);

  return (
    <View style={styles.fill} accessibilityLabel={`${values.length} score${values.length === 1 ? '' : 's'}`}>
      <View style={[styles.bars, { height }]}>
        {buckets.map((count, index) => (
          <View key={index} style={[styles.bar, { height: count ? Math.max(8, (count / tallest) * height) : 3, backgroundColor: count ? theme.accent : theme.border }]} />
        ))}
      </View>
      <View style={styles.axis}>
        <ThemedText type="small" themeColor="textSecondary">
          0
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {MAX_SCORE}
        </ThemedText>
      </View>
    </View>
  );
}

/** The spread on the left, the average large on the right: the way a film page shows its rating. */
export function ScoreSummary({ label, values, average, footnote }: { label: string; values: number[]; average: number; footnote?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.summary}>
      <Histogram values={values} />
      <View style={styles.summaryNumber}>
        <ThemedText type="eyebrow" themeColor="textSecondary">
          {label}
        </ThemedText>
        <ThemedText style={[styles.average, { color: theme.accent }]}>{score(average)}</ThemedText>
        {footnote ? (
          <ThemedText type="small" themeColor="textSecondary">
            {footnote}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );
}

/** "+0.38" in green, "-1.20" in red, "0.00" in grey. */
export function Delta({ value }: { value: number }) {
  const theme = useTheme();
  const color = value > 0 ? theme.success : value < 0 ? theme.danger : theme.textSecondary;
  return (
    <View style={[styles.delta, { backgroundColor: `${color}22` }]}>
      <ThemedText style={[styles.deltaText, { color }]}>
        {value > 0 ? '+' : ''}
        {value.toFixed(2)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },

  picker: { gap: Spacing.one },
  readout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  number: { alignItems: 'center' },
  big: { fontFamily: Font.serifBold, fontSize: 52, lineHeight: 60, letterSpacing: -1 },
  barHit: { height: 40, justifyContent: 'center' },
  rail: { height: 8, borderRadius: 4, overflow: 'hidden' },
  railFill: { height: 8, borderRadius: 4 },
  thumbTrack: { ...StyleSheet.absoluteFillObject, justifyContent: 'center' },
  thumb: { position: 'absolute', width: 26, height: 26, borderRadius: 13, borderWidth: 3, marginLeft: -13 },
  scale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -6 },
  mark: { width: 20, textAlign: 'center', marginHorizontal: -10 },

  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  bar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },

  summary: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.four },
  summaryNumber: { alignItems: 'flex-end' },
  average: { fontFamily: Font.serifBold, fontSize: 48, lineHeight: 54, letterSpacing: -1 },

  delta: { borderRadius: Radius.full, paddingHorizontal: Spacing.two, paddingVertical: 2, minWidth: 56, alignItems: 'center' },
  deltaText: { fontFamily: Font.bold, fontSize: 13, lineHeight: 18 },
});
