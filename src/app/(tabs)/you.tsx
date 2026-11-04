// You: a profile page. Your picture and name at the top (tap the picture to
// change it), what your movie nights add up to, the posters of what you have
// rated, and then the few settings there are. Your name is not here to edit:
// Dino sets names.
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { useCallback, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AvatarPicker } from '@/components/avatar-picker';
import { eventTitle } from '@/components/event-card';
import { MemberAvatar } from '@/components/member-avatar';
import { StatsGuide } from '@/components/stats-guide';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Choices, Sheet } from '@/components/ui/kit';
import { Poster } from '@/components/ui/poster';
import { RefreshScreen } from '@/components/ui/refresh-screen';
import { Section } from '@/components/ui/section';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { actions, listEvents, messageOf, myScores } from '@/lib/api';
import { confirmAction, showAlert } from '@/lib/dialogs';
import { MAX_SCORE, memberName, score } from '@/lib/format';
import { removeMyAvatarFiles } from '@/lib/images';
import { type PushState, pushState, registerThisDevice } from '@/lib/push';
import { useSession } from '@/lib/session';
import { THEME_OPTIONS, type ThemePreference, useThemePreference } from '@/lib/theme-preference';
import type { EventRow } from '@/lib/types';

interface Rated {
  event: EventRow;
  rating: number;
}

interface Totals {
  nights: number;
  averageRating: number | null;
  /** How close this member's guesses land to their own ratings, 0-100. */
  accuracy: number | null;
  rated: Rated[];
}

const EMPTY: Totals = { nights: 0, averageRating: null, accuracy: null, rated: [] };

export default function YouScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me, memberById, refresh, signOut } = useSession();
  const { preference, setPreference } = useThemePreference();
  const [totals, setTotals] = useState<Totals>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [push, setPush] = useState<PushState>('unsupported');
  const [asking, setAsking] = useState(false);

  const memberId = me?.member_id;
  const load = useCallback(async () => {
    if (!memberId) return;
    try {
      const [scores, events] = await Promise.all([myScores(memberId), listEvents()]);
      const byId = new Map(events.map((event) => [event.id, event]));
      const guesses = new Map(scores.predictions.map((row) => [row.event_id, row.score]));
      const rated = scores.ratings
        .filter((row) => byId.has(row.event_id))
        .map((row) => ({ event: byId.get(row.event_id)!, rating: row.score }))
        .sort((a, b) => (b.event.ended_at ?? '').localeCompare(a.event.ended_at ?? ''));
      const misses = scores.ratings.filter((row) => guesses.has(row.event_id)).map((row) => Math.abs(row.score - guesses.get(row.event_id)!));
      setTotals({
        nights: scores.nights,
        averageRating: scores.ratings.length ? scores.ratings.reduce((sum, row) => sum + row.score, 0) / scores.ratings.length : null,
        accuracy: misses.length ? Math.round((1 - misses.reduce((sum, miss) => sum + miss, 0) / misses.length / MAX_SCORE) * 100) : null,
        rated,
      });
    } catch {
      // The profile still shows without its numbers.
    }
  }, [memberId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // Read again on every visit: the switch may have been flipped in Settings.
      void pushState().then(setPush);
    }, [load]),
  );

  async function deleteAccount() {
    if (!me) return;
    try {
      await removeMyAvatarFiles(me.member_id);
      await actions.deleteMyAccount();
    } catch (error) {
      showAlert('Could not delete your account', messageOf(error));
      return;
    }
    // The login is gone on the server; this clears it from the phone and goes back to the start.
    await signOut().catch(() => {});
  }

  async function turnOnNotifications() {
    // iOS asks once. After a no, the only switch left is the one in Settings.
    if (push === 'denied') return void Linking.openSettings();
    setAsking(true);
    await registerThisDevice({ ask: true });
    setPush(await pushState());
    setAsking(false);
  }

  const member = memberById(me?.member_id);
  if (!me) return null;

  const reload = async () => {
    await Promise.all([refresh(), load()]);
  };

  return (
    <RefreshScreen onRefresh={reload}>
      <View style={styles.header}>
        <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel="Change your picture" style={({ pressed }) => pressed && styles.pressed}>
          <View style={[styles.ring, { borderColor: theme.accent }]}>
            <MemberAvatar member={member} size={108} prominent />
          </View>
          <View style={[styles.editBadge, { backgroundColor: theme.accent, borderColor: theme.background }]}>
            <Ionicons name="pencil" size={14} color={theme.onAccent} />
          </View>
        </Pressable>
        <ThemedText type="heading" style={styles.name}>
          {memberName(me)}
        </ThemedText>
        <ThemedText type="eyebrow" style={{ color: theme.accent }}>
          {me.role === 'owner' ? 'Organizer' : 'Member'}
        </ThemedText>
      </View>

      <View style={[styles.totals, { borderColor: theme.border }]}>
        <Total value={String(totals.nights)} label={totals.nights === 1 ? 'Night' : 'Nights'} />
        <View style={[styles.totalRule, { backgroundColor: theme.border }]} />
        <Total value={totals.averageRating !== null ? score(totals.averageRating) : '–'} label="Avg rating" />
        <View style={[styles.totalRule, { backgroundColor: theme.border }]} />
        <Total value={totals.accuracy !== null ? `${totals.accuracy}%` : '–'} label="Accuracy" />
      </View>
      <StatsGuide about="yours" />

      <Section title="Your ratings" count={totals.rated.length}>
        {totals.rated.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary">
            Every movie you rate lands here, most recent first.
          </ThemedText>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.shelfBleed} contentContainerStyle={styles.shelf}>
            {totals.rated.map(({ event, rating }) => (
              <Pressable
                key={event.id}
                onPress={() => router.push(`/event/${event.id}` as Href)}
                accessibilityRole="button"
                accessibilityLabel={`${eventTitle(event)}, you rated it ${score(rating)}`}
                style={({ pressed }) => [styles.shelfItem, pressed && styles.pressed]}>
                <Poster path={event.poster_path ?? event.movie.poster_path} width={92} />
                <View style={[styles.scoreChip, { backgroundColor: theme.accent }]}>
                  <ThemedText style={[styles.scoreChipText, { color: theme.onAccent }]}>{score(rating)}</ThemedText>
                </View>
                <ThemedText type="small" numberOfLines={2} style={styles.shelfTitle}>
                  {eventTitle(event)}
                </ThemedText>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </Section>

      {(push === 'ask' || push === 'denied') && (
        <Section title="Notifications">
          <ThemedText type="small" themeColor="textSecondary">
            Off on this phone, so a new movie night or a deadline will not reach you unless you open the app.
          </ThemedText>
          <Button
            title={push === 'denied' ? 'Turn on in Settings' : 'Turn on notifications'}
            size="sm"
            icon="notifications-outline"
            loading={asking}
            onPress={() => void turnOnNotifications()}
          />
        </Section>
      )}

      <Section title="Appearance">
        <Choices<ThemePreference> options={THEME_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} value={preference} onChange={setPreference} />
      </Section>

      <Section title="This phone">
        <ThemedText type="small" themeColor="textSecondary">
          {me.role === 'owner'
            ? 'You stay signed in on this phone. Moving to a new one? Make yourself an invite code in Manage first, then enter it on the new phone.'
            : 'You stay signed in on this phone. For a new phone, ask Dino for a new invite code. Dino also sets names: ask him to fix yours.'}
        </ThemedText>
        <Button title="Watch the welcome tour" size="sm" variant="secondary" icon="play-circle-outline" onPress={() => router.push('/intro?replay=1' as Href)} />
        <Button
          title="Sign out"
          size="sm"
          variant="destructiveOutline"
          onPress={() =>
            confirmAction({
              title: 'Sign out?',
              message:
                me.role === 'owner'
                  ? 'You are the organizer, and only you can make invite codes. Without a code you already made for yourself in Manage, getting back in means the recovery steps in the Supabase dashboard.'
                  : 'There is no signing back in. You will need a new invite code from Dino.',
              confirmLabel: 'Sign out',
              destructive: true,
              onConfirm: () => void signOut(),
            })
          }
        />
        {me.role !== 'owner' && (
          <Button
            title="Delete my account"
            size="sm"
            variant="destructiveOutline"
            icon="trash-outline"
            onPress={() =>
              confirmAction({
                title: 'Delete your account?',
                message:
                  'This deletes your login, your picture, your notifications, and your name. Your guesses and ratings stay on the movie nights you went to, under "Former member", so the group scores still add up. It cannot be undone; to come back you would need a new invite from Dino.',
                confirmLabel: 'Delete',
                destructive: true,
                onConfirm: () => void deleteAccount(),
              })
            }
          />
        )}
      </Section>

      <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
        Opening Night {Constants.expoConfig?.version ?? ''}
        {Updates.updateId ? ` · ${Updates.updateId.slice(0, 8)}` : ''}
      </ThemedText>
      {/* TMDB's terms ask every app built on its API to say so. */}
      <ThemedText type="small" themeColor="textSecondary" style={styles.credit}>
        Movie details, posters and trailers from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
      </ThemedText>

      <Sheet visible={editing} title="Your picture" onClose={() => setEditing(false)}>
        <AvatarPicker onPicked={() => setEditing(false)} />
      </Sheet>
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

  header: { alignItems: 'center', gap: Spacing.one, paddingTop: Spacing.three },
  ring: { padding: 4, borderRadius: 62, borderWidth: 2 },
  editBadge: { position: 'absolute', right: 2, bottom: 2, width: 30, height: 30, borderRadius: 15, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  name: { marginTop: Spacing.two, textAlign: 'center' },

  totals: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: Spacing.three },
  total: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: Spacing.one },
  totalValue: { fontFamily: Font.serifBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  totalLabel: { fontSize: 10, letterSpacing: 1.2 },
  totalRule: { width: StyleSheet.hairlineWidth },

  // The shelf scrolls out past the page's side padding.
  shelfBleed: { marginHorizontal: -Spacing.four },
  shelf: { gap: Spacing.two + 4, paddingHorizontal: Spacing.four },
  shelfItem: { width: 92 },
  shelfTitle: { marginTop: Spacing.one, fontFamily: Font.semibold },
  scoreChip: { position: 'absolute', top: 6, right: 6, minWidth: 34, paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full, alignItems: 'center' },
  scoreChipText: { fontFamily: Font.extrabold, fontSize: 13, lineHeight: 18 },

  version: { textAlign: 'center', marginTop: Spacing.two },
  credit: { textAlign: 'center', fontSize: 11, lineHeight: 16, opacity: 0.8 },
});
