// The top of the event page, laid out like a film's own page: the still
// across the top fading into the page, the poster stepping out of it, the
// title beside the poster. Once Dino has picked a showtime there is a ticket
// under it; before that there is deliberately no date.
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EventCtx } from '@/components/event/context';
import { eventTitle } from '@/components/event-card';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Fact } from '@/components/ui/kit';
import { Poster } from '@/components/ui/poster';
import { Fade } from '@/components/ui/section';
import { Font, Radius, Shadow, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { calendarState, saveToCalendar } from '@/lib/calendar';
import { showAlert } from '@/lib/dialogs';
import { DATE_LOCALE, dayTime, formatLabel, timeOnly, timeUntil, tmdbImage } from '@/lib/format';
import { calendarLocation, type CalendarEntry, mapsLink, trailerLink } from '@/lib/links';
import { backOrHome } from '@/lib/navigation';
import { rsvpOpen } from '@/lib/stage';
import type { Showtime } from '@/lib/types';

const STILL_HEIGHT = 230;
const POSTER_WIDTH = 112;

export function Hero({ ctx }: { ctx: EventCtx }) {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { event, showtimes } = ctx.bundle;
  const movie = event.movie;
  const backdrop = tmdbImage(event.backdrop_path ?? movie.backdrop_path, 'w780');
  // No still from the film? Its poster, blurred right down, makes a backdrop in the film's own colours.
  const still = backdrop ?? tmdbImage(event.poster_path ?? movie.poster_path, 'w342');
  const selected = showtimes.find((showtime) => showtime.id === event.selected_showtime_id);
  const year = movie.release_date?.slice(0, 4);
  const facts = [year, movie.runtime_minutes ? `${movie.runtime_minutes} min` : null].filter(Boolean);
  const genres = (movie.metadata?.genres ?? []).slice(0, 3);
  const overview = event.description_override ?? movie.overview;
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.wrap}>
      {/* The still runs edge to edge and up under the status bar. Without one, a short band keeps the back button's place. */}
      <View style={[styles.still, { height: (still ? STILL_HEIGHT : 56) + insets.top, backgroundColor: still ? '#17120A' : theme.background }]}>
        {still && <Image source={{ uri: still }} style={StyleSheet.absoluteFill} contentFit="cover" transition={250} blurRadius={backdrop ? 0 : 28} />}
        {still && (
          <>
            {/* The clock and the back button sit on the picture, so the top of it is always dimmed, and the status bar always light. */}
            <StatusBar style="light" />
            <View style={styles.stillTop}>
              <Fade color="#000000" height={insets.top + 70} from={0.5} to={0} />
            </View>
            <View style={styles.stillFade}>
              <Fade color={theme.background} height={120} />
            </View>
          </>
        )}
        <Pressable
          onPress={() => backOrHome(router)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={({ pressed }) => [styles.back, { top: insets.top + Spacing.two, backgroundColor: still ? 'rgba(0,0,0,0.5)' : theme.backgroundElement, opacity: pressed ? 0.7 : 1 }]}>
          <Ionicons name="chevron-back" size={22} color={still ? '#FFFFFF' : theme.text} />
        </Pressable>
      </View>

      <View style={[styles.titleRow, still ? styles.titleOverStill : null]}>
        <View style={[styles.posterShadow, Shadow.lg]}>
          <Poster path={event.poster_path ?? movie.poster_path} width={POSTER_WIDTH} />
        </View>
        <View style={styles.titleText}>
          <ThemedText style={styles.title}>{eventTitle(event)}</ThemedText>
          {facts.length > 0 && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.facts}>
              {facts.join('  ·  ')}
            </ThemedText>
          )}
          {genres.length > 0 && (
            <ThemedText type="eyebrow" style={{ color: theme.accent }}>
              {genres.join(' · ')}
            </ThemedText>
          )}
        </View>
      </View>

      {movie.metadata?.tagline ? (
        <ThemedText type="eyebrow" themeColor="textSecondary" style={styles.tagline}>
          {movie.metadata.tagline}
        </ThemedText>
      ) : null}

      {overview ? (
        <View>
          <ThemedText themeColor="textSecondary" numberOfLines={expanded ? undefined : 3} onPress={() => setExpanded(!expanded)} style={styles.overview}>
            {overview}
          </ThemedText>
          {overview.length > 140 && (
            <ThemedText type="smallBold" onPress={() => setExpanded(!expanded)} accessibilityRole="button" style={[styles.more, { color: theme.accent }]}>
              {expanded ? 'Show less' : 'Read more'}
            </ThemedText>
          )}
        </View>
      ) : null}

      {!event.ended_at && (
        <View style={styles.buttons}>
          <Button
            title="Watch the trailer"
            icon="play-circle-outline"
            size="sm"
            variant="secondary"
            onPress={() => void Linking.openURL(trailerLink(movie.metadata?.trailer_key, movie.title, year)).catch(() => {})}
          />
        </View>
      )}

      {event.owner_note ? (
        <View style={[styles.note, { borderLeftColor: theme.accent }]}>
          <ThemedText type="eyebrow" style={{ color: theme.accent }}>
            {"Dino's note"}
          </ThemedText>
          <ThemedText style={styles.noteText}>{event.owner_note}</ThemedText>
        </View>
      ) : null}

      {selected ? (
        <>
          <Ticket showtime={selected} ended={event.ended_at !== null} />
          {!event.ended_at && (
            <TicketButtons
              entry={{
                eventId: event.id,
                revision: event.schedule_revision,
                title: `Opening Night: ${eventTitle(event)}`,
                startsAt: selected.starts_at,
                runtimeMinutes: movie.runtime_minutes,
                theater: selected.theater.name,
                address: selected.theater.address,
                format: formatLabel(selected),
              }}
            />
          )}
        </>
      ) : (
        <Fact
          icon="time-outline"
          text={
            rsvpOpen(event)
              ? `No date yet: Dino picks the showtime after voting. RSVP closes ${timeUntil(event.rsvp_deadline)} (${dayTime(event.rsvp_deadline)}).`
              : 'No date yet: Dino picks the showtime after voting.'
          }
        />
      )}
    </View>
  );
}

/** What the stub of the ticket says: how long to go, or that it is over. */
function countdown(startsAt: string, ended: boolean): { big: string; small: string } {
  if (ended) return { big: 'FIN', small: 'The end' };
  const until = timeUntil(startsAt);
  if (until === 'passed') return { big: 'NOW', small: 'Showing' };
  const [, amount, unit] = until.split(' ');
  return { big: amount, small: `${unit} to go` };
}

/**
 * The showtime as a cinema ticket: when and where on the body, the countdown
 * on the stub, a perforation and two punched notches between them.
 */
function Ticket({ showtime, ended }: { showtime: Showtime; ended: boolean }) {
  const theme = useTheme();
  const date = new Date(showtime.starts_at);
  const stub = countdown(showtime.starts_at, ended);
  const notch = { backgroundColor: theme.background, borderColor: theme.border };

  return (
    <View style={[styles.ticketShadow, Shadow.md]}>
      <View style={[styles.ticket, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <View style={styles.ticketBody}>
          <ThemedText type="eyebrow" style={{ color: theme.accent }}>
            Showtime
          </ThemedText>
          <ThemedText style={styles.ticketDay}>{date.toLocaleDateString(DATE_LOCALE, { weekday: 'long', month: 'short', day: 'numeric' })}</ThemedText>
          <ThemedText style={styles.ticketTime}>{timeOnly(showtime.starts_at)}</ThemedText>
          <ThemedText style={styles.ticketTheater} numberOfLines={1}>
            {showtime.theater.name}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
            {[formatLabel(showtime), showtime.theater.address].filter(Boolean).join(' · ')}
          </ThemedText>
        </View>

        <View style={styles.perforation}>
          <View style={[styles.notch, styles.notchTop, notch]} />
          {Array.from({ length: 9 }, (_, index) => (
            <View key={index} style={[styles.dot, { backgroundColor: theme.border }]} />
          ))}
          <View style={[styles.notch, styles.notchBottom, notch]} />
        </View>

        <View style={[styles.ticketStub, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText style={[styles.stubBig, { color: theme.accent }]} numberOfLines={1} adjustsFontSizeToFit>
            {stub.big}
          </ThemedText>
          <ThemedText type="eyebrow" themeColor="textSecondary" style={styles.stubSmall}>
            {stub.small}
          </ThemedText>
        </View>
      </View>
    </View>
  );
}

// Under the ticket: put it in your calendar, and get there. The calendar is
// optional and only ever on this phone; after a reschedule the button says
// so, and updates the entry that is already there.
function TicketButtons({ entry }: { entry: CalendarEntry }) {
  const [state, setState] = useState<'none' | 'current' | 'stale'>('none');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    calendarState(entry.eventId, entry.revision).then((value) => {
      if (current) setState(value);
    });
    return () => {
      current = false;
    };
  }, [entry.eventId, entry.revision]);

  async function add() {
    setBusy(true);
    const result = await saveToCalendar(entry);
    setBusy(false);
    if (result.ok) {
      setState('current');
    } else if (result.reason === 'denied') {
      showAlert('No calendar access', 'Allow calendar access for Opening Night in Settings, then try again.');
    } else {
      showAlert('Could not add it', 'Your calendar is not available here.');
    }
  }

  return (
    <View style={styles.buttons}>
      <Button
        title={state === 'current' ? 'In your calendar' : state === 'stale' ? 'Update my calendar' : 'Add to my calendar'}
        icon={state === 'current' ? 'checkmark' : 'calendar-outline'}
        size="sm"
        variant={state === 'stale' ? 'primary' : 'secondary'}
        disabled={state === 'current'}
        loading={busy}
        onPress={add}
      />
      <Button
        title="Directions"
        size="sm"
        variant="secondary"
        icon="navigate-outline"
        accessibilityLabel={`Directions to ${entry.theater ?? 'the theater'}`}
        onPress={() => void Linking.openURL(mapsLink(calendarLocation(entry), Platform.OS)).catch(() => {})}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.three },

  // Cancels the page's own padding so the still reaches the edges and the top.
  still: { marginHorizontal: -Spacing.four, marginTop: -Spacing.three, overflow: 'hidden' },
  stillTop: { position: 'absolute', left: 0, right: 0, top: 0 },
  stillFade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  back: { position: 'absolute', left: Spacing.three, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },

  titleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.three },
  titleOverStill: { marginTop: -(Spacing.three + 84) },
  posterShadow: { borderRadius: Radius.md },
  titleText: { flex: 1, gap: Spacing.one, paddingBottom: 2 },
  title: { fontFamily: Font.serifBold, fontSize: 28, lineHeight: 32, letterSpacing: -0.5 },
  facts: { fontSize: 13 },

  tagline: { lineHeight: 17 },
  overview: { lineHeight: 22 },
  more: { marginTop: 2, paddingVertical: 2 },
  note: { borderLeftWidth: 3, paddingLeft: Spacing.three, paddingVertical: 2, gap: Spacing.one },
  noteText: { fontFamily: Font.medium, fontSize: 15, lineHeight: 22 },

  ticketShadow: { borderRadius: Radius.lg },
  ticket: { flexDirection: 'row', borderRadius: Radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  ticketBody: { flex: 1, padding: Spacing.three, gap: 1 },
  ticketDay: { fontFamily: Font.bold, fontSize: 15, lineHeight: 21, marginTop: Spacing.one },
  ticketTime: { fontFamily: Font.serifBold, fontSize: 34, lineHeight: 40, letterSpacing: -0.8 },
  ticketTheater: { fontFamily: Font.bold, fontSize: 15, lineHeight: 21, marginTop: Spacing.one },
  perforation: { width: 1, alignItems: 'center', justifyContent: 'space-evenly', paddingVertical: 14 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
  notch: { position: 'absolute', width: 18, height: 18, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, left: -9 },
  notchTop: { top: -9 },
  notchBottom: { bottom: -9 },
  ticketStub: { width: 104, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.two, gap: 2 },
  stubBig: { fontFamily: Font.serifBold, fontSize: 40, lineHeight: 46, letterSpacing: -1 },
  stubSmall: { textAlign: 'center' },

  buttons: { flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap' },
});
