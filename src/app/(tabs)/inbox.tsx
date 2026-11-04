// Inbox: what the app has told this member lately, whether or not the push
// arrived. It is a short log, not a to-do list (that is "Needs you" on Coming
// Soon), and it tidies itself:
//
//   New       what has arrived since the last visit
//   Earlier   what was already seen
//
// What is shown at all is decided in lib/inbox.ts: nothing older than 30
// days, and once a movie night is finished, nothing about it except what is
// still live (rating while it is open, a ticket still owed, Dino's own
// messages). Opening the tab marks everything as read, which clears the badge
// on the tab.
import { Ionicons } from '@expo/vector-icons';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Row } from '@/components/ui/kit';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { SectionHeader } from '@/components/ui/section';
import { useTheme } from '@/hooks/use-theme';
import { getPendingActions, listEvents, listInbox, markInboxRead } from '@/lib/api';
import { dayTime } from '@/lib/format';
import { INBOX_DAYS, type InboxNight, inboxShows } from '@/lib/inbox';
import type { InboxItem } from '@/lib/types';
import { clearUnread } from '@/lib/unread';

const ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  event_created: 'film-outline',
  rsvp_reminder: 'hand-left-outline',
  vote_reminder: 'checkbox-outline',
  voting_complete: 'checkbox-outline',
  showtime_selected: 'calendar-outline',
  event_rescheduled: 'calendar-outline',
  confirm_reminder: 'checkmark-circle-outline',
  payment_posted: 'cash-outline',
  payment_reminder: 'cash-outline',
  event_reminder: 'alarm-outline',
  rating_open: 'star-outline',
  rating_reminder: 'star-outline',
  announcement: 'megaphone-outline',
  seat_assigned: 'ticket-outline',
};

export default function InboxScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, events, pending] = await Promise.all([listInbox(), listEvents(), getPendingActions()]);
      const owing = new Set(pending.filter((action) => action.kind === 'pay').map((action) => action.event_id));
      const nights = new Map<string, InboxNight>(events.map((event) => [event.id, { endedAt: event.ended_at, owes: owing.has(event.id) }]));
      setItems(list.filter((item) => inboxShows(item, item.event_id ? nights.get(item.event_id) : undefined)));
      setFailed(false);
      // Shown as new this once; read from the next visit on. Everything unread
      // is marked, including what was tidied away, so the badge never counts
      // something that cannot be seen.
      void markInboxRead(list.filter((item) => !item.read_at).map((item) => item.id))
        .then(clearUnread)
        .catch(() => {});
    } catch {
      setFailed(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const fresh = (items ?? []).filter((item) => !item.read_at);
  const earlier = (items ?? []).filter((item) => item.read_at);

  const rows = (list: InboxItem[], isNew: boolean) => (
    <Card>
      {list.map((item) => (
        <Row
          key={item.id}
          left={
            <View style={[styles.icon, { backgroundColor: isNew ? theme.accent : theme.backgroundSelected }]}>
              <Ionicons name={ICON[item.kind] ?? 'notifications-outline'} size={18} color={isNew ? theme.onAccent : theme.textSecondary} />
            </View>
          }
          title={item.title}
          subtitle={[item.body, dayTime(item.created_at)].filter(Boolean).join('\n')}
          onPress={item.event_id ? () => router.push(`/event/${item.event_id}` as Href) : undefined}
          right={item.event_id ? <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} /> : undefined}
        />
      ))}
    </Card>
  );

  return (
    <RefreshScreen onRefresh={load}>
      <ThemedText type="heading">Inbox</ThemedText>
      {items === null ? (
        <EmptyState
          loading={!failed}
          icon="📡"
          title={failed ? 'Could not load' : 'Loading'}
          subtitle={failed ? 'Check your connection and pull down to try again.' : undefined}
        />
      ) : items.length === 0 ? (
        <EmptyState icon="📭" title="All caught up" subtitle="News and reminders from the last month show up here. Anything you need to do is on Coming Soon." />
      ) : (
        <>
          {fresh.length > 0 && (
            <>
              <SectionHeader title="New" count={fresh.length} />
              {rows(fresh, true)}
            </>
          )}
          {earlier.length > 0 && (
            <>
              <SectionHeader title="Earlier" />
              {rows(earlier, false)}
            </>
          )}
          <ThemedText type="small" themeColor="textSecondary" style={styles.footnote}>
            Anything older than {INBOX_DAYS} days, or about a movie night that has finished, is cleared away.
          </ThemedText>
        </>
      )}
    </RefreshScreen>
  );
}

const styles = StyleSheet.create({
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  footnote: { textAlign: 'center' },
});
