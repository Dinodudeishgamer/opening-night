import { StyleSheet, Text, type TextProps } from 'react-native';

import { Font, MONO_FONT, ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'heading' | 'cardTitle' | 'eyebrow' | 'small' | 'smallBold' | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return (
    <Text
      style={[
        styles.base,
        { color: theme[themeColor ?? 'text'] },
        type === 'default' && styles.default,
        type === 'heading' && styles.heading,
        type === 'cardTitle' && styles.cardTitle,
        type === 'eyebrow' && styles.eyebrow,
        type === 'small' && styles.small,
        type === 'smallBold' && styles.smallBold,
        type === 'code' && styles.code,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  base: { fontFamily: Font.regular },
  small: {
    fontFamily: Font.medium,
    fontSize: 12,
    lineHeight: 18,
  },
  smallBold: {
    fontFamily: Font.bold,
    fontSize: 12,
    lineHeight: 18,
  },
  default: {
    fontFamily: Font.regular,
    fontSize: 14,
    lineHeight: 22,
  },
  heading: {
    fontFamily: Font.serifBold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  cardTitle: {
    fontFamily: Font.bold,
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: -0.1,
  },
  eyebrow: {
    fontFamily: Font.bold,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  code: {
    fontFamily: MONO_FONT,
    fontSize: 12,
    lineHeight: 16,
  },
});
