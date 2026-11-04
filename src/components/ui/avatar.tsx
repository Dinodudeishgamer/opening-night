import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Font } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** True when the stored avatar value is an image (data URI or URL) rather than an emoji. */
function isImageAvatar(value: string | null | undefined): value is string {
  return !!value && (value.startsWith('data:') || value.startsWith('http'));
}

type AvatarProps = {
  name: string;
  /** A chosen emoji or an image data URI; null/undefined falls back to the initial letter. */
  avatar?: string | null;
  size?: number;
  /** Dimmer fill for people with no account of their own — e.g. logged guests. */
  muted?: boolean;
  /** Accent-tinted border and serif initial, for the one big avatar on Profile. */
  prominent?: boolean;
};

/** A person's avatar: their photo, their chosen emoji, or their initial. */
export function Avatar({ name, avatar, size = 42, muted = false, prominent = false }: AvatarProps) {
  const theme = useTheme();
  const initial = (name || '?').charAt(0).toUpperCase();

  return (
    <ThemedView
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: muted ? theme.background : theme.backgroundSelected,
          borderColor: prominent ? `${theme.accent}55` : theme.border,
          borderWidth: prominent ? 1 : StyleSheet.hairlineWidth,
        },
      ]}>
      {isImageAvatar(avatar) ? (
        <Image
          source={{ uri: avatar }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          contentFit="cover"
          transition={120}
          accessibilityLabel={`${name}'s photo`}
        />
      ) : avatar ? (
        // Emoji glyphs fill their em box edge to edge, so the line box has to be
        // comfortably taller than the font size or the top and bottom shear off.
        <ThemedText style={[styles.emoji, { fontSize: size * 0.5, lineHeight: size * 0.68 }]}>
          {avatar}
        </ThemedText>
      ) : (
        <ThemedText
          style={[
            prominent ? styles.initialSerif : styles.initial,
            {
              fontSize: size * (prominent ? 0.4 : 0.34),
              lineHeight: size * (prominent ? 0.57 : 0.4),
              color: muted ? theme.textSecondary : theme.accent,
            },
          ]}>
          {initial}
        </ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  emoji: { textAlign: 'center', includeFontPadding: false },
  initial: { fontFamily: Font.bold, textAlign: 'center' },
  // Fraunces sits tall in its em box, so an implicit line height clips the cap.
  // An explicit one (plus dropping Android's extra font padding) centres it.
  initialSerif: { fontFamily: Font.serifBold, textAlign: 'center', includeFontPadding: false },
});
