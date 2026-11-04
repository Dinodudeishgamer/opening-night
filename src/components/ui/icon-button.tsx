import { Ionicons } from '@expo/vector-icons';
import { Pressable, PressableProps, StyleSheet } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type IconButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  icon: keyof typeof Ionicons.glyphMap;
  /** Required: an icon alone tells a screen reader nothing. */
  label: string;
  size?: number;
  /** Gold fill for the one action a screen is actually built around. */
  variant?: 'plain' | 'accent';
};

/**
 * Circular icon-only action. Used for the affordances that sit beside a
 * heading — back, sign out, create — where a full-width Button would shout
 * louder than the content it sits next to.
 */
export function IconButton({ icon, label, size = 40, variant = 'plain', ...rest }: IconButtonProps) {
  const theme = useTheme();
  const accent = variant === 'accent';

  return (
    <Pressable
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: accent ? 'transparent' : theme.border,
          backgroundColor: accent
            ? theme.accent
            : pressed
              ? theme.backgroundSelected
              : theme.backgroundElement,
          opacity: accent && pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
      ]}
      {...rest}>
      <Ionicons
        name={icon}
        size={Math.round(size * 0.5)}
        color={accent ? theme.onAccent : theme.text}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: 'continuous',
    borderRadius: Radius.full,
  },
});
