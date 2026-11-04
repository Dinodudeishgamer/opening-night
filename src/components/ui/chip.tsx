import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
};

/** Selectable pill used for single-choice option rows (e.g. event type). */
export function Chip({ label, selected, onPress }: ChipProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: selected ? theme.accent : theme.border,
          backgroundColor: selected ? theme.accent : pressed ? theme.backgroundSelected : 'transparent',
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}>
      <ThemedText
        type="small"
        style={selected ? { color: theme.onAccent, fontFamily: Font.bold } : { fontFamily: Font.semibold }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingVertical: 8,
    paddingHorizontal: Spacing.three,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
