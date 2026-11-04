// Organizer mode for one movie night. Shown only to Dino, on the same page
// everyone else sees, so he always acts with the night in front of him.
//
// Nothing here is what makes these actions his: every one is an RPC that
// checks, in the database, that the caller is the organizer.
import { type Href, useRouter } from 'expo-router';
import { Children, type ReactNode, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { EventCtx, Person } from '@/components/event/context';
import { ShowtimeLine } from '@/components/event/member-sections';
import { eventTitle } from '@/components/event-card';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { DateTimeField } from '@/components/ui/datetime-field';
import { Choices, Fact, Row, ScoreField, Sheet, useAction } from '@/components/ui/kit';
import { StatusBadge } from '@/components/ui/status-badge';
import { TextField } from '@/components/ui/text-field';
import { MONO_FONT, Spacing } from '@/constants/theme';
import { actions, issueInvite, listTheaters, owner, type ShowtimeInput } from '@/lib/api';
import { confirmAction, shareText, showAlert } from '@/lib/dialogs';
import { CONFIRMATION_LABEL, dayTime, FORMAT_LABEL, isInviteCodeComplete, memberName, money, parseMoney, parseScore, score, weekdayTime } from '@/lib/format';
import { removeEventFiles } from '@/lib/images';
import { inviteMessage } from '@/lib/links';
import { useSession } from '@/lib/session';
import { isPast, ownerNextStep } from '@/lib/stage';
import type { ConfirmationStatus, RsvpStatus, Showtime, ShowtimeFormat, Theater } from '@/lib/types';

const HOUR = 3_600_000;
const FORMATS = (Object.keys(FORMAT_LABEL) as ShowtimeFormat[]).map((value) => ({ value, label: FORMAT_LABEL[value] }));

/** The organizer's buttons in an even two-column grid, so a ragged handful reads as one set of controls. */
function Actions({ children }: { children: ReactNode }) {
  return (
    <View style={styles.actions}>
      {Children.toArray(children).map((child, index) => (
        <View key={index} style={styles.action}>
          {child}
        </View>
      ))}
    </View>
  );
}

type ShowtimeMode = { kind: 'add' } | { kind: 'edit'; showtime: Showtime } | { kind: 'correct'; showtime: Showtime } | { kind: 'reschedule'; showtime: Showtime };

export function OwnerPanel({ ctx, person, onClosePerson }: { ctx: EventCtx; person: Person | null; onClosePerson: () => void }) {
  const router = useRouter();
  const { event, showtimes, voting, charges } = ctx.bundle;
  const { busy, run } = useAction(ctx.refresh);
  const [showtimeSheet, setShowtimeSheet] = useState<ShowtimeMode | null>(null);
  const [selecting, setSelecting] = useState<Showtime | null>(null);
  const [editing, setEditing] = useState(false);
  const [tickets, setTickets] = useState(false);
  const [answering, setAnswering] = useState(false);

  const active = showtimes.filter((showtime) => !showtime.removed_at);
  const selected = showtimes.find((showtime) => showtime.id === event.selected_showtime_id);
  const coming = ctx.people.filter((p) => p.participant.rsvp_status === 'going' || p.participant.rsvp_status === 'maybe');
  const unpaid = charges.filter((charge) => charge.status === 'unpaid');
  const next = ownerNextStep(event, {
    activeShowtimes: active.length,
    eligible: voting.eligible,
    voted: voting.voted,
    pendingConfirmations: coming.filter((p) => p.participant.confirmation_status === null).length,
    unpaid: unpaid.length,
  });
  const byParticipant = new Map(ctx.people.map((p) => [p.participant.id, p]));
  const canList = (showtimeId: string) =>
    (voting.matrix ?? []).filter((row) => row.current && row.showtime_ids.includes(showtimeId)).map((row) => byParticipant.get(row.participant_id)?.name ?? '?');

  const deleteEvent = () =>
    confirmAction({
      title: `Delete ${eventTitle(event)}?`,
      message: 'For a movie night that will not happen. The event and everything on it (RSVPs, votes, charges, scores, photos) is removed for good.',
      confirmLabel: 'Delete event',
      destructive: true,
      onConfirm: async () => {
        try {
          const paths = await owner.deleteEvent(event.id);
          void removeEventFiles(paths).catch(() => {});
          router.replace('/(tabs)' as Href);
        } catch {
          showAlert('That did not work', 'The event was not deleted. Try again.');
        }
      },
    });

  return (
    <Card elevated={next !== null}>
      <CardTitle kicker="Organizer" title={next ?? 'Nothing needs you right now'} icon="construct-outline" />

      {!selected && !event.ended_at && (
        <View style={styles.block}>
          {active.map((showtime) => {
            const names = canList(showtime.id);
            return (
              <View key={showtime.id} style={styles.block}>
                <View style={styles.rowLine}>
                  <ShowtimeLine showtime={showtime} />
                  <StatusBadge label={`${names.length} can`} tone={names.length > 0 ? 'success' : 'muted'} />
                </View>
                {names.length > 0 && <ThemedText type="small" themeColor="textSecondary">{names.join(', ')}</ThemedText>}
                <View style={styles.buttons}>
                  <Button title="Select" size="sm" onPress={() => setSelecting(showtime)} />
                  {voting.open && <Button title="Edit" size="sm" variant="secondary" onPress={() => setShowtimeSheet({ kind: 'edit', showtime })} />}
                  {voting.open && (
                    <Button
                      title="Remove"
                      size="sm"
                      variant="secondary"
                      loading={busy === `remove:${showtime.id}`}
                      onPress={() => run(`remove:${showtime.id}`, () => owner.removeShowtime(showtime.id))}
                    />
                  )}
                </View>
              </View>
            );
          })}
          <Actions>
            {(voting.open || active.length === 0) && <Button title="Add showtime" size="sm" icon="add" variant="secondary" onPress={() => setShowtimeSheet({ kind: 'add' })} />}
            {voting.open && <Button title="Close voting" size="sm" variant="secondary" loading={busy === 'close'} onPress={() => run('close', () => owner.closeVoting(event.id))} />}
            {!voting.open && event.voting_closed_at && (
              <Button title="Reopen voting" size="sm" variant="secondary" loading={busy === 'reopen'} onPress={() => run('reopen', () => owner.reopenVoting(event.id))} />
            )}
          </Actions>
        </View>
      )}

      {selected && !event.ended_at && (
        <Actions>
          {!event.tickets_purchased_at && <Button title="Tickets bought" size="sm" icon="ticket-outline" onPress={() => setTickets(true)} />}
          {event.tickets_purchased_at && <Button title="Check-in" size="sm" icon="scan-outline" onPress={() => router.push(`/check-in/${event.id}` as Href)} />}
          {event.tickets_purchased_at && <Button title="Fix the cost" size="sm" variant="secondary" onPress={() => setTickets(true)} />}
          <Button title="Fix theater or format" size="sm" variant="secondary" onPress={() => setShowtimeSheet({ kind: 'correct', showtime: selected })} />
          {!event.tickets_purchased_at && <Button title="Reschedule" size="sm" variant="secondary" onPress={() => setShowtimeSheet({ kind: 'reschedule', showtime: selected })} />}
          {!event.tickets_purchased_at && <Button title="Check-in" size="sm" variant="secondary" onPress={() => router.push(`/check-in/${event.id}` as Href)} />}
          <Button
            title="End the night"
            size="sm"
            variant="secondary"
            loading={busy === 'end'}
            onPress={() => {
              // Nothing stops Dino ending it early (a showtime entered wrong, a
              // night called off), but it should never happen by a stray tap.
              const early = new Date(selected.starts_at).getTime() > Date.now();
              confirmAction({
                title: early ? 'The movie has not started yet. End the night anyway?' : 'End the night?',
                message:
                  (early ? `The showtime is ${dayTime(selected.starts_at)}. ` : '') +
                  'Opens rating for everyone you checked in. Ratings lock 48 hours from now, and then this moves to Past.',
                confirmLabel: 'End the night',
                destructive: early,
                onConfirm: () => void run('end', () => owner.endEvent(event.id)),
              });
            }}
          />
        </Actions>
      )}

      {event.ended_at && (
        <Actions>
          <Button title="Check-in list" size="sm" variant="secondary" onPress={() => router.push(`/check-in/${event.id}` as Href)} />
          {!isPast(event) && <Button title="Not over yet (undo)" size="sm" variant="secondary" loading={busy === 'unend'} onPress={() => run('unend', () => owner.reopenEvent(event.id))} />}
        </Actions>
      )}

      {charges.length > 0 && (
        <View style={styles.block}>
          <ThemedText type="smallBold">
            Payments · {money(charges.reduce((sum, c) => sum + c.amount_cents, 0))} total · {unpaid.length === 0 ? 'all paid' : `${unpaid.length} unpaid`}
          </ThemedText>
          {/* Once the night is over and everyone has paid, the list is just noise: a payment can still be changed from the person's row. */}
          {ctx.people
            .filter((p) => p.charge && !(event.ended_at && unpaid.length === 0))
            .map((p) => (
              <Row
                key={p.participant.id}
                title={p.name}
                subtitle={`${money(p.charge!.amount_cents)}${p.note ? ` · ${p.note}` : ''}`}
                right={
                  <Button
                    title={p.charge!.status === 'paid' ? 'Paid' : 'Mark paid'}
                    size="sm"
                    variant={p.charge!.status === 'paid' ? 'secondary' : 'primary'}
                    icon={p.charge!.status === 'paid' ? 'checkmark' : undefined}
                    loading={busy === `paid:${p.charge!.id}`}
                    onPress={() => run(`paid:${p.charge!.id}`, () => owner.setChargePaid(p.charge!.id, p.charge!.status !== 'paid'))}
                  />
                }
              />
            ))}
        </View>
      )}

      <Actions>
        <Button title="Edit details" size="sm" variant="secondary" icon="create-outline" onPress={() => setEditing(true)} />
        {!event.ended_at && <Button title="Answer for someone" size="sm" variant="secondary" icon="person-outline" onPress={() => setAnswering(true)} />}
        <Button title="Delete event" size="sm" variant="destructiveOutline" onPress={deleteEvent} />
      </Actions>
      <ThemedText type="small" themeColor="textSecondary">{event.ended_at ? 'Tap anyone under How it went to correct their scores or charge.' : "Tap anyone under Who's coming to change their answers, scores, or charge."}</ThemedText>

      <ShowtimeSheet ctx={ctx} mode={showtimeSheet} onClose={() => setShowtimeSheet(null)} />
      <SelectSheet ctx={ctx} showtime={selecting} onClose={() => setSelecting(null)} />
      <EditSheet ctx={ctx} visible={editing} onClose={() => setEditing(false)} />
      <TicketsSheet ctx={ctx} visible={tickets} onClose={() => setTickets(false)} attending={coming.filter((p) => p.participant.confirmation_status === 'attending').length} />
      <AnswerSheet ctx={ctx} visible={answering} onClose={() => setAnswering(false)} />
      <PersonSheet ctx={ctx} person={person} onClose={onClosePerson} />
    </Card>
  );
}

/** A sensible default: two days before the showtime, but never in the past or after it. */
function defaultDeadline(startsAt: Date): Date {
  const earliest = Date.now() + HOUR;
  const wanted = startsAt.getTime() - 48 * HOUR;
  return new Date(Math.min(Math.max(wanted, earliest), startsAt.getTime() - 60_000));
}

function ShowtimeSheet({ ctx, mode, onClose }: { ctx: EventCtx; mode: ShowtimeMode | null; onClose: () => void }) {
  const [theaters, setTheaters] = useState<Theater[]>([]);
  const [theaterId, setTheaterId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [startsAt, setStartsAt] = useState(new Date(Date.now() + 7 * 24 * HOUR));
  const [format, setFormat] = useState<ShowtimeFormat>('standard');
  const [formatOther, setFormatOther] = useState('');
  const [deadline, setDeadline] = useState(new Date(Date.now() + 5 * 24 * HOUR));
  const { busy, run } = useAction(ctx.refresh);

  useEffect(() => {
    if (!mode) return;
    listTheaters().then(setTheaters).catch(() => {});
    setNewName('');
    setNewAddress('');
    if (mode.kind === 'add') {
      setFormat('standard');
      setFormatOther('');
    } else {
      setTheaterId(mode.showtime.theater_id);
      setFormat(mode.showtime.format);
      setFormatOther(mode.showtime.format_other ?? '');
      const start = mode.kind === 'reschedule' ? new Date(new Date(mode.showtime.starts_at).getTime() + 24 * HOUR) : new Date(mode.showtime.starts_at);
      setStartsAt(start);
      setDeadline(defaultDeadline(start));
    }
  }, [mode]);

  if (!mode) return <Sheet visible={false} title="" onClose={onClose}>{null}</Sheet>;
  const title = { add: 'Add a showtime', edit: 'Edit showtime', correct: 'Fix theater or format', reschedule: 'Reschedule' }[mode.kind];

  const save = () =>
    run('save', async () => {
      const theater = theaterId ?? (await owner.saveTheater(null, newName.trim(), newAddress.trim()));
      const input: ShowtimeInput = { theaterId: theater, startsAt: startsAt.toISOString(), format, formatOther: format === 'other' ? formatOther.trim() : null };
      if (mode.kind === 'add') await owner.addShowtime(ctx.bundle.event.id, input);
      else if (mode.kind === 'reschedule') await owner.reschedule(ctx.bundle.event.id, input, deadline.toISOString());
      else await owner.updateShowtime(mode.showtime.id, mode.kind === 'correct' ? { ...input, startsAt: mode.showtime.starts_at } : input);
      onClose();
    });

  return (
    <Sheet visible title={title} onClose={onClose}>
      {mode.kind === 'reschedule' && (
        <Fact icon="alert-circle-outline" tone="warning" text="Everyone is asked to confirm again, with a new deadline. Their earlier answers stay visible to you. Predictions go on hold until they re-confirm." />
      )}
      {mode.kind === 'edit' && <Fact icon="alert-circle-outline" tone="warning" text="Changing a showtime asks everyone to review and vote again." />}
      {mode.kind === 'correct' && <Fact icon="information-circle-outline" text="Same date and time, so nobody has to confirm again." />}

      <ThemedText type="smallBold">Theater</ThemedText>
      <View style={styles.buttons}>
        {theaters.map((theater) => (
          <Chip key={theater.id} label={theater.name} selected={theaterId === theater.id} onPress={() => setTheaterId(theater.id)} />
        ))}
        <Chip label="New theater" selected={theaterId === null} onPress={() => setTheaterId(null)} />
      </View>
      {theaterId === null && (
        <>
          <TextField label="Theater name" value={newName} onChangeText={setNewName} autoCapitalize="words" placeholder="Cinemark Downtown" />
          <TextField label="Address (optional)" value={newAddress} onChangeText={setNewAddress} placeholder="For maps and the calendar entry" />
        </>
      )}

      {mode.kind !== 'correct' && <DateTimeField label="Date and time" value={startsAt} onChange={setStartsAt} />}
      <ThemedText type="smallBold">Format</ThemedText>
      <Choices<ShowtimeFormat> options={FORMATS} value={format} onChange={setFormat} />
      {format === 'other' && <TextField label="Which format?" value={formatOther} onChangeText={setFormatOther} placeholder="70mm" maxLength={40} />}
      {mode.kind === 'reschedule' && <DateTimeField label="Confirm by" value={deadline} onChange={setDeadline} hint="When everyone has to re-confirm by." />}

      <Button title="Save" onPress={save} loading={busy === 'save'} disabled={(theaterId === null && !newName.trim()) || (format === 'other' && !formatOther.trim())} />
    </Sheet>
  );
}

function SelectSheet({ ctx, showtime, onClose }: { ctx: EventCtx; showtime: Showtime | null; onClose: () => void }) {
  const [deadline, setDeadline] = useState(new Date());
  const { busy, run } = useAction(ctx.refresh);
  const { event, voting } = ctx.bundle;

  useEffect(() => {
    if (showtime) setDeadline(defaultDeadline(new Date(showtime.starts_at)));
  }, [showtime]);

  if (!showtime) return <Sheet visible={false} title="" onClose={onClose}>{null}</Sheet>;
  const stillOpen = new Date(event.rsvp_deadline).getTime() > Date.now();

  return (
    <Sheet visible title="Select this showtime" onClose={onClose}>
      <ShowtimeLine showtime={showtime} />
      <DateTimeField label="Confirm by" value={deadline} onChange={setDeadline} hint="Everyone Going or Maybe confirms by then. No answer means Not Attending." />
      <Fact
        icon="information-circle-outline"
        text={[
          stillOpen ? 'RSVP closes now, and anyone who has not answered counts as Can\'t Go.' : null,
          voting.voted < voting.eligible ? `${voting.eligible - voting.voted} have not voted; voting closes anyway.` : 'Voting closes.',
          'Everyone coming is asked to confirm and gets a notification.',
        ]
          .filter(Boolean)
          .join(' ')}
      />
      <Button
        title="Select and notify"
        loading={busy === 'select'}
        onPress={async () => {
          if (await run('select', () => owner.selectShowtime(event.id, showtime.id, deadline.toISOString()))) onClose();
        }}
      />
    </Sheet>
  );
}

function EditSheet({ ctx, visible, onClose }: { ctx: EventCtx; visible: boolean; onClose: () => void }) {
  const { event } = ctx.bundle;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [deadline, setDeadline] = useState(new Date());
  const { busy, run } = useAction(ctx.refresh);
  const canMoveDeadline = !event.selected_showtime_id && !event.ended_at;

  useEffect(() => {
    if (!visible) return;
    setTitle(event.title_override ?? '');
    setDescription(event.description_override ?? '');
    setNote(event.owner_note ?? '');
    setDeadline(new Date(event.rsvp_deadline));
  }, [visible, event]);

  const save = async () => {
    const patch: Record<string, unknown> = { title_override: title, description_override: description, owner_note: note };
    if (canMoveDeadline && deadline.toISOString() !== new Date(event.rsvp_deadline).toISOString()) patch.rsvp_deadline = deadline.toISOString();
    if (await run('save', () => owner.updateEvent(event.id, patch))) onClose();
  };

  return (
    <Sheet visible={visible} title="Edit details" onClose={onClose}>
      <TextField label="Title (leave empty to use the movie's)" value={title} onChangeText={setTitle} placeholder={event.movie.title} maxLength={200} />
      <TextField label="Description (leave empty to use TMDB's)" value={description} onChangeText={setDescription} multiline maxLength={4000} />
      <TextField label="Dino's Note" value={note} onChangeText={setNote} multiline maxLength={2000} placeholder="Anything the group should know." />
      {canMoveDeadline && <DateTimeField label="RSVP deadline" value={deadline} onChange={setDeadline} />}
      <Button title="Save" onPress={save} loading={busy === 'save'} />
    </Sheet>
  );
}

function TicketsSheet({ ctx, visible, onClose, attending }: { ctx: EventCtx; visible: boolean; onClose: () => void; attending: number }) {
  const { event } = ctx.bundle;
  const [amount, setAmount] = useState('');
  const { busy, run } = useAction(ctx.refresh);
  const bought = event.tickets_purchased_at !== null;
  const cents = parseMoney(amount);

  useEffect(() => {
    if (visible) setAmount(event.total_cost_cents !== null ? (event.total_cost_cents / 100).toFixed(2) : '');
  }, [visible, event.total_cost_cents]);

  const save = async () => {
    if (cents === null) return;
    if (await run('save', () => (bought ? owner.updateTicketCost(event.id, cents) : owner.recordTickets(event.id, cents)))) onClose();
  };

  return (
    <Sheet visible={visible} title={bought ? 'Fix the ticket cost' : 'Tickets bought'} onClose={onClose}>
      <TextField label="Total you paid" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="64.00" error={amount && cents === null ? 'Enter an amount like 64 or 64.50.' : undefined} />
      <Fact
        icon="information-circle-outline"
        text={
          bought
            ? 'Splits the new total evenly across the existing charges (replacing any amounts you set by hand). Who has paid is kept.'
            : `Split evenly across the ${attending} confirmed (guests included, your own ticket too, recorded as paid). Confirmations lock, and anyone who has not answered becomes Not Attending. Everyone who owes gets a notification without the amount.`
        }
      />
      {cents !== null && !bought && attending > 0 && <ThemedText type="smallBold">About {money(Math.ceil(cents / attending))} each.</ThemedText>}
      <Button title={bought ? 'Update and re-split' : 'Record and split'} onPress={save} loading={busy === 'save'} disabled={cents === null} />
    </Sheet>
  );
}

/** For members with no answer on file, or to change anyone's RSVP. */
function AnswerSheet({ ctx, visible, onClose }: { ctx: EventCtx; visible: boolean; onClose: () => void }) {
  const { members } = useSession();
  const { busy, run } = useAction(ctx.refresh);
  const answered = new Map(ctx.people.filter((p) => p.member).map((p) => [p.member!.id, p.participant.rsvp_status]));

  return (
    <Sheet visible={visible} title="Answer for someone" onClose={onClose}>
      <ThemedText type="small" themeColor="textSecondary">{"Sets a member's RSVP, at any time. Each change is logged."}</ThemedText>
      {members
        .filter((member) => member.status === 'active')
        .map((member) => (
          <View key={member.id} style={styles.block}>
            <ThemedText type="smallBold">{memberName(member)}</ThemedText>
            <Choices<RsvpStatus>
              options={[{ value: 'going', label: 'Going' }, { value: 'maybe', label: 'Maybe' }, { value: 'cant_go', label: "Can't Go" }]}
              value={answered.get(member.id) ?? null}
              disabled={busy !== null}
              onChange={(status) => run(member.id, () => actions.setRsvp(ctx.bundle.event.id, status, member.id))}
            />
          </View>
        ))}
    </Sheet>
  );
}

/** Everything Dino can change about one person on this night. */
function PersonSheet({ ctx, person, onClose }: { ctx: EventCtx; person: Person | null; onClose: () => void }) {
  const { event, showtimes, voting } = ctx.bundle;
  const { busy, run } = useAction(ctx.refresh);
  const [prediction, setPrediction] = useState('');
  const [rating, setRating] = useState('');
  const [amount, setAmount] = useState('');
  const [picks, setPicks] = useState<string[]>([]);
  const [guestName, setGuestName] = useState('');
  const [prior, setPrior] = useState<string | null>(null);
  // A guest being made a member, and the invite code that came of it.
  const [promoting, setPromoting] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);

  const id = person?.participant.id;
  useEffect(() => {
    if (!person) return;
    setPrediction(person.prediction !== undefined ? score(person.prediction) : '');
    setRating(person.rating !== undefined ? score(person.rating) : '');
    setAmount(person.charge ? (person.charge.amount_cents / 100).toFixed(2) : '');
    setPicks(voting.matrix?.find((row) => row.participant_id === person.participant.id)?.showtime_ids ?? []);
    setGuestName('');
    setPrior(null);
    setPromoting(false);
    setIssued(null);
    if (event.schedule_revision > 1) {
      owner.roster(event.id).then((roster) => setPrior(roster.find((row) => row.participant_id === person.participant.id)?.prior_confirmation_status ?? null)).catch(() => {});
    }
    // Reset the form only when a different person is opened, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!person || !id) return <Sheet visible={false} title="" onClose={onClose}>{null}</Sheet>;

  const p = person.participant;
  const coming = p.rsvp_status === 'going' || p.rsvp_status === 'maybe';
  const selected = event.selected_showtime_id !== null;
  const active = showtimes.filter((showtime) => !showtime.removed_at);
  const predictionValue = parseScore(prediction);
  const ratingValue = parseScore(rating);
  const cents = parseMoney(amount);

  if (issued) {
    return (
      <Sheet visible title={`Invite for ${issued.name}`} onClose={() => setIssued(null)}>
        <ThemedText themeColor="textSecondary">
          {issued.name} is a member now, and this night is part of their history. Give them this code privately. It works once, expires in {issued.custom ? '48 hours' : '14 days'}, and is shown only now.
        </ThemedText>
        <ThemedText selectable style={styles.code}>
          {issued.code}
        </ThemedText>
        <Button title="Share the invite" icon="share-outline" onPress={() => void shareText(inviteMessage(issued.name, issued.code, issued.custom))} />
        <Button title="Done" variant="secondary" onPress={() => setIssued(null)} />
      </Sheet>
    );
  }

  if (promoting && person.guest) {
    return (
      <PromoteSheet
        ctx={ctx}
        person={person}
        onBack={() => setPromoting(false)}
        onDone={(invite) => {
          setPromoting(false);
          setIssued(invite);
        }}
      />
    );
  }

  return (
    <Sheet visible title={person.name} onClose={onClose}>
      {person.note && <ThemedText type="small" themeColor="textSecondary">{person.note}</ThemedText>}

      {person.guest && (
        <>
          <ThemedText type="smallBold">Joined the club?</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Make this guest a member. This night becomes part of their own history, with their prediction, check-in and ticket.
          </ThemedText>
          <Button title="Make them a member" size="sm" variant="secondary" icon="person-add-outline" onPress={() => setPromoting(true)} />
        </>
      )}

      {!event.ended_at && (
        <>
          <ThemedText type="smallBold">RSVP</ThemedText>
          {person.guest ? (
            <>
              <Choices<'going' | 'maybe'>
                options={[{ value: 'going', label: 'Going' }, { value: 'maybe', label: 'Maybe' }]}
                value={coming ? (p.rsvp_status as 'going' | 'maybe') : null}
                disabled={busy !== null}
                onChange={(status) => run('rsvp', () => actions.updateGuest(person.guest!.id, person.name, status))}
              />
              <Button
                title="Remove this guest"
                size="sm"
                variant="destructiveOutline"
                onPress={() =>
                  confirmAction({
                    title: `Remove ${person.name}?`,
                    message: 'Removes the guest and anything recorded for them on this night, including their charge.',
                    confirmLabel: 'Remove',
                    destructive: true,
                    onConfirm: async () => {
                      if (await run('remove', () => actions.removeGuest(person.guest!.id))) onClose();
                    },
                  })
                }
              />
            </>
          ) : (
            <Choices<RsvpStatus>
              options={[{ value: 'going', label: 'Going' }, { value: 'maybe', label: 'Maybe' }, { value: 'cant_go', label: "Can't Go" }]}
              value={p.rsvp_status}
              disabled={busy !== null}
              onChange={(status) => run('rsvp', () => actions.setRsvp(event.id, status, person.member!.id))}
            />
          )}
        </>
      )}

      {!selected && coming && active.length > 0 && !event.ended_at && (
        <>
          <ThemedText type="smallBold">Showtimes that work for them</ThemedText>
          <View style={styles.buttons}>
            {active.map((showtime) => (
              <Chip
                key={showtime.id}
                label={weekdayTime(showtime.starts_at)}
                selected={picks.includes(showtime.id)}
                onPress={() => setPicks(picks.includes(showtime.id) ? picks.filter((x) => x !== showtime.id) : [...picks, showtime.id])}
              />
            ))}
          </View>
          <Button title={picks.length === 0 ? 'Record: none work' : 'Record their availability'} size="sm" variant="secondary" loading={busy === 'ballot'} onPress={() => run('ballot', () => actions.submitBallot(id, picks))} />
        </>
      )}

      {selected && coming && !event.ended_at && (
        <>
          <ThemedText type="smallBold">Confirmation</ThemedText>
          <Choices<ConfirmationStatus>
            options={[{ value: 'attending', label: 'Confirmed' }, { value: 'not_attending', label: "Can't Make It" }]}
            value={p.confirmation_status}
            disabled={busy !== null}
            onChange={(status) => run('confirm', () => actions.setConfirmation(id, status))}
          />
          {prior && <ThemedText type="small" themeColor="textSecondary">Before the reschedule: {CONFIRMATION_LABEL[prior as ConfirmationStatus]}.</ThemedText>}
        </>
      )}

      {selected && (
        <>
          <ThemedText type="smallBold">Check-in</ThemedText>
          {p.checked_in_at ? (
            <Button title="Undo check-in" size="sm" variant="secondary" loading={busy === 'checkin'} onPress={() => run('checkin', () => owner.undoCheckIn(id))} />
          ) : (
            <Button title="Check in" size="sm" variant="secondary" loading={busy === 'checkin'} onPress={() => run('checkin', () => owner.checkIn(id, null))} />
          )}
        </>
      )}

      {selected && (
        <>
          <ScoreField label="Prediction (correction, logged)" value={prediction} onChangeText={setPrediction} />
          <Button title="Set prediction" size="sm" variant="secondary" disabled={predictionValue === null || predictionValue === person.prediction} loading={busy === 'prediction'} onPress={() => run('prediction', () => owner.setPrediction(id, predictionValue!))} />
        </>
      )}

      {p.checked_in_at && (
        <>
          <ScoreField label="Rating (correction, logged)" value={rating} onChangeText={setRating} />
          <Button title="Set rating" size="sm" variant="secondary" disabled={ratingValue === null || ratingValue === person.rating} loading={busy === 'rating'} onPress={() => run('rating', () => owner.setRating(id, ratingValue!))} />
        </>
      )}

      {person.charge && (
        <>
          <TextField label="Their charge" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={amount && cents === null ? 'Enter an amount like 16 or 16.50.' : undefined} />
          <View style={styles.buttons}>
            <Button title="Set amount" size="sm" variant="secondary" disabled={cents === null || cents === person.charge.amount_cents} loading={busy === 'amount'} onPress={() => run('amount', () => owner.setChargeAmount(person.charge!.id, cents!))} />
            <Button title={person.charge.status === 'paid' ? 'Mark unpaid' : 'Mark paid'} size="sm" loading={busy === 'paid'} onPress={() => run('paid', () => owner.setChargePaid(person.charge!.id, person.charge!.status !== 'paid'))} />
            <Button
              title="Remove charge"
              size="sm"
              variant="destructiveOutline"
              onPress={() =>
                confirmAction({
                  title: 'Remove this charge?',
                  message: 'For someone you are letting off. They stay on the list.',
                  confirmLabel: 'Remove',
                  destructive: true,
                  onConfirm: () => void run('uncharge', () => owner.deleteCharge(person.charge!.id)),
                })
              }
            />
          </View>
        </>
      )}

      {person.member && coming && !event.ended_at && (
        <>
          <TextField label="Add a guest for them" value={guestName} onChangeText={setGuestName} placeholder="Guest's name" maxLength={60} autoCapitalize="words" />
          <Button
            title="Add guest"
            size="sm"
            variant="secondary"
            disabled={!guestName.trim()}
            loading={busy === 'guest'}
            onPress={async () => {
              if (await run('guest', () => actions.addGuest(event.id, guestName.trim(), 'going', person.member!.id))) setGuestName('');
            }}
          />
        </>
      )}
    </Sheet>
  );
}

interface Issued {
  name: string;
  code: string;
  custom: boolean;
}

/**
 * Turns a guest into a member: either a brand-new member (who gets an invite
 * code) or someone who already is one. Either way the guest's place on this
 * night becomes the member's own.
 */
function PromoteSheet({ ctx, person, onBack, onDone }: { ctx: EventCtx; person: Person; onBack: () => void; onDone: (invite: Issued | null) => void }) {
  const { members, refresh: refreshSession } = useSession();
  // The roster on this page is named from the member list, so that is reloaded first.
  const { busy, run } = useAction(async () => {
    await refreshSession();
    await ctx.refresh();
  });
  const words = person.name.trim().split(/\s+/);
  const [kind, setKind] = useState<'new' | 'existing'>('new');
  const [first, setFirst] = useState(words[0] ?? '');
  const [initial, setInitial] = useState((words[1] ?? '').replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase());
  const [custom, setCustom] = useState('');
  const [memberId, setMemberId] = useState<string | null>(null);

  // Someone already on this night cannot take the guest's place as well.
  const here = new Set(ctx.bundle.participants.map((participant) => participant.member_id));
  const candidates = members.filter((member) => member.status === 'active' && !here.has(member.id));
  const customOk = custom.trim() === '' || isInviteCodeComplete(custom);
  const guestId = person.guest!.id;

  const create = async () => {
    let invite: Issued | null = null;
    const ok = await run('promote', async () => {
      const made = await issueInvite({ action: 'create_member', first_name: first.trim(), last_initial: initial, custom_code: custom.trim() || undefined });
      invite = { name: `${first.trim()} ${initial}.`, code: made.inviteCode, custom: custom.trim() !== '' };
      await owner.promoteGuest(guestId, made.memberId);
    });
    // If the member was made but the night could not be moved, the code is still shown: it is the only time it can be.
    if (ok || invite) onDone(invite);
  };
  const move = async () => {
    if (await run('promote', () => owner.promoteGuest(guestId, memberId!))) onDone(null);
  };

  return (
    <Sheet visible title={`Make ${person.name} a member`} onClose={onBack}>
      <Choices<'new' | 'existing'>
        options={[
          { value: 'new', label: 'New member' },
          { value: 'existing', label: 'Already a member' },
        ]}
        value={kind}
        onChange={setKind}
      />

      {kind === 'new' ? (
        <>
          <TextField label="First name" value={first} onChangeText={setFirst} autoCapitalize="words" maxLength={40} />
          <TextField label="Last initial" value={initial} onChangeText={(text) => setInitial(text.replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase())} autoCapitalize="characters" maxLength={1} />
          <TextField
            label="Custom invite code (optional)"
            value={custom}
            onChangeText={(text) => setCustom(text.slice(0, 64))}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Leave empty for a random code"
            error={customOk ? undefined : 'Needs 12 to 32 letters and numbers. Spaces and dashes do not count.'}
          />
          <ThemedText type="small" themeColor="textSecondary">
            Creates the member and their invite code, and makes this night theirs.
          </ThemedText>
          <Button title="Create member" icon="person-add-outline" onPress={create} loading={busy === 'promote'} disabled={!first.trim() || initial.length !== 1 || !customOk} />
        </>
      ) : candidates.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          Every member already has their own place on this night.
        </ThemedText>
      ) : (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            Who is {person.name}? This night moves to them. Members already on this night are not listed.
          </ThemedText>
          <View style={styles.buttons}>
            {candidates.map((member) => (
              <Chip key={member.id} label={memberName(member)} selected={memberId === member.id} onPress={() => setMemberId(member.id)} />
            ))}
          </View>
          <Button title="Make this night theirs" onPress={move} loading={busy === 'promote'} disabled={!memberId} />
        </>
      )}
      <Button title="Back" variant="secondary" onPress={onBack} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: MONO_FONT, fontSize: 24, lineHeight: 34, letterSpacing: 2, textAlign: 'center', paddingVertical: Spacing.three },
  block: { gap: Spacing.two },
  buttons: { flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap' },
  action: { flexGrow: 1, flexBasis: '46%' },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
