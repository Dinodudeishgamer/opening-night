// A session with no member behind it: access was paused, reset, removed, or
// moved to another phone, or the app could not reach the server to find out. Nothing in the
// app is readable in this state; the database returns no rows.
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useSession } from '@/lib/session';

export default function NoAccessScreen() {
  const { refresh, signOut } = useSession();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    await refresh();
    setBusy(false);
  }

  return (
    <Screen scroll={false} edges={['top', 'bottom', 'left', 'right']} contentStyle={styles.content}>
      <EmptyState
        icon="🎟️"
        title="You're not on the list right now"
        subtitle="This phone is not linked to an active membership. If that is a surprise, ask Dino. If he gave you a new invite code, tap Enter a code."
      />
      <Button title="Try again" onPress={retry} loading={busy} />
      <Button title="Enter a code" variant="secondary" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.three, paddingBottom: Spacing.four },
});
