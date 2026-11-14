// Letterboxd, as people recognise it: its three overlapping dots (orange,
// green, blue), drawn here rather than shipped as an image so it stays sharp
// at any size. Used only to link to a member's Letterboxd profile, which is
// what the mark is for.
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { haptic } from '@/lib/haptics';
import { letterboxdLink } from '@/lib/links';

const DOTS = ['#FF8000', '#00E054', '#40BCF4'];

/** The three dots, `size` tall. */
export function LetterboxdMark({ size = 14 }: { size?: number }) {
  const overlap = size * 0.28;
  return (
    <View style={[styles.mark, { height: size }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {DOTS.map((color, index) => (
        <View
          key={color}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            marginLeft: index === 0 ? 0 : -overlap,
            opacity: 0.95,
          }}
        />
      ))}
    </View>
  );
}

/** "[dots] Letterboxd · name", opening their profile. */
export function LetterboxdButton({ username }: { username: string }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        void Linking.openURL(letterboxdLink(username)).catch(() => {});
      }}
      accessibilityRole="link"
      accessibilityLabel={`Letterboxd profile: ${username}`}
      style={({ pressed }) => [styles.button, { borderColor: theme.border, backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement }]}>
      <LetterboxdMark size={14} />
      <ThemedText style={styles.brand}>Letterboxd</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.name}>
        {username}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mark: { flexDirection: 'row', alignItems: 'center' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    maxWidth: '100%',
  },
  brand: { fontFamily: Font.bold, fontSize: 14, lineHeight: 19 },
  name: { flexShrink: 1, fontFamily: Font.medium },
});
