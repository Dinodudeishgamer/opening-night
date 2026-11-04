import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Font, Radius, Spacing, TONE_COLOR, type Tone } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type StatusBadgeProps = {
  label: string;
  /** How it should read. Callers map their own domain onto a tone — see
   *  STAGE_TONE, STATUS_META and PAYMENT_STATUS_META in constants/events. */
  tone?: Tone;
};

/**
 * A small pill stating where something stands. Deliberately takes a tone rather
 * than a raw status string: badges here describe stages, payments, RSVPs and
 * invite codes, and a single lookup table of every status name across four
 * different domains was both a merge hazard and a lie — callers had to pass a
 * *payment* status to colour an RSVP green.
 */
export function StatusBadge({ label, tone = 'muted' }: StatusBadgeProps) {
  const theme = useTheme();
  const color = theme[TONE_COLOR[tone]];

  return (
    <View style={[styles.badge, { backgroundColor: `${color}22`, borderColor: `${color}80` }]}>
      <ThemedText style={[styles.label, { color }]}>{label}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingVertical: 3,
    paddingHorizontal: Spacing.two + 2,
  },
  label: {
    fontFamily: Font.bold,
    fontSize: 12,
    letterSpacing: 0.3,
  },
});
