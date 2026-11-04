import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconButton } from '@/components/ui/icon-button';
import { Font, Spacing } from '@/constants/theme';
import { backOrHome } from '@/lib/navigation';

type BackHeaderProps = {
  title?: string;
  /** Overrides the default navigation — e.g. to confirm before discarding unsaved input. */
  onBack?: () => void;
};

/**
 * By default, back pops real history — event pages live on the root stack, so
 * this returns to whichever screen opened them (home, Members, Profile), and
 * matches what the iOS swipe-back gesture does. When there's no history (a
 * notification tap straight onto an event), it falls back to the home list.
 */
export function BackHeader({ title, onBack }: BackHeaderProps) {
  const router = useRouter();

  return (
    <ThemedView style={styles.row}>
      <IconButton icon="chevron-back" label="Go back" onPress={onBack ?? (() => backOrHome(router))} />
      {title && (
        <ThemedText numberOfLines={1} style={styles.title}>
          {title}
        </ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  title: { flex: 1, fontFamily: Font.serifBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
});
