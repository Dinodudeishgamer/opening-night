// What a member does on a movie night's page, in the order the night asks:
// RSVP (and guests), vote on showtimes, confirm the one Dino picked, pay,
// predict, rate. Each section appears when its question is live and steps
// aside when it is not; the page is one page throughout.
//
// Every button here calls an RPC that re-checks the rule server-side. What is
// hidden or disabled in this file is for clarity, not for enforcement.
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';

import type { EventCtx, Person } from '@/components/event/context';
import { RevealModal } from '@/components/event/reveal';
import { eventTitle } from '@/components/event-card';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Choices, Fact, Row, Sheet, useAction } from '@/components/ui/kit';
import { ScorePicker } from '@/components/ui/score';
import { StatusBadge } from '@/components/ui/status-badge';
import { TextField } from '@/components/ui/text-field';
import { Font, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { actions } from '@/lib/api';
import { confirmAction } from '@/lib/dialogs';
import { CONFIRMATION_LABEL, dayTime, formatLabel, money, RSVP_LABEL, score, timeUntil } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { appleCashLink, venmoLinks } from '@/lib/links';
import { confirmationOpen, ratingOpen, rsvpOpen } from '@/lib/stage';
import type { ConfirmationStatus, RsvpStatus, Showtime } from '@/lib/types';

const coming = (person: Person) => person.participant.rsvp_status === 'going' || person.participant.rsvp_status === 'maybe';

// ---------------------------------------------------------------------------
// RSVP and guests
// ---------------------------------------------------------------------------

export function RsvpSection({ ctx }: { ctx: EventCtx }) {
  const { event } = ctx.bundle;
  const { busy, run } = useAction(ctx.refresh);
  const [guestSheet, setGuestSheet] = useState<{ person?: Person } | null>(null);
  const open = rsvpOpen(event);
  const self = ctx.mine.find((person) => person.isMe);
  const myGuests = ctx.mine.filter((person) => person.guest);
  const answer = self?.participant.rsvp_status ?? null;

  // Once a showtime is selected the live question is confirmation, not RSVP.
  if (event.selected_showtime_id || event.ended_at) return null;

  return (
    <Card elevated={open && !answer}>
      <CardTitle kicker="RSVP" title="Are you in?" icon="hand-left-outline" right={answer && !open ? <StatusBadge label={RSVP_LABEL[answer]} tone={answer === 'cant_go' ? 'muted' : 'success'} /> : undefined} />
      {open ? (
        <>
          <Choices<RsvpStatus>
            options={[
              { value: 'going', label: 'Going' },
              { value: 'maybe', label: 'Maybe' },
              { value: 'cant_go', label: "Can't Go" },
            ]}
            value={answer}
            disabled={busy !== null}
            onChange={(status) => run('rsvp', () => actions.setRsvp(event.id, status))}
          />
          <Fact icon="time-outline" text={`You can change this until ${dayTime(event.rsvp_deadline)} (${timeUntil(event.rsvp_deadline)}).`} />
        </>
      ) : (
        <Fact
          icon="lock-closed-outline"
          text={answer ? 'RSVP is closed. Tell Dino if your plans changed.' : "RSVP is closed, and no answer counts as Can't Go. Tell Dino if you want in."}
        />
      )}

      {(myGuests.length > 0 || (open && answer && answer !== 'cant_go')) && (
        <View style={styles.block}>
          <ThemedText type="smallBold">Your guests</ThemedText>
          {myGuests.map((person) => (
            <Row
              key={person.participant.id}
              title={person.name}
              subtitle={person.participant.rsvp_status ? RSVP_LABEL[person.participant.rsvp_status] : null}
              right={open ? <Button title="Edit" size="sm" variant="secondary" onPress={() => setGuestSheet({ person })} /> : undefined}
            />
          ))}
          {open && answer && answer !== 'cant_go' && (
            <Button title="Bring a guest" size="sm" variant="secondary" icon="person-add-outline" onPress={() => setGuestSheet({})} />
          )}
          {open && myGuests.length > 0 && (
            <ThemedText type="small" themeColor="textSecondary">
              {"To switch to Can't Go, remove your guests first."}
            </ThemedText>
          )}
        </View>
      )}

      <GuestSheet ctx={ctx} target={guestSheet} onClose={() => setGuestSheet(null)} />
    </Card>
  );
}

function GuestSheet({ ctx, target, onClose }: { ctx: EventCtx; target: { person?: Person } | null; onClose: () => void }) {
  const editing = target?.person;
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'going' | 'maybe'>('going');
  const { busy, run } = useAction(ctx.refresh);

  useEffect(() => {
    setName(editing?.name ?? '');
    setStatus(editing?.participant.rsvp_status === 'maybe' ? 'maybe' : 'going');
  }, [editing, target]);

  const done = async (key: string, work: () => Promise<unknown>) => {
    if (await run(key, work)) onClose();
  };

  return (
    <Sheet visible={target !== null} title={editing ? 'Your guest' : 'Bring a guest'} onClose={onClose}>
      <TextField label="Guest's name" value={name} onChangeText={setName} autoCapitalize="words" maxLength={60} placeholder="Their name" />
      <Choices<'going' | 'maybe'> options={[{ value: 'going', label: 'Going' }, { value: 'maybe', label: 'Maybe' }]} value={status} onChange={setStatus} />
      <ThemedText type="small" themeColor="textSecondary">
        You answer for your guest all the way through: showtimes, confirming, their prediction, and their rating afterwards. Their ticket is its own charge, and you are the one reminded about it.
      </ThemedText>
      <Button
        title={editing ? 'Save' : 'Add guest'}
        disabled={!name.trim()}
        loading={busy === 'save'}
        onPress={() =>
          done('save', () =>
            editing?.guest ? actions.updateGuest(editing.guest.id, name.trim(), status) : actions.addGuest(ctx.bundle.event.id, name.trim(), status),
          )
        }
      />
      {editing?.guest && (
        <Button title="Remove guest" variant="destructiveOutline" loading={busy === 'remove'} onPress={() => done('remove', () => actions.removeGuest(editing.guest!.id))} />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Showtime voting
// ---------------------------------------------------------------------------

export function ShowtimeLine({ showtime }: { showtime: Showtime }) {
  return (
    <View style={styles.flex}>
      <ThemedText style={styles.strong}>{dayTime(showtime.starts_at)}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {showtime.theater.name} · {formatLabel(showtime)}
      </ThemedText>
    </View>
  );
}

export function VotingSection({ ctx }: { ctx: EventCtx }) {
  const theme = useTheme();
  const { event, showtimes, voting } = ctx.bundle;
  const active = showtimes.filter((showtime) => !showtime.removed_at);
  const voters = ctx.mine.filter(coming);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const { busy, run } = useAction(ctx.refresh);

  // Start each ballot from what was last submitted; re-seed when the slate changes.
  const seed = JSON.stringify(voting.mine.map((row) => [row.participant_id, row.current, row.showtime_ids]));
  useEffect(() => {
    setPicks(Object.fromEntries(voting.mine.map((row) => [row.participant_id, row.showtime_ids])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, voting.voting_revision]);

  if (event.selected_showtime_id || event.ended_at || active.length === 0) return null;

  const count = (id: string) => voting.counts.find((entry) => entry.showtime_id === id)?.available ?? 0;
  const toggle = (participantId: string, showtimeId: string) =>
    setPicks((current) => {
      const mine = current[participantId] ?? [];
      return { ...current, [participantId]: mine.includes(showtimeId) ? mine.filter((id) => id !== showtimeId) : [...mine, showtimeId] };
    });

  // Your turn while voting is open and one of your ballots is missing or out of date.
  const waiting = voting.open && voters.some((person) => !voting.mine.find((row) => row.participant_id === person.participant.id)?.current);

  return (
    <Card elevated={waiting}>
      <CardTitle kicker="Showtimes" title="Which ones work?" icon="checkbox-outline" right={<StatusBadge label={`${voting.voted}/${voting.eligible} voted`} tone={voting.voted === voting.eligible && voting.eligible > 0 ? 'success' : 'muted'} />} />

      {!voting.open ? (
        <>
          <Fact icon="lock-closed-outline" text="Voting is closed. Dino is picking the showtime." />
          {active.map((showtime) => (
            <View key={showtime.id} style={styles.optionRow}>
              <ShowtimeLine showtime={showtime} />
              <ThemedText type="small" themeColor="textSecondary">{count(showtime.id)} can</ThemedText>
            </View>
          ))}
        </>
      ) : voters.length === 0 ? (
        <>
          <Fact icon="information-circle-outline" text="Going and Maybe vote on showtimes. RSVP above to join in." />
          {active.map((showtime) => (
            <View key={showtime.id} style={styles.optionRow}>
              <ShowtimeLine showtime={showtime} />
              <ThemedText type="small" themeColor="textSecondary">{count(showtime.id)} can</ThemedText>
            </View>
          ))}
        </>
      ) : (
        voters.map((person) => {
          const row = voting.mine.find((entry) => entry.participant_id === person.participant.id);
          const chosen = picks[person.participant.id] ?? [];
          return (
            <View key={person.participant.id} style={styles.block}>
              {voters.length > 1 && <ThemedText type="smallBold">{person.isMe ? 'You' : person.name}</ThemedText>}
              {row && !row.current && (
                <Fact
                  icon="refresh-outline"
                  tone="warning"
                  // Only someone with picks on record is told the list changed. Adding
                  // the first few showtimes bumps the revision too, and a first-time
                  // voter has nothing to "submit again".
                  text={row.showtime_ids.length > 0 ? 'The showtimes changed. Review and submit again.' : 'Tick every showtime that works, then submit.'}
                />
              )}
              {active.map((showtime) => {
                const on = chosen.includes(showtime.id);
                return (
                  <Pressable
                    key={showtime.id}
                    onPress={() => {
                      haptic.tick();
                      toggle(person.participant.id, showtime.id);
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={styles.optionRow}>
                    <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? theme.accent : theme.textSecondary} />
                    <ShowtimeLine showtime={showtime} />
                    <ThemedText type="small" themeColor="textSecondary">{count(showtime.id)} can</ThemedText>
                  </Pressable>
                );
              })}
              <Button
                title={chosen.length === 0 ? 'None of these work' : row?.current ? 'Update my answer' : 'Submit'}
                size="sm"
                variant={row?.current ? 'secondary' : 'primary'}
                loading={busy === person.participant.id}
                onPress={async () => {
                  if (await run(person.participant.id, () => actions.submitBallot(person.participant.id, chosen))) haptic.success();
                }}
              />
            </View>
          );
        })
      )}
      {voting.open && <ThemedText type="small" themeColor="textSecondary">Tick every one you could make. It is not a ranking, and only the totals are shared.</ThemedText>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export function ConfirmSection({ ctx }: { ctx: EventCtx }) {
  const { event } = ctx.bundle;
  const { busy, run } = useAction(ctx.refresh);
  const askable = ctx.mine.filter(coming);
  if (!event.selected_showtime_id || event.ended_at || askable.length === 0) return null;
  const open = confirmationOpen(event);

  return (
    <Card elevated={open && askable.some((person) => !person.participant.confirmation_status)}>
      <CardTitle kicker="Confirm" title="Can you make it?" icon="checkmark-circle-outline" />
      {askable.map((person) => {
        const answer = person.participant.confirmation_status;
        return (
          <View key={person.participant.id} style={styles.block}>
            {askable.length > 1 && <ThemedText type="smallBold">{person.isMe ? 'You' : person.name}</ThemedText>}
            {open ? (
              <Choices<ConfirmationStatus>
                options={[
                  { value: 'attending', label: "I'll be there" },
                  { value: 'not_attending', label: "Can't make it" },
                ]}
                value={answer}
                disabled={busy !== null}
                onChange={(status) => run(person.participant.id, () => actions.setConfirmation(person.participant.id, status))}
              />
            ) : (
              <StatusBadge label={answer ? CONFIRMATION_LABEL[answer] : 'Not Attending (no answer)'} tone={answer === 'attending' ? 'success' : 'muted'} />
            )}
          </View>
        );
      })}
      {open && askable.every((person) => person.participant.confirmation_status === 'attending') ? (
        // Often nobody tapped anything: the showtime Dino picked was one they had already said works.
        <Fact icon="checkmark-circle-outline" tone="success" text={`You are confirmed. If something comes up, change it by ${dayTime(event.confirmation_deadline!)}, or before Dino buys the tickets.`} />
      ) : open ? (
        <Fact icon="time-outline" text={`Answer by ${dayTime(event.confirmation_deadline!)} (${timeUntil(event.confirmation_deadline!)}). No answer means Not Attending. You can change it until then, or until Dino buys the tickets.`} />
      ) : (
        <Fact icon="lock-closed-outline" text={event.tickets_purchased_at ? 'Tickets are bought, so this is locked. Talk to Dino if something changed.' : 'The deadline has passed. Talk to Dino if something changed.'} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

async function openFirst(urls: string[]) {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // That app is not installed; try the next way.
    }
  }
}

export function PaymentSection({ ctx }: { ctx: EventCtx }) {
  const owing = ctx.mine.filter((person) => person.charge);
  if (owing.length === 0) return null;
  const unpaid = owing.filter((person) => person.charge!.status === 'unpaid');
  const total = unpaid.reduce((sum, person) => sum + person.charge!.amount_cents, 0);
  const note = `Opening Night: ${eventTitle(ctx.bundle.event)}`;
  const request = { amountCents: total, note };
  const settings = ctx.settings;
  // Dino's own share is recorded as paid; there is nobody for him to pay.
  const payable = total > 0 && !ctx.isOwner;
  // Nothing owed and nothing to do: for Dino (who has the whole list on his
  // own card) and for anyone once the night is over, the card is just noise.
  if (total === 0 && (ctx.isOwner || ctx.bundle.event.ended_at)) return null;

  return (
    <Card elevated={payable}>
      <CardTitle kicker="Tickets" title={total > 0 ? `${money(total)} due` : 'All paid'} icon="cash-outline" />
      {owing.map((person) => (
        <Row
          key={person.participant.id}
          title={person.isMe ? 'Your ticket' : `${person.name}'s ticket`}
          subtitle={person.guest ? 'Your guest: you settle this with Dino or remind them to.' : null}
          right={
            <View style={styles.amount}>
              <ThemedText style={styles.strong}>{money(person.charge!.amount_cents)}</ThemedText>
              <StatusBadge label={person.charge!.status === 'paid' ? 'Paid' : 'Unpaid'} tone={person.charge!.status === 'paid' ? 'success' : 'warning'} />
            </View>
          }
        />
      ))}
      {payable && (
        <>
          <View style={styles.buttons}>
            {settings?.venmo_username ? (
              <Button title="Venmo" size="sm" icon="logo-venmo" onPress={() => void openFirst(venmoLinks(settings.venmo_username!, request))} />
            ) : null}
            {Platform.OS === 'ios' && settings?.apple_cash_recipient ? (
              <Button title="Apple Cash" size="sm" variant="secondary" icon="logo-apple" onPress={() => void openFirst([appleCashLink(settings.apple_cash_recipient!, request)])} />
            ) : null}
          </View>
          {settings?.payment_note ? <ThemedText type="small" themeColor="textSecondary">{settings.payment_note}</ThemedText> : null}
          <Fact icon="information-circle-outline" text="Dino marks it paid once it arrives. Reminders stop the moment he does." />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export function PredictionSection({ ctx }: { ctx: EventCtx }) {
  const { event } = ctx.bundle;
  const { busy, run } = useAction(ctx.refresh);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const predictors = ctx.mine.filter((person) => person.participant.confirmation_status === 'attending' || person.prediction !== undefined);
  if (!event.selected_showtime_id || predictors.length === 0) return null;
  // After the night, predictions are shown with the results instead.
  if (event.ended_at) return null;

  return (
    <Card elevated={predictors.some((person) => person.prediction === undefined)}>
      <CardTitle kicker="Prediction" title="How good will it be?" icon="sparkles-outline" />
      {predictors.map((person) => {
        const id = person.participant.id;
        const value = drafts[id] ?? null;
        const who = person.isMe ? 'Your' : `${person.name}'s`;
        if (person.prediction !== undefined) {
          return (
            <Row
              key={id}
              title={`${who} prediction`}
              subtitle={person.predictionActive === false ? 'On hold until confirmed again.' : 'Locked in.'}
              right={<ThemedText style={styles.score}>{score(person.prediction)}</ThemedText>}
            />
          );
        }
        return (
          <View key={id} style={styles.block}>
            {predictors.length > 1 && <ThemedText type="smallBold">{who} prediction</ThemedText>}
            <ScorePicker label={`${who} prediction`} value={value} onChange={(next) => setDrafts({ ...drafts, [id]: next })} />
            <Button
              title={value === null ? 'Lock it in' : `Lock in ${score(value)}`}
              disabled={value === null}
              loading={busy === id}
              onPress={() =>
                confirmAction({
                  title: `Lock in ${score(value!)}?`,
                  message: 'A prediction cannot be changed once it is submitted.',
                  confirmLabel: 'Lock it in',
                  onConfirm: () =>
                    void run(id, () => actions.submitPrediction(id, value!)).then((done) => {
                      if (done) haptic.success();
                    }),
                })
              }
            />
          </View>
        );
      })}
      <Fact icon="eye-off-outline" text="Your guess before the lights go down. You see everyone else's only after you lock in your own." />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

export function RatingSection({ ctx }: { ctx: EventCtx }) {
  const { event } = ctx.bundle;
  const { busy, run } = useAction(ctx.refresh);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [reveal, setReveal] = useState(false);
  // You, then any guests you brought: whoever was checked in has a rating, and a guest's is yours to enter.
  const raters = ctx.mine.filter((person) => person.participant.checked_in_at);

  if (raters.length === 0) return null;
  const open = ratingOpen(event);

  if (!open) {
    const rated = raters.filter((person) => person.rating !== undefined);
    return rated.length > 0 ? (
      <Card>
        {rated.map((person) => (
          <Row
            key={person.participant.id}
            title={person.isMe ? 'Your rating' : `${person.name}'s rating`}
            subtitle="Locked in."
            right={<ThemedText style={styles.score}>{score(person.rating!)}</ThemedText>}
          />
        ))}
      </Card>
    ) : null;
  }

  // Your own first rating is a moment: the group's score rolls up. A change, or a guest's, is just saved.
  async function submit(person: Person, value: number) {
    const id = person.participant.id;
    const first = person.isMe && person.rating === undefined;
    const work = person.isMe ? () => actions.submitRating(event.id, value) : () => actions.submitGuestRating(id, value);
    if (!(await run(id, work))) return;
    haptic.success();
    if (first) setReveal(true);
  }

  const waiting = raters.some((person) => person.rating === undefined);
  const self = raters.find((person) => person.isMe);
  const these = raters.length > 1 ? 'these' : 'it';
  const others = self ? 'You see the others once yours is in.' : 'Everyone sees the ratings then.';

  return (
    <Card elevated={waiting && event.ended_at !== null}>
      <CardTitle kicker="Rating" title={waiting ? 'What did you think?' : raters.length > 1 ? 'Your ratings' : 'Your rating'} icon="star-outline" />
      {raters.map((person) => {
        const id = person.participant.id;
        const existing = person.rating;
        const value = drafts[id] ?? existing ?? null;
        const who = person.isMe ? 'Your' : `${person.name}'s`;
        return (
          <View key={id} style={styles.block}>
            {raters.length > 1 && <ThemedText type="smallBold">{who} rating</ThemedText>}
            <ScorePicker label={`${who} rating`} value={value} onChange={(next) => setDrafts({ ...drafts, [id]: next })} />
            <Button
              title={value === null ? 'Submit rating' : existing === undefined ? `Rate it ${score(value)}` : value === existing ? `Rated ${score(existing)}` : `Change to ${score(value)}`}
              disabled={value === null || value === existing}
              loading={busy === id}
              onPress={() => void submit(person, value!)}
            />
          </View>
        );
      })}
      <Fact
        icon="time-outline"
        text={
          event.ended_at
            ? `You can change ${these} until ${dayTime(new Date(new Date(event.ended_at).getTime() + 48 * 3_600_000).toISOString())}. ${others}`
            : `You can change ${these} for 48 hours after Dino ends the night. ${others}`
        }
      />
      {raters.some((person) => !person.isMe) && (
        <ThemedText type="small" themeColor="textSecondary">
          {"Ask your guest what they thought. Their rating counts in the group score like anyone else's."}
        </ThemedText>
      )}
      <RevealModal ctx={ctx} visible={reveal} onClose={() => setReveal(false)} />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  block: { gap: Spacing.two },
  buttons: { flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap' },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.one + 2 },
  strong: { fontFamily: Font.semibold, fontSize: 15, lineHeight: 20 },
  amount: { alignItems: 'flex-end', gap: 4 },
  score: { fontFamily: Font.serifBold, fontSize: 24, lineHeight: 30 },
});
