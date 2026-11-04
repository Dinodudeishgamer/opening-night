// The pieces the Coming Soon screen is built from. Each kind of thing on that
// screen has its own shape, so the page reads at a glance:
//
//   Needs you        a gold-tinted block: the only part that asks for anything
//   the marquee      one big picture card for the night that is up next
//   On the calendar  nights with a date, led by a calendar tile
//   In the works     nights still being planned, led by the poster and a
//                    four-step track showing how far along they are
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { type Href, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { eventTitle } from '@/components/event-card';
import { MemberAvatar } from '@/components/member-avatar';
import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/ui/card';
import { Poster } from '@/components/ui/poster';
import { Font, Radius, Shadow, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { DATE_LOCALE, dayTime, formatLabel, timeOnly, timeUntil, tmdbImage } from '@/lib/format';
import { STAGE_LABEL, type Stage, stageOf } from '@/lib/stage';
import { useSession } from '@/lib/session';
import type { EventRow, Participant, PendingKind, Showtime } from '@/lib/types';

// Colours used on top of a photograph, where the theme's own text colours
// cannot be trusted to stay readable.
const ON_IMAGE = {
  text: '#FFFFFF',
  soft: 'rgba(255,255,255,0.82)',
  gold: '#F2B84B',
  onGold: '#1A1300',
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "In 11 days", or what to say once the showtime has come. */
function countdown(startsAt: string): string {
  const until = timeUntil(startsAt);
  return until === 'passed' ? 'Showtime' : capitalize(until);
}

/** What matters about a night that has no showtime yet. */
function planningLine(event: EventRow): string {
  return stageOf(event) === 'rsvp' ? `RSVP closes ${timeUntil(event.rsvp_deadline)}` : 'Showtime to be picked';
}

const open = (router: ReturnType<typeof useRouter>, eventId: string) => router.push(`/event/${eventId}` as Href);

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const TRACK: Stage[] = ['rsvp', 'voting', 'confirming', 'ticketed'];

/** Four steps from "are you in?" to "tickets bought", filled up to where this night is. */
function StageTrack({ stage, onImage = false }: { stage: Stage; onImage?: boolean }) {
  const theme = useTheme();
  const at = TRACK.indexOf(stage);
  if (at < 0) return null;
  const done = onImage ? ON_IMAGE.gold : theme.accent;
  const todo = onImage ? 'rgba(255,255,255,0.3)' : theme.border;
  return (
    <View style={styles.track} accessibilityLabel={`Step ${at + 1} of ${TRACK.length}: ${STAGE_LABEL[stage]}`}>
      {TRACK.map((step, index) => (
        <View key={step} style={[styles.trackStep, { backgroundColor: index <= at ? done : todo }]} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------

const NEED: Record<PendingKind, { verb: string; icon: keyof typeof Ionicons.glyphMap }> = {
  rsvp: { verb: 'RSVP', icon: 'hand-left' },
  vote: { verb: 'Vote on showtimes', icon: 'checkbox' },
  confirm: { verb: 'Confirm the showtime', icon: 'checkmark-circle' },
  pay: { verb: 'Pay Dino', icon: 'cash' },
  predict: { verb: 'Predict your rating', icon: 'sparkles' },
  rate: { verb: 'Rate the movie', icon: 'star' },
};

export interface Need {
  key: string;
  eventId: string;
  kind: PendingKind;
  count: number;
  dueAt: string | null;
}

/** The to-do list. The only block on the screen filled with the accent tint. */
export function NeedsYou({ needs, events }: { needs: Need[]; events: Map<string, EventRow> }) {
  const theme = useTheme();
  const router = useRouter();
  const rows = needs.filter((need) => events.has(need.eventId));
  if (rows.length === 0) return null;

  return (
    <View
      style={[
        styles.needs,
        {
          backgroundColor: theme.backgroundSelected,
          borderColor: theme.accent,
        },
      ]}
    >
      <View style={styles.needsHeader}>
        <ThemedText type="eyebrow" style={{ color: theme.accent }}>
          Needs you
        </ThemedText>
        <View style={[styles.count, { backgroundColor: theme.accent }]}>
          <ThemedText style={[styles.countText, { color: theme.onAccent }]}>{rows.length}</ThemedText>
        </View>
      </View>
      {rows.map((need, index) => {
        const event = events.get(need.eventId)!;
        const who = need.count > 1 ? ` (you and ${need.count - 1} guest${need.count > 2 ? 's' : ''})` : '';
        return (
          <Pressable
            key={need.key}
            onPress={() => open(router, event.id)}
            accessibilityRole="button"
            accessibilityLabel={`${NEED[need.kind].verb}: ${eventTitle(event)}`}
            style={({ pressed }) => [
              styles.needRow,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.needIcon, { backgroundColor: theme.accent }]}>
              <Ionicons name={NEED[need.kind].icon} size={18} color={theme.onAccent} />
            </View>
            <View style={styles.fill}>
              <ThemedText style={styles.needTitle} numberOfLines={1}>
                {NEED[need.kind].verb}
                {who}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                {eventTitle(event)}
                {need.dueAt ? ` · closes ${timeUntil(need.dueAt)}` : ''}
              </ThemedText>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.accent} />
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------

const MAX_FACES = 4;

/** Everyone still coming, as far as this viewer may see: faces for members, a count for all. */
function Crowd({ people }: { people: Participant[] }) {
  const { memberById } = useSession();
  const coming = people.filter(
    (person) => (person.rsvp_status === 'going' || person.rsvp_status === 'maybe') && person.confirmation_status !== 'not_attending',
  );
  if (coming.length === 0) return null;
  const faces = coming
    .map((person) => memberById(person.member_id))
    .filter((member) => member !== undefined)
    .slice(0, MAX_FACES);
  return (
    <View style={styles.crowd} accessibilityLabel={`${coming.length} in so far`}>
      {faces.map((member, index) => (
        <View key={member.id} style={[styles.face, index > 0 && styles.faceOverlap]}>
          <MemberAvatar member={member} size={26} />
        </View>
      ))}
      <ThemedText style={styles.crowdText}>{coming.length} in</ThemedText>
    </View>
  );
}

/** The marquee: the night that is up next, as one big picture. */
export function FeaturedCard({ event, showtime, people = [] }: { event: EventRow; showtime?: Showtime; people?: Participant[] }) {
  const router = useRouter();
  const stage = stageOf(event);
  const art = tmdbImage(event.backdrop_path ?? event.movie.backdrop_path, 'w780') ?? tmdbImage(event.poster_path ?? event.movie.poster_path, 'w500');

  return (
    <View style={[styles.featuredShadow, Shadow.lg]}>
      <Pressable
        onPress={() => open(router, event.id)}
        accessibilityRole="button"
        accessibilityLabel={eventTitle(event)}
        style={({ pressed }) => [styles.featured, pressed && styles.pressed]}
      >
        {art && <Image source={{ uri: art }} style={StyleSheet.absoluteFill} contentFit="cover" transition={250} />}
        {/* Dimmed a little at the top for the pill, and down into near-black under the words. */}
        <LinearGradient colors={['rgba(0,0,0,0.35)', 'rgba(0,0,0,0.05)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.9)']} locations={[0, 0.3, 0.62, 1]} style={StyleSheet.absoluteFill} />

        <View style={styles.featuredTop}>
          <View style={[styles.pill, { backgroundColor: ON_IMAGE.gold }]}>
            <ThemedText style={[styles.pillText, { color: ON_IMAGE.onGold }]}>{showtime ? countdown(showtime.starts_at) : 'Date to be picked'}</ThemedText>
          </View>
          <Crowd people={people} />
        </View>

        <View>
          <View style={styles.featuredFoot}>
            <ThemedText type="eyebrow" style={{ color: ON_IMAGE.gold }}>
              {showtime ? 'Up next' : 'In the works'}
            </ThemedText>
            <ThemedText style={styles.featuredTitle} numberOfLines={2}>
              {eventTitle(event)}
            </ThemedText>
            {showtime ? (
              <>
                <ThemedText style={styles.featuredWhen}>{dayTime(showtime.starts_at)}</ThemedText>
                <ThemedText style={styles.featuredWhere} numberOfLines={1}>
                  {showtime.theater.name} · {formatLabel(showtime)}
                </ThemedText>
              </>
            ) : (
              <ThemedText style={styles.featuredWhere}>{planningLine(event)}</ThemedText>
            )}
            <View style={styles.trackRow}>
              <StageTrack stage={stage} onImage />
              <ThemedText style={styles.featuredStage}>{STAGE_LABEL[stage]}</ThemedText>
            </View>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------

/** A night with a date: the date leads. */
export function ScheduledRow({ event, showtime }: { event: EventRow; showtime: Showtime }) {
  const theme = useTheme();
  const router = useRouter();
  const date = new Date(showtime.starts_at);
  const stage = stageOf(event);

  return (
    <Pressable
      onPress={() => open(router, event.id)}
      accessibilityRole="button"
      accessibilityLabel={eventTitle(event)}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card style={styles.row}>
        <View style={[styles.dateTile, { borderColor: theme.border }]}>
          <View style={[styles.dateMonth, { backgroundColor: theme.accent }]}>
            <ThemedText style={[styles.dateMonthText, { color: theme.onAccent }]}>{date.toLocaleDateString(DATE_LOCALE, { month: 'short' })}</ThemedText>
          </View>
          <ThemedText style={styles.dateDay}>{date.getDate()}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.dateWeekday}>
            {date.toLocaleDateString(DATE_LOCALE, { weekday: 'short' })}
          </ThemedText>
        </View>
        <View style={styles.rowText}>
          <ThemedText style={styles.rowTitle} numberOfLines={2}>
            {eventTitle(event)}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {timeOnly(showtime.starts_at)} · {showtime.theater.name}
          </ThemedText>
          <View style={styles.trackRow}>
            <StageTrack stage={stage} />
            <ThemedText type="small" numberOfLines={1} style={[styles.stageLabel, { color: theme.accent }]}>
              {STAGE_LABEL[stage]}
            </ThemedText>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
      </Card>
    </Pressable>
  );
}

/** A night still being planned: the poster leads, and the track says how far along it is. */
export function PlanningRow({ event }: { event: EventRow }) {
  const theme = useTheme();
  const router = useRouter();
  const stage = stageOf(event);

  return (
    <Pressable
      onPress={() => open(router, event.id)}
      accessibilityRole="button"
      accessibilityLabel={eventTitle(event)}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card style={styles.row}>
        <Poster path={event.poster_path ?? event.movie.poster_path} width={56} />
        <View style={styles.rowText}>
          <ThemedText style={styles.rowTitle} numberOfLines={2}>
            {eventTitle(event)}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {planningLine(event)}
          </ThemedText>
          <View style={styles.trackRow}>
            <StageTrack stage={stage} />
            <ThemedText type="small" numberOfLines={1} style={[styles.stageLabel, { color: theme.accent }]}>
              {STAGE_LABEL[stage]}
            </ThemedText>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pressed: { opacity: 0.75 },


  track: { flexDirection: 'row', gap: 3 },
  trackStep: { width: 14, height: 4, borderRadius: 2 },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },

  needs: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.one,
  },
  needsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  count: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16 },
  needRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  needIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  needTitle: { fontFamily: Font.bold, fontSize: 16, lineHeight: 21 },

  featuredShadow: { borderRadius: Radius.lg },
  featured: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: '#17120A',
    aspectRatio: 1.25,
    justifyContent: 'space-between',
  },
  featuredTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two, padding: Spacing.three },
  pill: {
    borderRadius: Radius.full,
    paddingVertical: 5,
    paddingHorizontal: Spacing.two + 4,
  },
  pillText: {
    fontFamily: Font.extrabold,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: 0.2,
  },
  featuredFoot: { padding: Spacing.three, gap: 2 },
  crowd: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: Radius.full, paddingVertical: 3, paddingLeft: 3, paddingRight: Spacing.two + 2 },
  face: { borderRadius: 15, borderWidth: 2, borderColor: '#17120A' },
  faceOverlap: { marginLeft: -9 },
  crowdText: {
    fontFamily: Font.bold,
    fontSize: 13,
    lineHeight: 18,
    color: ON_IMAGE.text,
    marginLeft: Spacing.one + 2,
  },
  featuredTitle: {
    fontFamily: Font.serifBold,
    fontSize: 28,
    lineHeight: 33,
    letterSpacing: -0.4,
    color: ON_IMAGE.text,
  },
  featuredWhen: {
    fontFamily: Font.bold,
    fontSize: 16,
    lineHeight: 22,
    color: ON_IMAGE.text,
    marginTop: 2,
  },
  featuredWhere: {
    fontFamily: Font.medium,
    fontSize: 14,
    lineHeight: 20,
    color: ON_IMAGE.soft,
  },
  featuredStage: {
    fontFamily: Font.bold,
    fontSize: 13,
    lineHeight: 18,
    color: ON_IMAGE.gold,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  rowText: { flex: 1, gap: 2 },
  stageLabel: { flexShrink: 1, fontFamily: Font.bold },
  rowTitle: {
    fontFamily: Font.serifBold,
    fontSize: 18,
    lineHeight: 23,
    letterSpacing: -0.2,
  },

  dateTile: {
    width: 58,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    paddingBottom: Spacing.one,
  },
  dateMonth: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 3 },
  dateMonthText: {
    fontFamily: Font.extrabold,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  dateDay: { fontFamily: Font.serifBold, fontSize: 26, lineHeight: 32 },
  dateWeekday: { marginTop: -2 },
});
