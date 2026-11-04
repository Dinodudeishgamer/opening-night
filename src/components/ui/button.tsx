import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, PressableProps, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Font, Radius, Shadow, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'destructiveOutline';
type ButtonSize = 'md' | 'sm';

type ButtonProps = Omit<PressableProps, 'style'> & {
  title: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Optional leading Ionicons glyph. */
  icon?: keyof typeof Ionicons.glyphMap;
  style?: PressableProps['style'];
};

export function Button({
  title,
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();

  const filled = variant === 'primary' || variant === 'destructive';
  const backgroundColor =
    variant === 'primary' ? theme.accent : variant === 'destructive' ? theme.danger : 'transparent';
  const borderColor =
    variant === 'secondary' ? theme.border : variant === 'destructiveOutline' ? `${theme.danger}80` : 'transparent';
  const textColor =
    variant === 'primary'
      ? theme.onAccent
      : variant === 'destructive'
        ? '#FFFFFF'
        : variant === 'destructiveOutline'
          ? theme.danger
          : theme.text;
  const isDisabled = disabled || loading;

  return (
    <Pressable
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      style={({ pressed }) =>
        [
          styles.base,
          size === 'sm' && styles.sizeSm,
          {
            backgroundColor,
            borderColor,
            borderWidth: filled ? 0 : 1,
            opacity: isDisabled ? 0.45 : 1,
            transform: [{ scale: pressed && !isDisabled ? 0.97 : 1 }],
          },
          // Pressed feedback: dim fills, tint the transparent variants.
          pressed && !isDisabled && !filled && { backgroundColor: theme.backgroundSelected },
          pressed && !isDisabled && filled && { opacity: 0.9 },
          filled && Shadow.sm,
          style,
        ] as StyleProp<ViewStyle>
      }
      {...rest}>
      {loading ? (
        <View style={styles.contentRow}>
          <ActivityIndicator color={textColor} />
          <ThemedText style={[styles.text, { color: textColor }]}>{title}</ThemedText>
        </View>
      ) : (
        <View style={styles.contentRow}>
          {icon && <Ionicons name={icon} size={size === 'sm' ? 16 : 20} color={textColor} />}
          <ThemedText style={[styles.text, size === 'sm' && styles.textSm, { color: textColor }]}>
            {title}
          </ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 50,
    borderRadius: Radius.md,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeSm: {
    minHeight: 44,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  contentRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  text: { fontFamily: Font.bold, fontSize: 16, letterSpacing: 0.2 },
  textSm: { fontSize: 14 },
});
