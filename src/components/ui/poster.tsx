import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { tmdbImage } from '@/lib/format';

type PosterProps = {
  /** TMDB poster_path (e.g. "/abc.jpg"); null/undefined shows the fallback. */
  path?: string | null;
  /** Rendered width in px. Height is derived at the 2:3 movie-poster ratio. */
  width: number;
};

/**
 * Movie-poster thumbnail. Renders TMDB art when available, otherwise a
 * consistent 🎬 fallback. The fallback glyph carries an explicit lineHeight so
 * it never clips at the top on iOS (emoji draw taller than their font box).
 */
export function Poster({ path, width }: PosterProps) {
  const theme = useTheme();
  const height = Math.round(width * 1.5);
  const borderRadius = width <= 64 ? Radius.sm : Radius.md;
  const frame = { width, height, borderRadius, borderColor: theme.border };

  const uri = tmdbImage(path, width > 120 ? 'w500' : 'w342');

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.frame, frame]}
        contentFit="cover"
        transition={220}
      />
    );
  }

  return (
    <ThemedView style={[styles.frame, styles.fallback, frame, { backgroundColor: theme.backgroundSelected }]}>
      <ThemedText style={{ fontSize: Math.round(width * 0.4), lineHeight: Math.round(width * 0.5) }}>
        🎬
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  frame: { borderWidth: StyleSheet.hairlineWidth },
  fallback: { alignItems: 'center', justifyContent: 'center' },
});
