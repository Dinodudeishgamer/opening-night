// Who is coming, and afterwards how it went. Both show exactly the rows the
// database let this viewer read: a member who has not answered the RSVP gets
// no roster, Can't Go answers appear only to Dino, and other people's scores
// appear only once the viewer has earned them.
//
// These are things to read, so they sit flat on the page as Sections, the way
// a film page lists its ratings and its cast.
//
// Once a night has ended there is one list of who was there, not two: the
// results table. It carries each person's guess and rating, and Dino taps a
// row in it to manage that person. The roster section then only has anything
// to say to Dino, about the people who did not come.
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import type { EventCtx, Person } from '@/components/event/context';
import { Face } from '@/components/event/face';
import { RecapShare } from '@/components/event/recap';
import { StatsGuide } from '@/components/stats-guide';
import { ThemedText } from '@/components/themed-text';
import { Fact, Row } from '@/components/ui/kit';
import { Delta, ScoreSummary } from '@/components/ui/score';
import { Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { Font, Radius, Spacing, type Tone } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { score } from '@/lib/format';
import { isPast } from '@/lib/stage';
import { eventStats, tiedNames } from '@/lib/stats';

function Group({ title, people, badge, onPress, guesses }: { title: string; people: Person[]; badge?: (person: Person) => { label: string; tone: Tone } | null; onPress?: (person: Person) => void; guesses?: boolean }) {
  const theme = useTheme();
  if (people.length === 0) return null;
  return (
    <View>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {title} · {people.length}
      </ThemedText>
      {people.map((person) => {
        const state = badge?.(person);
        return (
          <Row
            key={person.participant.id}
            left={<Face person={person} />}
            title={person.isMe ? `${person.name} (you)` : person.name}
            subtitle={person.note}
            right={
              <View style={styles.right}>
                {guesses && person.prediction !== undefined && person.predictionActive !== false && (
                  <ThemedText style={styles.rated} accessibilityLabel={`Guessed ${score(person.prediction)}`}>
                    {score(person.prediction)}
                  </ThemedText>
                )}
                {state && <StatusBadge label={state.label} tone={state.tone} />}
                {person.participant.checked_in_at && <Ionicons name="checkmark-circle" size={20} color={theme.success} accessibilityLabel="Checked in" />}
                {onPress && <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />}
              </View>
            }
            onPress={onPress ? () => onPress(person) : undefined}
          />
        );
      })}
    </View>
  );
}

/** The roster. Dino can tap anyone to manage them. */
export function PeopleSection({ ctx, onPress }: { ctx: EventCtx; onPress?: (person: Person) => void }) {
  const { event, voting } = ctx.bundle;
  const selected = event.selected_showtime_id !== null;
  const status = (value: string) => ctx.people.filter((person) => person.participant.rsvp_status === value);
  const coming = ctx.people.filter((person) => person.participant.rsvp_status === 'going' || person.participant.rsvp_status === 'maybe');
  const self = ctx.people.find((person) => person.isMe);
  const voted = new Set((voting.matrix ?? []).filter((row) => row.current).map((row) => row.participant_id));

  // Dino sees whether each person has voted (not how, here); members do not.
  const votedBadge = (person: Person) =>
    voting.matrix && !selected && voting.eligible > 0 ? (voted.has(person.participant.id) ? { label: 'Voted', tone: 'success' as Tone } : { label: 'Not voted', tone: 'warning' as Tone }) : null;
  // Other people's guesses are only in the data once the viewer has locked in their own.
  const guessesShown = ctx.people.some((person) => !person.isMine && person.prediction !== undefined && person.predictionActive !== false);
  const moneyBadge = (person: Person) =>
    person.charge && ctx.isOwner ? (person.charge.status === 'paid' ? { label: 'Paid', tone: 'success' as Tone } : { label: 'Unpaid', tone: 'warning' as Tone }) : null;

  if (event.ended_at) {
    // Everyone who was there is in the results table above. What is left is for Dino alone.
    const attended = ctx.people.some((person) => person.participant.checked_in_at);
    const absent = coming.filter((person) => !person.participant.checked_in_at);
    const declined = status('cant_go');
    if (!attended) {
      return (
        <Section title="Who was there">
          <ThemedText type="small" themeColor="textSecondary">
            Nobody was checked in.
          </ThemedText>
        </Section>
      );
    }
    if (!ctx.isOwner || absent.length + declined.length === 0) return null;
    return (
      <Section title="Not there (only you see this)">
        <View style={styles.groups}>
          <Group title="Said yes, not checked in" people={absent} badge={moneyBadge} onPress={onPress} />
          <Group title="Can't Go" people={declined} onPress={onPress} />
        </View>
      </Section>
    );
  }

  return (
    <Section title="Who's coming">
      {!ctx.isOwner && !self?.participant.rsvp_status && !event.ended_at ? (
        <Fact icon="eye-off-outline" text="RSVP to see who else is in." />
      ) : coming.length === 0 && !ctx.isOwner ? (
        <ThemedText type="small" themeColor="textSecondary">
          Nobody yet.
        </ThemedText>
      ) : selected ? (
        <View style={styles.groups}>
          <Group title={guessesShown ? 'Confirmed, with their guess' : 'Confirmed'} people={coming.filter((p) => p.participant.confirmation_status === 'attending')} badge={moneyBadge} onPress={onPress} guesses />
          <Group title="Waiting to hear" people={coming.filter((p) => p.participant.confirmation_status === null)} onPress={onPress} />
          <Group title="Can't make it" people={coming.filter((p) => p.participant.confirmation_status === 'not_attending')} badge={moneyBadge} onPress={onPress} />
        </View>
      ) : (
        <View style={styles.groups}>
          <Group title="Going" people={status('going')} badge={votedBadge} onPress={onPress} />
          <Group title="Maybe" people={status('maybe')} badge={votedBadge} onPress={onPress} />
        </View>
      )}
      {ctx.isOwner && (
        <View style={styles.groups}>
          <Group title="Can't Go (only you see this)" people={status('cant_go')} onPress={onPress} />
        </View>
      )}
    </Section>
  );
}

/** One fact about the night in a small framed tile. */
function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: Tone }) {
  const theme = useTheme();
  const color = tone === 'success' ? theme.success : tone === 'danger' ? theme.danger : theme.text;
  return (
    <View style={[styles.tile, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
      <ThemedText type="eyebrow" themeColor="textSecondary" numberOfLines={2} style={styles.tileLabel}>
        {label}
      </ThemedText>
      <ThemedText style={[styles.tileValue, { color }]}>{value}</ThemedText>
      {detail ? (
        // Two lines: a tie names two or three people.
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
          {detail}
        </ThemedText>
      ) : null}
    </View>
  );
}

const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

/**
 * A person's guess and what they made of it: "3.90 → 4.25" with the
 * difference under it. Stacked so the row keeps room for a whole name on a
 * narrow phone.
 */
function ScoreLine({ prediction, rating, change }: { prediction: number | null; rating: number | null; change: number | null }) {
  const theme = useTheme();
  return (
    <View style={styles.scoreStack}>
      <View style={styles.scoreLine}>
        <ThemedText style={[styles.guess, { color: theme.textSecondary }]}>{prediction !== null ? score(prediction) : '–'}</ThemedText>
        <Ionicons name="arrow-forward" size={13} color={theme.textSecondary} />
        <ThemedText style={styles.rated}>{rating !== null ? score(rating) : '–'}</ThemedText>
      </View>
      {change !== null ? <Delta value={change} /> : null}
    </View>
  );
}

/**
 * Before the night: the group's predictions, once the viewer has made theirs.
 * After it: predictions against ratings for the people who were there, and
 * what the numbers say.
 */
export function ResultsSection({ ctx, onPress }: { ctx: EventCtx; onPress?: (person: Person) => void }) {
  const { event } = ctx.bundle;

  if (!event.ended_at) {
    const predicted = ctx.people.filter((person) => person.prediction !== undefined && person.predictionActive !== false);
    // Only your own (or nothing): the prediction card already covers it.
    if (!predicted.some((person) => !person.isMine)) return null;
    const guesses = predicted.map((person) => person.prediction!);
    return (
      <Section title="Predictions" count={predicted.length}>
        <ScoreSummary label="The group expects" values={guesses} average={guesses.reduce((sum, value) => sum + value, 0) / guesses.length} footnote="Each guess is beside its name below" />
      </Section>
    );
  }


  const attendees = ctx.people.filter((person) => person.participant.checked_in_at);
  if (attendees.length === 0) return null;
  const stats = eventStats(
    attendees.map((person) => ({ participantId: person.participant.id, name: person.name, isGuest: Boolean(person.guest) })),
    ctx.bundle.predictions,
    ctx.bundle.ratings,
  );
  const byId = new Map(attendees.map((person) => [person.participant.id, person]));
  const self = attendees.find((person) => person.isMe);
  const ratingsHidden = !isPast(event) && self?.rating === undefined;
  const rated = stats.people.filter((person) => person.rating !== null).map((person) => person.rating!);
  const guessed = stats.people.filter((person) => person.prediction !== null).map((person) => person.prediction!);
  const versus = stats.predictionVsFinal;

  return (
    <Section title={isPast(event) ? 'How it went' : 'So far'}>
      {ratingsHidden && (
        <Fact icon="eye-off-outline" text={self ? 'Ratings stay hidden until you submit yours.' : 'Ratings are revealed to everyone 48 hours after the movie.'} />
      )}

      {stats.ratings ? (
        <ScoreSummary label="Group rating" values={rated} average={stats.ratings.average} footnote={`${stats.ratings.count} rating${stats.ratings.count === 1 ? '' : 's'}`} />
      ) : stats.predictions ? (
        <ScoreSummary label="The group expected" values={guessed} average={stats.predictions.average} />
      ) : null}

      {(stats.predictions || versus !== null || stats.accuracy !== null) && (
        <View style={styles.tiles}>
          {stats.ratings && stats.predictions && <Tile label="Group guess" value={score(stats.predictions.average)} detail={`Guesses ran ${score(stats.predictions.min)} to ${score(stats.predictions.max)}`} />}
          {versus !== null && (
            <Tile
              label={versus > 0 ? 'Beat our guess' : versus < 0 ? 'Missed our guess' : 'Matched our guess'}
              value={versus === 0 ? score(0) : score(Math.abs(versus))}
              tone={versus > 0 ? 'success' : versus < 0 ? 'danger' : undefined}
              detail={versus > 0 ? 'Better than we expected' : versus < 0 ? 'Worse than we expected' : 'Exactly as we expected'}
            />
          )}
          {stats.accuracy !== null && <Tile label="Guess accuracy" value={`${stats.accuracy}%`} detail={stats.closest.length ? `Closest guess: ${tiedNames(stats.closest)}` : undefined} />}
          {stats.biggestRise.length > 0 && <Tile label="Biggest surprise" value={signed(stats.biggestRise[0].change!)} tone="success" detail={tiedNames(stats.biggestRise)} />}
          {stats.biggestDrop.length > 0 && <Tile label="Biggest letdown" value={signed(stats.biggestDrop[0].change!)} tone="danger" detail={tiedNames(stats.biggestDrop)} />}
          {stats.fan.length > 0 && <Tile label="Biggest fan" value={score(stats.fan[0].rating!)} detail={tiedNames(stats.fan)} />}
          {stats.critic.length > 0 && <Tile label="Toughest critic" value={score(stats.critic[0].rating!)} detail={tiedNames(stats.critic)} />}
        </View>
      )}
      {stats.ratings && <StatsGuide about="night" />}

      <View>
        <View style={styles.tableHead}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.flex}>
            Who
          </ThemedText>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Guess → rated
          </ThemedText>
        </View>
        {stats.people.map((result) => {
          const person = byId.get(result.participantId)!;
          return (
            <Row
              key={result.participantId}
              left={<Face person={person} size={34} />}
              title={result.name}
              subtitle={person.note}
              right={<ScoreLine prediction={result.prediction} rating={result.rating} change={result.change} />}
              onPress={onPress ? () => onPress(person) : undefined}
            />
          );
        })}
      </View>
      {onPress && (
        <ThemedText type="small" themeColor="textSecondary">
          Tap a row to correct their scores or charge. Tap a picture to see it bigger.
        </ThemedText>
      )}

      {/* Once the ratings are final, the night is something to show off. */}
      {isPast(event) && (
        <View style={styles.share}>
          <RecapShare ctx={ctx} stats={stats} attendees={attendees} />
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  groups: { gap: Spacing.three },
  share: { flexDirection: 'row' },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  tile: { flexGrow: 1, flexBasis: '45%', borderWidth: StyleSheet.hairlineWidth, borderRadius: Radius.md, padding: Spacing.two + 4, gap: 1 },
  tileValue: { fontFamily: Font.serifBold, fontSize: 26, lineHeight: 32, letterSpacing: -0.4 },

  tableHead: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.one },
  tileLabel: { lineHeight: 15 },
  scoreStack: { alignItems: 'flex-end', gap: 3 },
  scoreLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one + 2 },
  guess: { fontFamily: Font.medium, fontSize: 14, lineHeight: 20, textAlign: 'right' },
  rated: { fontFamily: Font.serifBold, fontSize: 18, lineHeight: 24, textAlign: 'right' },
});
