// The page furniture every screen shares. The app has two kinds of block:
//
//   Section   something you read. It sits flat on the page under a small
//             capitalised heading with a hairline rule, the way a film page
//             lists its cast or its reviews.
//   Card      something you do (see card.tsx). A surface of its own, tinted
//             gold when it is your turn.
//
// Keeping to those two is what lets a long page be read at a glance.
import { LinearGradient } from 'expo-linear-gradient';
import { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** "ON THE CALENDAR · 2 ————————", with an optional control at the far end. */
export function SectionHeader({ title, count, right }: { title: string; count?: number; right?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.header}>
      <ThemedText type="eyebrow" themeColor="textSecondary">
        {title}
        {count ? ` · ${count}` : ''}
      </ThemedText>
      <View style={[styles.rule, { backgroundColor: theme.border }]} />
      {right}
    </View>
  );
}

/** A heading and what belongs under it, flat on the page. */
export function Section({ title, count, right, children, style }: { title: string; count?: number; right?: ReactNode; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.section, style]}>
      <SectionHeader title={title} count={count} right={right} />
      {children}
    </View>
  );
}

/**
 * A fade of `color` from one strength to another, top to bottom. By default
 * clear at the top and solid at the bottom.
 */
export function Fade({ color, height, from = 0, to = 1 }: { color: string; height: number; from?: number; to?: number }) {
  const base = color.slice(0, 7);
  const at = (strength: number) =>
    `${base}${Math.round(Math.min(1, Math.max(0, strength)) * 255)
      .toString(16)
      .padStart(2, '0')}`;
  // A middle stop a little past halfway keeps the fade gentle where it starts.
  return <LinearGradient pointerEvents="none" colors={[at(from), at(from + (to - from) * 0.45), at(to)]} locations={[0, 0.55, 1]} style={{ height }} />;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginTop: Spacing.two },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  section: { gap: Spacing.two + 4 },
});
