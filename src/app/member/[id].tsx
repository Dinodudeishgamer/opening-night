// One member's page, opened from the Club list: their picture (tap it to see
// it big), their Letterboxd if they linked it, what their nights add up to,
// and the posters of everything they rated.
import { Ionicons } from '@expo/vector-icons';
import { type Href, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { eventTitle } from '@/components/event-card';
import { MemberFace } from '@/components/event/face';
import { LetterboxdButton } from '@/components/letterboxd';
import { StatsGuide } from '@/components/stats-guide';
import { ThemedText } from '@/components/themed-text';
import { BackHeader } from '@/components/ui/back-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Poster } from '@/components/ui/poster';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { Section } from '@/components/ui/section';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { loadClub } from '@/lib/api';
import { memberName, score } from '@/lib/format';
import { useSession } from '@/lib/session';
import { memberTotals, type MemberTotals } from '@/lib/stats';
import type { EventRow } from '@/lib/types';

export default function MemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const { memberById, me } = useSession();
  const member = memberById(id);
  const [totals, setTotals] = useState<MemberTotals | null>(null);
  const [events, setEvents] = useState<Map<string, EventRow>>(new Map());

  const load = useCallback(async () => {
    try {
      const club = await loadClub();
      setEvents(new Map(club.events.map((event) => [event.id, event])));
      setTotals(memberTotals(club.participants, club.predictions, club.ratings)[id] ?? { nights: 0, averageRating: null, accuracy: null, rated: [] });
    } catch {
      // The profile still shows without its numbers.
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!member) {
    return (
      <RefreshScreen onRefresh={load} edges={['top', 'bottom', 'left', 'right']}>
        <BackHeader />
        <EmptyState icon="🎞️" title="Not in the club" subtitle="This member has left." />
      </RefreshScreen>
    );
  }

  const rated = (totals?.rated ?? [])
    .filter((entry) => events.has(entry.eventId))
    .map((entry) => ({ event: events.get(entry.eventId)!, rating: entry.rating }))
    .sort((a, b) => (b.event.ended_at ?? '').localeCompare(a.event.ended_at ?? ''));

  return (
    <RefreshScreen onRefresh={load} edges={['top', 'bottom', 'left', 'right']}>
      <BackHeader />
      <View style={styles.header}>
        <View style={[styles.ring, { borderColor: theme.accent }]}>
          <MemberFace member={member} size={108} />
        </View>
        <ThemedText type="heading" style={styles.center}>
          {memberName(member)}
          {member.id === me?.member_id ? ' (you)' : ''}
        </ThemedText>
        <ThemedText type="eyebrow" style={{ color: theme.accent }}>
          {member.role === 'owner' ? 'Organizer' : 'Member'}
        </ThemedText>
        {member.letterboxd ? <LetterboxdButton username={member.letterboxd} /> : null}
      </View>

      <View style={[styles.totals, { borderColor: theme.border }]}>
        <Total value={totals ? String(totals.nights) : '–'} label={totals?.nights === 1 ? 'Night' : 'Nights'} />
        <View style={[styles.rule, { backgroundColor: theme.border }]} />
        <Total value={totals?.averageRating != null ? score(totals.averageRating) : '–'} label="Avg rating" />
        <View style={[styles.rule, { backgroundColor: theme.border }]} />
        <Total value={totals?.accuracy != null ? `${totals.accuracy}%` : '–'} label="Accuracy" />
      </View>
      <StatsGuide about="yours" />

      <Section title={member.id === me?.member_id ? 'Your ratings' : 'Their ratings'} count={rated.length}>
        {rated.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary">
            Nothing rated yet.
          </ThemedText>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.shelfBleed} contentContainerStyle={styles.shelf}>
            {rated.map(({ event, rating }) => (
              <Pressable
                key={event.id}
                onPress={() => router.push(`/event/${event.id}` as Href)}
                accessibilityRole="button"
                accessibilityLabel={`${eventTitle(event)}, rated ${score(rating)}`}
                style={({ pressed }) => [styles.shelfItem, pressed && styles.pressed]}>
                <Poster path={event.poster_path ?? event.movie.poster_path} width={92} />
                <View style={[styles.chip, { backgroundColor: theme.accent }]}>
                  <ThemedText style={[styles.chipText, { color: theme.onAccent }]}>{score(rating)}</ThemedText>
                </View>
                <ThemedText type="small" numberOfLines={2} style={styles.shelfTitle}>
                  {eventTitle(event)}
                </ThemedText>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </Section>
      {!member.letterboxd && member.id === me?.member_id ? (
        <View style={styles.hint}>
          <Ionicons name="link-outline" size={15} color={theme.textSecondary} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.flex}>
            Link your Letterboxd from the You tab and it shows here.
          </ThemedText>
        </View>
      ) : null}
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
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  pressed: { opacity: 0.75 },
  header: { alignItems: 'center', gap: Spacing.one },
  ring: { padding: 4, borderRadius: 62, borderWidth: 2, marginBottom: Spacing.two },
  totals: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.three },
  total: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: Spacing.one },
  totalValue: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  totalLabel: { fontSize: 10, letterSpacing: 1.2 },
  rule: { width: StyleSheet.hairlineWidth },
  shelfBleed: { marginHorizontal: -Spacing.four },
  shelf: { gap: Spacing.two + 4, paddingHorizontal: Spacing.four },
  shelfItem: { width: 92 },
  shelfTitle: { marginTop: Spacing.one, fontFamily: Font.semibold },
  chip: { position: 'absolute', top: 6, right: 6, minWidth: 34, paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full, alignItems: 'center' },
  chipText: { fontFamily: Font.extrabold, fontSize: 13, lineHeight: 18 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
