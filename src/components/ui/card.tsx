import { Ionicons } from '@expo/vector-icons';
import { ReactNode } from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Font, Radius, Shadow, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type CardProps = ViewProps & {
  /**
   * It is your turn: this card is asking something of you right now. Drawn
   * tinted gold with a gold edge, the same as "Needs you" on Coming Soon, so
   * the one thing to do on a page is the one thing that stands out.
   */
  elevated?: boolean;
  /** Clip children to the card's rounded corners (for edge-to-edge list rows). */
  clip?: boolean;
};

/** A surface for something you do. Things you only read go in a Section instead. */
export function Card({ style, elevated, clip, children, ...rest }: CardProps) {
  const theme = useTheme();
  const shadow = elevated ? Shadow.md : Shadow.sm;
  const surface = elevated
    ? { backgroundColor: theme.backgroundSelected, borderColor: theme.accent, borderWidth: 1 }
    : { borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth };

  // Shadow lives on an outer carrier so it survives even when the inner surface
  // clips its corners (overflow:hidden would otherwise swallow the shadow).
  if (clip) {
    return (
      <View style={[styles.carrier, shadow, style]}>
        <ThemedView type="backgroundElement" style={[styles.card, styles.clip, surface]} {...rest}>
          {children}
        </ThemedView>
      </View>
    );
  }

  return (
    <ThemedView type="backgroundElement" style={[styles.card, surface, shadow, style]} {...rest}>
      {children}
    </ThemedView>
  );
}

/**
 * The top of a Card. On its own, `title` is a small gold capitalised label.
 * With a `kicker`, the kicker is that label and the title becomes a headline
 * under it: "RSVP" over "Are you in?".
 */
export function CardTitle({
  title,
  kicker,
  icon,
  right,
}: {
  title: string;
  kicker?: string;
  /** Ionicons glyph — the app's single icon language. Not an emoji. */
  icon?: keyof typeof Ionicons.glyphMap;
  right?: ReactNode;
}) {
  const theme = useTheme();

  return (
    <View style={styles.titleRow}>
      <View style={styles.titleText}>
        <View style={styles.label}>
          {icon && <Ionicons name={icon} size={14} color={theme.accent} />}
          <ThemedText type="eyebrow" style={{ color: theme.accent }}>
            {kicker ?? title}
          </ThemedText>
        </View>
        {kicker ? <ThemedText style={styles.headline}>{title}</ThemedText> : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  carrier: { borderRadius: Radius.lg },
  card: {
    padding: Spacing.three,
    borderRadius: Radius.lg,
    gap: Spacing.two + 4,
  },
  clip: { padding: 0, overflow: 'hidden' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleText: { flexShrink: 1, gap: 2 },
  label: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one + 2 },
  headline: { fontFamily: Font.serifBold, fontSize: 22, lineHeight: 27, letterSpacing: -0.3 },
});
