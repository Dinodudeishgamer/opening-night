// Showday. On the day of the showing, the event page opens with the night as
// one picture: when, when to be there, where, and who is sitting where.
// Before that day, once the tickets are bought, Dino gets a card here to type
// the seats in from the tickets. Members only ever see them on the day.
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EventCtx, Person } from '@/components/event/context';
import { Face } from '@/components/event/face';
import { eventTitle } from '@/components/event-card';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Fact, useAction } from '@/components/ui/kit';
import { TextField } from '@/components/ui/text-field';
import { Font, Radius, Spacing } from '@/constants/theme';
import { actions } from '@/lib/api';
import { arriveBy, formatLabel, timeOnly } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { bySeat, isShowday, tidySeat } from '@/lib/seats';

const GOLD = '#F2B84B';
const INK = '#0A0A0C';
const BULBS = 15;

/** Who has a seat tonight: confirmed, or already checked in. */
const coming = (person: Person) => person.participant.checked_in_at !== null || person.participant.confirmation_status === 'attending';

export function ShowdaySection({ ctx }: { ctx: EventCtx }) {
  const { event, showtimes } = ctx.bundle;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const showtime = showtimes.find((entry) => entry.id === event.selected_showtime_id);
  if (!showtime || event.ended_at) return null;

  const people = bySeat(ctx.people.filter(coming), (person) => person.participant.seat_label);
  const today = isShowday(showtime.starts_at);

  if (!today) {
    // Before the day: only Dino, and only once there are tickets to copy seats from.
    if (!ctx.isOwner || !event.tickets_purchased_at) return null;
    return (
      <Card>
        <CardTitle kicker="Seats" title="Who sits where" icon="ticket-outline" />
        <Fact icon="eye-outline" text="Type the seats in from the tickets. Everyone sees who is sitting where on showday." />
        <SeatEditor ctx={ctx} people={people} onDone={() => undefined} />
      </Card>
    );
  }

  const mine = people.filter((person) => person.isMine);
  const anySeats = people.some((person) => person.participant.seat_label);

  return (
    <View style={styles.wrap}>
      <View style={styles.marquee}>
        <Bulbs />
        <Text style={styles.brand}>{"It's showday"}</Text>
        <Text style={styles.title}>{eventTitle(event)}</Text>

        <View style={styles.when}>
          <Text style={styles.time}>{timeOnly(showtime.starts_at)}</Text>
          <Text style={styles.arrive}>Be there by {arriveBy(showtime.starts_at)}</Text>
          <Text style={styles.where}>
            {showtime.theater.name} · {formatLabel(showtime)}
          </Text>
        </View>

        {mine.some((person) => person.participant.seat_label) && (
          <View style={styles.yours}>
            <Text style={styles.label}>{mine.length > 1 ? 'Your seats' : 'Your seat'}</Text>
            {mine.map((person) => (
              <Text key={person.participant.id} style={styles.yourSeat}>
                {person.participant.seat_label ?? '?'}
                {mine.length > 1 ? <Text style={styles.yourName}>{`  ${person.isMe ? 'You' : person.name}`}</Text> : null}
              </Text>
            ))}
          </View>
        )}

        <View style={styles.rule} />
        <Text style={styles.label}>{anySeats ? 'Who is sitting where' : 'Who is coming'}</Text>
        <View style={styles.seats}>
          {people.map((person) => (
            <View key={person.participant.id} style={styles.seat}>
              <View style={[styles.faceRing, person.isMine && styles.faceRingMine]}>
                <Face person={person} size={40} />
              </View>
              {anySeats && <Text style={styles.seatLabel}>{person.participant.seat_label ?? '–'}</Text>}
              <Text style={styles.seatName} numberOfLines={1}>
                {person.isMe ? 'You' : person.name.split(' ')[0]}
              </Text>
            </View>
          ))}
        </View>
        {!anySeats && <Text style={styles.soon}>Seats show up here once Dino adds them.</Text>}
        <Bulbs />
      </View>

      {ctx.settings?.rewards_qr && (
        <Button title="Buying snacks? 25% off with the rewards QR" icon="qr-code-outline" size="sm" onPress={() => router.push('/rewards' as Href)} />
      )}

      {ctx.isOwner &&
        (editing ? (
          <Card>
            <CardTitle kicker="Seats" title="Who sits where" icon="ticket-outline" />
            <SeatEditor ctx={ctx} people={people} onDone={() => setEditing(false)} />
          </Card>
        ) : (
          <Button title={anySeats ? 'Edit seats' : 'Add seats'} icon="ticket-outline" variant="secondary" size="sm" onPress={() => setEditing(true)} />
        ))}
    </View>
  );
}

function Bulbs() {
  return (
    <View style={styles.bulbs}>
      {Array.from({ length: BULBS }, (_, index) => (
        <View key={index} style={[styles.bulb, index % 2 === 1 && styles.bulbDim]} />
      ))}
    </View>
  );
}

/** One field per person coming; Save writes only what changed. */
function SeatEditor({ ctx, people, onDone }: { ctx: EventCtx; people: Person[]; onDone: () => void }) {
  const { busy, run } = useAction(ctx.refresh);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(people.map((person) => [person.participant.id, person.participant.seat_label ?? ''])),
  );
  const changed = people.filter((person) => tidySeat(drafts[person.participant.id] ?? '') !== (person.participant.seat_label ?? null));

  if (people.length === 0) return <Fact icon="people-outline" text="Nobody is confirmed yet." />;

  return (
    <>
      {people.map((person) => (
        <TextField
          key={person.participant.id}
          label={person.isMe ? 'You' : person.note ? `${person.name} (${person.note.toLowerCase()})` : person.name}
          value={drafts[person.participant.id] ?? ''}
          onChangeText={(text) => setDrafts((current) => ({ ...current, [person.participant.id]: text }))}
          placeholder="F12"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={20}
        />
      ))}
      <Button
        title={changed.length === 0 ? 'Done' : `Save ${changed.length === 1 ? '1 seat' : `${changed.length} seats`}`}
        size="sm"
        loading={busy === 'seats'}
        onPress={async () => {
          if (changed.length === 0) return onDone();
          const ok = await run('seats', async () => {
            for (const person of changed) await actions.setSeat(person.participant.id, tidySeat(drafts[person.participant.id] ?? ''));
          });
          if (ok) {
            haptic.success();
            onDone();
          }
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.two },
  marquee: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(242,184,75,0.45)',
    backgroundColor: INK,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  bulbs: { flexDirection: 'row', justifyContent: 'space-between' },
  bulb: { width: 6, height: 6, borderRadius: 3, backgroundColor: GOLD },
  bulbDim: { opacity: 0.35 },
  brand: { fontFamily: Font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 3, textTransform: 'uppercase', color: GOLD, textAlign: 'center', marginTop: Spacing.one },
  title: { fontFamily: Font.serifBold, fontSize: 26, lineHeight: 31, letterSpacing: -0.4, color: '#FFFFFF', textAlign: 'center' },
  when: { alignItems: 'center', gap: 2, marginTop: Spacing.one },
  time: { fontFamily: Font.serifBold, fontSize: 44, lineHeight: 50, color: GOLD },
  arrive: { fontFamily: Font.bold, fontSize: 16, lineHeight: 21, color: '#FFFFFF' },
  where: { fontFamily: Font.regular, fontSize: 14, lineHeight: 19, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
  yours: { alignItems: 'center', gap: 2, marginTop: Spacing.two },
  yourSeat: { fontFamily: Font.serifBold, fontSize: 34, lineHeight: 40, color: GOLD },
  yourName: { fontFamily: Font.bold, fontSize: 15, color: '#FFFFFF' },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(242,184,75,0.45)', marginVertical: Spacing.two },
  label: { fontFamily: Font.bold, fontSize: 11, lineHeight: 15, letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', textAlign: 'center' },
  seats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: Spacing.three, rowGap: Spacing.three, paddingVertical: Spacing.one },
  seat: { alignItems: 'center', width: 58, gap: 3 },
  faceRing: { borderRadius: 24, padding: 2, borderWidth: 2, borderColor: 'transparent' },
  faceRingMine: { borderColor: GOLD },
  seatLabel: { fontFamily: Font.bold, fontSize: 15, lineHeight: 19, color: GOLD },
  seatName: { fontFamily: Font.regular, fontSize: 12, lineHeight: 16, color: '#FFFFFF' },
  soon: { fontFamily: Font.regular, fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.6)', textAlign: 'center' },
});
