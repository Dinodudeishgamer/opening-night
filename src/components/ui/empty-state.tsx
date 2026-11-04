import { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Font, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type EmptyStateProps = {
  icon?: string;
  title: string;
  subtitle?: string;
  /** Show a spinner instead of the icon (loading state). */
  loading?: boolean;
  /** Optional action, e.g. a retry Button. */
  action?: ReactNode;
};

export function EmptyState({ icon = '🎬', title, subtitle, loading, action }: EmptyStateProps) {
  const theme = useTheme();
  return (
    <ThemedView style={styles.container}>
      {loading ? (
        <ActivityIndicator size="large" color={theme.accent} style={styles.spinner} />
      ) : (
        <ThemedText style={styles.icon}>{icon}</ThemedText>
      )}
      <ThemedText style={styles.title}>
        {title}
      </ThemedText>
      {subtitle && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.subtitle}>
          {subtitle}
        </ThemedText>
      )}
      {action && <ThemedView style={styles.action}>{action}</ThemedView>}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.two,
  },
  spinner: { marginBottom: Spacing.one },
  icon: { fontSize: 44, lineHeight: 56, textAlign: 'center' },
  title: { textAlign: 'center', fontFamily: Font.serifBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  subtitle: { textAlign: 'center', maxWidth: 300 },
  action: { marginTop: Spacing.two, alignSelf: 'stretch', maxWidth: 260 },
});
