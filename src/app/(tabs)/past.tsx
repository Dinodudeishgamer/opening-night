// Past: every movie night Dino has ended, newest first. Two ways to look at
// it, switched at the top and remembered on this phone: a wall of posters, or
// a compact list that fits a season on one screen.
//
// A night lands here the moment it ends. For the 48 hours after that it can
// still be rated, and it says so; once the group's ratings are visible it
// carries the group score instead.
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { eventTitle } from '@/components/event-card';
import { StatsGuide } from '@/components/stats-guide';
import { ThemedText } from '@/components/themed-text';
import { EmptyState } from '@/components/ui/empty-state';
import { Poster } from '@/components/ui/poster';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { listEvents, listParticipants, listSelectedShowtimes, listVisibleRatings } from '@/lib/api';
import { DATE_LOCALE, score } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { isPast } from '@/lib/stage';
import type { EventRow, Showtime } from '@/lib/types';

const COLUMNS = 3;
const GAP = Spacing.two + 4;

type Layout = 'wall' | 'list';
const LAYOUT_KEY = 'opening-night.past-layout';

export default function PastScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [showtimes, setShowtimes] = useState<Record<string, Showtime>>({});
  const [averages, setAverages] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState(false);
  const [crowds, setCrowds] = useState<Record<string, number>>({});
  const [layout, setLayout] = useState<Layout>('wall');

  useEffect(() => {
    AsyncStorage.getItem(LAYOUT_KEY)
      .then((saved) => {
        if (saved === 'list' || saved === 'wall') setLayout(saved);
      })
      .catch(() => {});
  }, []);

  function choose(next: Layout) {
    if (next === layout) return;
    haptic.tap();
    setLayout(next);
    AsyncStorage.setItem(LAYOUT_KEY, next).catch(() => {});
  }

  const load = useCallback(async () => {
    try {
      const ended = (await listEvents()).filter((event) => event.ended_at);
      const [selected, ratings] = await Promise.all([listSelectedShowtimes(ended), listVisibleRatings()]);
      // How many went, for the list. The page stands without it.
      listParticipants(ended.map((event) => event.id))
        .then((byEvent) => setCrowds(Object.fromEntries(Object.entries(byEvent).map(([id, people]) => [id, people.filter((person) => person.checked_in_at).length]))))
        .catch(() => {});
      const totals: Record<string, { sum: number; count: number }> = {};
      for (const rating of ratings) {
        const total = (totals[rating.event_id] ??= { sum: 0, count: 0 });
        total.sum += rating.score;
        total.count += 1;
      }
      setAverages(Object.fromEntries(Object.entries(totals).map(([id, total]) => [id, total.sum / total.count])));
      // Most recent night first.
      ended.sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? ''));
      setShowtimes(selected);
      setEvents(ended);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const rated = Object.values(averages);

  // The page's side padding comes from RefreshScreen.
  const tile = Math.floor((Math.min(width, 720) - Spacing.four * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

  return (
    <RefreshScreen onRefresh={load}>
      <View style={styles.header}>
        <ThemedText type="heading" style={styles.fill}>
          Past Movies
        </ThemedText>
        {events && events.length > 0 && (
          <View style={[styles.switch, { borderColor: theme.border }]} accessibilityRole="tablist">
            {(['wall', 'list'] as const).map((option) => {
              const on = layout === option;
              return (
                <Pressable
                  key={option}
                  onPress={() => choose(option)}
                  hitSlop={6}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={option === 'wall' ? 'Poster wall' : 'Compact list'}
                  style={[styles.switchOption, on && { backgroundColor: theme.accent }]}>
                  <Ionicons name={option === 'wall' ? 'grid' : 'list'} size={18} color={on ? theme.onAccent : theme.textSecondary} />
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
      {events && events.length > 0 && (
        <View style={[styles.totals, { borderColor: theme.border }]}>
          <Total value={String(events.length)} label={events.length === 1 ? 'Film' : 'Films'} />
          <View style={[styles.totalRule, { backgroundColor: theme.border }]} />
          <Total value={rated.length ? score(rated.reduce((sum, value) => sum + value, 0) / rated.length) : '–'} label="Avg rating" />
          <View style={[styles.totalRule, { backgroundColor: theme.border }]} />
          <Total value={rated.length ? score(Math.max(...rated)) : '–'} label="Best so far" />
        </View>
      )}
      {events && events.length > 0 && <StatsGuide about="past" />}
      {events === null ? (
        <EmptyState
          loading={!failed}
          icon="📡"
          title={failed ? 'Could not load' : 'Loading'}
          subtitle={failed ? 'Check your connection and pull down to try again.' : undefined}
        />
      ) : events.length === 0 ? (
        <EmptyState icon="🎞️" title="No history yet" subtitle="A movie night lands here as soon as it ends." />
      ) : layout === 'list' ? (
        <View>
          {events.map((event, index) => {
            const rating = averages[event.id];
            const when = showtimes[event.id]?.starts_at ?? event.ended_at!;
            const went = crowds[event.id];
            return (
              <Pressable
                key={event.id}
                onPress={() => router.push(`/event/${event.id}` as Href)}
                accessibilityRole="button"
                accessibilityLabel={`${eventTitle(event)}${rating !== undefined ? `, group rating ${score(rating)}` : ''}`}
                style={({ pressed }) => [styles.line, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border }, pressed && styles.pressed]}>
                <Poster path={event.poster_path ?? event.movie.poster_path} width={44} />
                <View style={styles.lineText}>
                  <ThemedText style={styles.lineTitle} numberOfLines={2}>
                    {eventTitle(event)}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                    {new Date(when).toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })}
                    {went ? ` · ${went} went` : ''}
                  </ThemedText>
                </View>
                {rating !== undefined ? (
                  <ThemedText style={[styles.lineScore, { color: theme.accent }]}>{score(rating)}</ThemedText>
                ) : !isPast(event) ? (
                  <ThemedText type="smallBold" style={{ color: theme.accent }}>
                    Rating open
                  </ThemedText>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.grid}>
          {events.map((event) => {
            const rating = averages[event.id];
            const open = !isPast(event);
            const when = showtimes[event.id]?.starts_at ?? event.ended_at!;
            return (
              <Pressable
                key={event.id}
                onPress={() => router.push(`/event/${event.id}` as Href)}
                accessibilityRole="button"
                accessibilityLabel={`${eventTitle(event)}${rating !== undefined ? `, group rating ${score(rating)}` : ''}`}
                style={({ pressed }) => [{ width: tile }, pressed && styles.pressed]}>
                <View>
                  <Poster path={event.poster_path ?? event.movie.poster_path} width={tile} />
                  {rating !== undefined && (
                    <View style={[styles.score, { backgroundColor: theme.accent }]}>
                      <ThemedText style={[styles.scoreText, { color: theme.onAccent }]}>{score(rating)}</ThemedText>
                    </View>
                  )}
                  {open && (
                    <View style={styles.ribbon}>
                      <ThemedText style={styles.ribbonText}>Rating open</ThemedText>
                    </View>
                  )}
                </View>
                <ThemedText style={styles.title} numberOfLines={2}>
                  {eventTitle(event)}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {new Date(when).toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
      )}
    </RefreshScreen>
  );
}

function Total({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.total}>
      <ThemedText style={styles.totalValue}>{value}</ThemedText>
      <ThemedText type="eyebrow" themeColor="textSecondary" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={styles.totalLabel}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pressed: { opacity: 0.75 },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  switch: { flexDirection: 'row', borderWidth: 1, borderRadius: Radius.full, padding: 3, gap: 2 },
  switchOption: { width: 38, height: 32, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.two + 2 },
  lineText: { flex: 1, gap: 2 },
  lineTitle: { fontFamily: Font.serifBold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  lineScore: { fontFamily: Font.serifBold, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  totals: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.three },
  total: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: Spacing.one },
  totalValue: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  totalLabel: { fontSize: 10, letterSpacing: 1.2 },
  totalRule: { width: StyleSheet.hairlineWidth },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, rowGap: Spacing.three },
  score: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 34,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.full,
    alignItems: 'center',
  },
  scoreText: { fontFamily: Font.extrabold, fontSize: 13, lineHeight: 18 },
  ribbon: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 4,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderBottomLeftRadius: Radius.md,
    borderBottomRightRadius: Radius.md,
  },
  ribbonText: { fontFamily: Font.bold, fontSize: 11, lineHeight: 15, letterSpacing: 0.4, color: '#F2B84B' },
  title: { fontFamily: Font.bold, fontSize: 13, lineHeight: 17, marginTop: Spacing.one + 2 },
});
