// A horizontal strip of TMDB images to choose from: posters or backdrops.
// The chosen one is outlined in gold.
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { tmdbImage } from '@/lib/format';

export function ImageChoices({
  paths, selected, onSelect, width, height, size,
}: {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  width: number;
  height: number;
  size: 'w185' | 'w342';
}) {
  const theme = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.images}>
      {paths.map((path) => {
        const uri = tmdbImage(path, size);
        if (!uri) return null;
        const on = path === selected;
        return (
          <Pressable key={path} onPress={() => onSelect(path)} accessibilityRole="imagebutton" accessibilityState={{ selected: on }}>
            <Image
              source={{ uri }}
              style={{ width, height, borderRadius: Radius.sm, borderWidth: on ? 3 : StyleSheet.hairlineWidth, borderColor: on ? theme.accent : theme.border, opacity: on ? 1 : 0.75 }}
              contentFit="cover"
              transition={150}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  images: { gap: Spacing.two },
});
