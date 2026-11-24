// Coming Soon: what needs you, then every movie night that has not happened
// yet. A night leaves this screen the moment Dino ends it and goes to Past;
// if it still needs a rating, that stays up here under "Needs you".
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeaturedCard, type Need, NeedsYou, PlanningRow, ScheduledRow } from '@/components/home-sections';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionHeader } from '@/components/ui/section';
import { Font, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getPendingActions, listEvents, listParticipants, listSelectedShowtimes, listShowtimeOptions } from '@/lib/api';
import { happensAt, soonestFirst } from '@/lib/order';
import { useSession } from '@/lib/session';
import type { EventRow, Participant, PendingAction, Showtime } from '@/lib/types';
import { refreshUnread } from '@/lib/unread';

// A member and their guests each have their own action; on this list they
// read as one line per event and kind.
function group(actions: PendingAction[]): Need[] {
  const needs = new Map<string, Need>();
  for (const action of actions) {
    const key = `${action.event_id}:${action.kind}`;
    const existing = needs.get(key);
    if (existing) existing.count += 1;
    else needs.set(key, { key, eventId: action.event_id, kind: action.kind, count: 1, dueAt: action.due_at });
  }
  return [...needs.values()];
}

export default function ComingSoonScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me, isOwner } = useSession();
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [showtimes, setShowtimes] = useState<Record<string, Showtime>>({});
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [needs, setNeeds] = useState<Need[]>([]);
  const [crowds, setCrowds] = useState<Record<string, Participant[]>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [all, pending] = await Promise.all([listEvents(), getPendingActions()]);
      const open = all.filter((event) => !event.ended_at);
      const [picked, offered] = await Promise.all([
        listSelectedShowtimes(all),
        listShowtimeOptions(open.filter((event) => !event.selected_showtime_id).map((event) => event.id)),
      ]);
      setShowtimes(picked);
      setOptions(offered);
      setEvents(all);
      setNeeds(group(pending));
      setFailed(false);
      // Who is in, for the marquee. Decoration: the page stands without it.
      listParticipants(all.filter((event) => !event.ended_at).map((event) => event.id))
        .then(setCrowds)
        .catch(() => {});
      void refreshUnread();
    } catch {
      setFailed(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const byId = new Map((events ?? []).map((event) => [event.id, event]));
  const upcoming = (events ?? []).filter((event) => !event.ended_at);
  // Soonest first everywhere: a night with a picked showtime by that showtime, one still being
  // planned by its first showtime option (Doomsday in December comes after Rocky this weekend,
  // whatever their RSVP deadlines say).
  const when = (event: EventRow) => happensAt(showtimes[event.id]?.starts_at, options[event.id] ?? []);
  const scheduled = soonestFirst(upcoming.filter((event) => showtimes[event.id]), when);
  const planning = soonestFirst(upcoming.filter((event) => !showtimes[event.id]), when);
  // The marquee goes to whichever night comes first, picked showtime or not.
  const featured = soonestFirst(upcoming, when)[0];
  const laterScheduled = scheduled.filter((event) => event !== featured);
  const laterPlanning = planning.filter((event) => event !== featured);

  return (
    <ThemedView type="background" style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={['top', 'left', 'right']}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}>
          <View style={styles.header}>
            <View style={styles.fill}>
              <ThemedText type="eyebrow" themeColor="textSecondary">
                {me ? `Hi, ${me.first_name}` : ' '}
              </ThemedText>
              <ThemedText style={styles.wordmark}>Coming Soon</ThemedText>
            </View>
            {isOwner && <Button title="New" icon="add" size="sm" onPress={() => router.push('/new-event' as Href)} />}
            {/* Dino's Cinemark Platinum Rewards QR: 25% off concessions, one tap from home. */}
            <Pressable
              onPress={() => router.push('/rewards' as Href)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Dino's Cinemark Platinum Rewards QR"
              style={({ pressed }) => [styles.rewards, { backgroundColor: theme.accent }, pressed && styles.rewardsPressed]}>
              <MaterialCommunityIcons name="popcorn" size={24} color={theme.onAccent} />
            </Pressable>
          </View>

          <NeedsYou needs={needs} events={byId} />

          {events === null ? (
            <EmptyState
              loading={!failed}
              icon="📡"
              title={failed ? 'Could not load' : 'Loading'}
              subtitle={failed ? 'Check your connection and pull down to try again.' : undefined}
            />
          ) : !featured ? (
            <EmptyState
              title="Nothing on the marquee"
              subtitle={isOwner ? 'Start the next movie night.' : 'Dino will post the next movie night here.'}
              action={isOwner ? <Button title="New movie night" onPress={() => router.push('/new-event' as Href)} /> : undefined}
            />
          ) : (
            <>
              <FeaturedCard event={featured} showtime={showtimes[featured.id]} people={crowds[featured.id]} />

              {laterScheduled.length > 0 && (
                <>
                  <SectionHeader title="On the calendar" count={laterScheduled.length} />
                  {laterScheduled.map((event) => (
                    <ScheduledRow key={event.id} event={event} showtime={showtimes[event.id]} />
                  ))}
                </>
              )}

              {laterPlanning.length > 0 && (
                <>
                  <SectionHeader title="In the works" count={laterPlanning.length} />
                  {laterPlanning.map((event) => (
                    <PlanningRow key={event.id} event={event} />
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flexGrow: 1, gap: Spacing.three, paddingHorizontal: Spacing.four, paddingTop: Spacing.three, paddingBottom: Spacing.five },
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.three },
  rewards: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  rewardsPressed: { opacity: 0.85, transform: [{ scale: 0.94 }] },
  wordmark: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
});
