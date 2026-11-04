// The night as a picture to send around: the poster, where and when, what
// the group made of it. Made on the phone from what is already on the page
// and handed to the share sheet; nothing is uploaded anywhere.
//
// It carries the group's numbers and first names only: nobody's individual
// score leaves the app on it.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EventCtx, Person } from '@/components/event/context';
import { eventTitle } from '@/components/event-card';
import { GuestAvatar, MemberAvatar } from '@/components/member-avatar';
import { Button } from '@/components/ui/button';
import { Font, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { showAlert } from '@/lib/dialogs';
import { DATE_LOCALE, MAX_SCORE, score, tmdbImage } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { CAN_SNAPSHOT, shareSnapshot } from '@/lib/snapshot';
import { type EventStats, tiedNames } from '@/lib/stats';

const GOLD = '#F2B84B';
const MAX_FACES = 9;

const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

/** "Share the recap": shows the card, then hands it to the share sheet as an image. */
export function RecapShare({ ctx, stats, attendees }: { ctx: EventCtx; stats: EventStats; attendees: Person[] }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const card = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // A picture of a view needs a phone; a browser has no way to take one.
  if (!CAN_SNAPSHOT || !stats.ratings) return null;

  async function share() {
    setBusy(true);
    try {
      haptic.tap();
      await shareSnapshot(card, eventTitle(ctx.bundle.event));
    } catch {
      showAlert('Could not share', 'Making the picture did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button title="Share the recap" icon="share-outline" size="sm" variant="secondary" onPress={() => setOpen(true)} />
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={[styles.backdrop, { backgroundColor: theme.overlay }]} onPress={() => setOpen(false)} accessibilityLabel="Close" />
        <View style={[styles.holder, { paddingTop: insets.top + Spacing.three, paddingBottom: Math.max(insets.bottom, Spacing.three) }]} pointerEvents="box-none">
          {/* collapsable={false}: the picture is taken of this exact view. */}
          <View ref={card} collapsable={false} style={styles.cardShadow}>
            <RecapCard ctx={ctx} stats={stats} attendees={attendees} />
          </View>
          <View style={styles.actions}>
            <Button title="Share" icon="share-outline" loading={busy} onPress={() => void share()} />
            <Pressable onPress={() => setOpen(false)} accessibilityRole="button" hitSlop={8} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

/** The card itself. Fixed colours: it has to look the same in every chat it lands in. */
function RecapCard({ ctx, stats, attendees }: { ctx: EventCtx; stats: EventStats; attendees: Person[] }) {
  const { event, showtimes } = ctx.bundle;
  const showtime = showtimes.find((entry) => entry.id === event.selected_showtime_id);
  const poster = tmdbImage(event.poster_path ?? event.movie.poster_path, 'w342');
  const when = showtime ? new Date(showtime.starts_at).toLocaleDateString(DATE_LOCALE, { month: 'long', day: 'numeric', year: 'numeric' }) : null;
  const versus = stats.predictionVsFinal;
  const ratings = stats.ratings!;
  const faces = attendees.slice(0, MAX_FACES);
  const more = attendees.length - faces.length;

  return (
    <View style={styles.card}>
      <LinearGradient colors={['#2B2210', '#121009', '#0A0A0C']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
      <View style={styles.bulbs}>
        {Array.from({ length: 15 }, (_, index) => (
          <View key={index} style={[styles.bulb, index % 2 === 1 && styles.bulbDim]} />
        ))}
      </View>
      <Text style={styles.brand}>Opening Night</Text>

      <View style={styles.film}>
        {poster ? <Image source={{ uri: poster }} style={styles.poster} contentFit="cover" /> : <View style={[styles.poster, styles.posterEmpty]} />}
        <View style={styles.filmText}>
          <Text style={styles.title} numberOfLines={3}>
            {eventTitle(event)}
          </Text>
          {when ? <Text style={styles.meta}>{when}</Text> : null}
          {showtime ? (
            <Text style={styles.meta} numberOfLines={1}>
              {showtime.theater.name}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.scoreRow}>
        <Text style={styles.score} numberOfLines={1} adjustsFontSizeToFit>
          {score(ratings.average)}
        </Text>
        <View style={styles.scoreSide}>
          <Text style={styles.scoreLabel}>We rated it</Text>
          <Text style={styles.scoreNote}>
            out of {MAX_SCORE} · {ratings.count} rating{ratings.count === 1 ? '' : 's'}
          </Text>
        </View>
      </View>

      <View style={styles.tiles}>
        {stats.predictions ? <Tile label="Guessed" value={score(stats.predictions.average)} /> : null}
        {versus !== null ? (
          <Tile label={versus > 0 ? 'Beat it by' : versus < 0 ? 'Missed by' : 'Spot on'} value={signed(versus)} color={versus > 0 ? '#6FCF73' : versus < 0 ? '#F0766D' : '#FFFFFF'} />
        ) : null}
        {stats.accuracy !== null ? <Tile label="Accuracy" value={`${stats.accuracy}%`} /> : null}
      </View>

      {stats.closest.length + stats.fan.length + stats.critic.length > 0 && (
        <View style={styles.honours}>
          {stats.closest.length > 0 ? <Honour label="Closest guess" name={tiedNames(stats.closest, true)} /> : null}
          {stats.fan.length > 0 ? <Honour label="Biggest fan" name={tiedNames(stats.fan, true)} detail={score(stats.fan[0].rating!)} /> : null}
          {stats.critic.length > 0 ? <Honour label="Toughest critic" name={tiedNames(stats.critic, true)} detail={score(stats.critic[0].rating!)} /> : null}
        </View>
      )}

      <View style={styles.faces}>
        {faces.map((person, index) => (
          <View key={person.participant.id} style={[styles.face, index > 0 && styles.faceOverlap]}>
            {person.guest ? <GuestAvatar name={person.name} size={30} /> : <MemberAvatar member={person.member} size={30} />}
          </View>
        ))}
        <Text style={styles.facesText}>
          {more > 0 ? `+${more} · ` : ''}
          {attendees.length} of us went
        </Text>
      </View>
    </View>
  );
}

/** A line of the roll of honour: what for, who, and with what score. */
function Honour({ label, name, detail }: { label: string; name: string; detail?: string }) {
  return (
    <View style={styles.honour}>
      <Text style={styles.honourLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.honourName} numberOfLines={2}>
        {name}
        {detail ? <Text style={styles.honourDetail}>{`  ${detail}`}</Text> : null}
      </Text>
    </View>
  );
}

function Tile({ label, value, color = '#FFFFFF', small }: { label: string; value: string; color?: string; small?: boolean }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.tileValue, small && styles.tileValueSmall, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject },
  holder: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.four, gap: Spacing.three },
  cardShadow: { borderRadius: Radius.lg, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.4, shadowRadius: 20, elevation: 10 },
  actions: { alignSelf: 'stretch', gap: Spacing.two, maxWidth: 340, width: '100%', alignItems: 'stretch' },
  close: { alignItems: 'center', paddingVertical: Spacing.two },
  closeText: { fontFamily: Font.bold, fontSize: 15, color: '#FFFFFF' },

  card: { width: 320, borderRadius: Radius.lg, overflow: 'hidden', padding: Spacing.four, gap: Spacing.three, borderWidth: 1, borderColor: 'rgba(242,184,75,0.45)', backgroundColor: '#0A0A0C' },
  bulbs: { flexDirection: 'row', justifyContent: 'space-between' },
  bulb: { width: 6, height: 6, borderRadius: 3, backgroundColor: GOLD },
  bulbDim: { opacity: 0.35 },
  brand: { fontFamily: Font.bold, fontSize: 11, lineHeight: 15, letterSpacing: 3, textTransform: 'uppercase', color: GOLD, textAlign: 'center' },

  film: { flexDirection: 'row', gap: Spacing.three, alignItems: 'flex-end' },
  poster: { width: 92, height: 138, borderRadius: Radius.sm, backgroundColor: '#1C1C20' },
  posterEmpty: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)' },
  filmText: { flex: 1, gap: 3, paddingBottom: 2 },
  title: { fontFamily: Font.serifBold, fontSize: 24, lineHeight: 28, letterSpacing: -0.4, color: '#FFFFFF' },
  meta: { fontFamily: Font.medium, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.72)' },

  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  score: { fontFamily: Font.serifBold, fontSize: 72, lineHeight: 80, letterSpacing: -2.5, color: GOLD, flexShrink: 1 },
  scoreSide: { flexShrink: 0, gap: 2 },
  scoreLabel: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 2, textTransform: 'uppercase', color: '#FFFFFF' },
  scoreNote: { fontFamily: Font.medium, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.72)' },

  tiles: { flexDirection: 'row', gap: Spacing.two },
  tile: { flex: 1, borderRadius: Radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(255,255,255,0.05)', paddingVertical: Spacing.two, paddingHorizontal: Spacing.two, gap: 1 },
  tileLabel: { fontFamily: Font.bold, fontSize: 9, lineHeight: 13, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)' },
  tileValue: { fontFamily: Font.serifBold, fontSize: 20, lineHeight: 28 },
  tileValueSmall: { fontSize: 18 },

  honours: { gap: 6 },
  honour: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: Spacing.three },
  honourLabel: { flexShrink: 0, fontFamily: Font.bold, fontSize: 10, lineHeight: 22, letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)' },
  honourName: { fontFamily: Font.serifBold, fontSize: 16, lineHeight: 22, color: '#FFFFFF', flexShrink: 1, textAlign: 'right' },
  honourDetail: { fontFamily: Font.bold, fontSize: 13, color: GOLD },

  faces: { flexDirection: 'row', alignItems: 'center' },
  face: { borderRadius: 17, borderWidth: 2, borderColor: '#0A0A0C' },
  faceOverlap: { marginLeft: -10 },
  facesText: { flex: 1, textAlign: 'right', fontFamily: Font.bold, fontSize: 12, lineHeight: 17, color: 'rgba(255,255,255,0.8)' },
});
