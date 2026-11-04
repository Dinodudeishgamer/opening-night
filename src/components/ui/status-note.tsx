import { ThemedText } from '@/components/themed-text';
import { TONE_COLOR, type Note } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * One line of feedback after an action — "Saved ✓", "Couldn't upload", "Split —
 * everyone confirmed sees their share."
 *
 * Takes the tone alongside the text because the alternative, which this
 * replaced in four places, was sniffing the message for a prefix ("Error:",
 * "Couldn't", an em dash) to guess whether it had gone well. Every one of those
 * broke the moment somebody reworded the copy.
 */
export function StatusNote({ note }: { note: Note | null }) {
  const theme = useTheme();

  if (!note) return null;

  return (
    <ThemedText type="small" style={{ color: theme[TONE_COLOR[note.tone]] }}>
      {note.text}
    </ThemedText>
  );
}
