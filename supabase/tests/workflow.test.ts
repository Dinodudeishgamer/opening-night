// The night itself: voting, selection, confirmation, reschedule, tickets and
// payments, predictions, check-in, ratings, Past.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import {
  addMember, addShowtime, club, createDb, inDays, inTx, makeEvent, makeTheater, night, participantOf, passRsvpDeadline,
  type Club, type Night, type Tx,
} from './harness.ts';

let pg: PGlite;
before(async () => {
  pg = await createDb();
});

const ballot = (t: Tx, uid: string, participant: string, ids: string[]) =>
  t.rpc(uid, 'submit_ballot', { p_participant_id: participant, p_showtime_ids: ids });
const eventRow = async (t: Tx, event: string) => (await t.sql(`select * from public.events where id = $1`, [event]))[0];

interface Parts {
  dino: string;
  alice: string;
  bob: string;
}
async function parts(t: Tx, c: Club, n: Night): Promise<Parts> {
  return {
    dino: await participantOf(t, n.event, { member: c.owner.id }),
    alice: await participantOf(t, n.event, { member: c.alice.id }),
    bob: await participantOf(t, n.event, { member: c.bob.id }),
  };
}

/** night() with the early showtime selected. */
async function selected(t: Tx, c: Club): Promise<Night & Parts> {
  const n = await night(t, c);
  await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
  return { ...n, ...(await parts(t, c, n)) };
}

/** selected() with Dino and Alice confirmed, Bob not. */
async function confirmed(t: Tx, c: Club): Promise<Night & Parts> {
  const s = await selected(t, c);
  await t.rpc(c.owner.uid, 'set_confirmation', { p_participant_id: s.dino, p_status: 'attending' });
  await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: s.alice, p_status: 'attending' });
  await t.rpc(c.bob.uid, 'set_confirmation', { p_participant_id: s.bob, p_status: 'not_attending' });
  return s;
}

// --- showtimes and voting ---------------------------------------------------

test('showtimes are Dino\'s; formats are validated', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const event = await makeEvent(t, c);
    const theater = await makeTheater(t, c);
    const args = { p_event_id: event, p_theater_id: theater, p_starts_at: inDays(9) };
    await t.rpcFails(c.alice.uid, 'add_showtime', args, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'add_showtime', { ...args, p_format: 'smellovision' }, /Format is/);
    await t.rpcFails(c.owner.uid, 'add_showtime', { ...args, p_format: 'other' }, /other format/);
    await t.rpcFails(c.owner.uid, 'add_showtime', { ...args, p_starts_at: inDays(-1) }, /in the past/);
    for (const format of ['standard', 'imax', 'xd', 'dolby', '3d']) {
      await t.rpc(c.owner.uid, 'add_showtime', { ...args, p_format: format });
    }
    await t.rpc(c.owner.uid, 'add_showtime', { ...args, p_format: 'other', p_format_other: '70mm' });
    await t.rpcFails(c.owner.uid, 'add_showtime', args, /showtimes_active_slot_key/);
    assert.equal((await eventRow(t, event)).voting_revision, 6);
    await t.fails(c.alice.uid, `insert into public.showtimes (event_id, theater_id, starts_at) values ($1, $2, now())`, [event, theater], /permission denied/);
  }));

test('voting runs while RSVP is open; every working showtime, empty counts as voted', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    const carol = await participantOf(t, n.event, { member: c.carol.id });

    await ballot(t, c.alice.uid, p.alice, [n.early, n.late]);
    await ballot(t, c.bob.uid, p.bob, []);
    await t.rpcFails(c.carol.uid, 'submit_ballot', { p_participant_id: carol, p_showtime_ids: [n.early] }, /Only Going and Maybe/);
    await t.rpcFails(c.bob.uid, 'submit_ballot', { p_participant_id: p.alice, p_showtime_ids: [] }, /Only the organizer/);
    const guestOfAlice = await participantOf(t, n.event, { guest: await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gus', p_status: 'maybe' }) });
    await t.rpcFails(c.bob.uid, 'submit_ballot', { p_participant_id: guestOfAlice, p_showtime_ids: [] }, /Only the organizer/);
    await t.rpc(c.alice.uid, 'remove_guest', { p_guest_id: await t.val('postgres', 'select guest_id from public.event_participants where id = $1', [guestOfAlice]) });
    await t.rpcFails(c.alice.uid, 'submit_ballot', { p_participant_id: p.alice, p_showtime_ids: [n.event] }, /showtimes changed/);

    const v = await t.rpc(c.alice.uid, 'get_voting', { p_event_id: n.event });
    assert.equal(v.open, true);
    assert.equal(v.eligible, 3);
    assert.equal(v.voted, 2);
    assert.deepEqual(v.counts.map((x: any) => x.available), [1, 1]);
    assert.equal(v.matrix, null);
    assert.equal(v.mine.length, 1);
    assert.deepEqual(new Set(v.mine[0].showtime_ids), new Set([n.early, n.late]));

    // Everyone voted, but RSVP is still open: voting stays open.
    await ballot(t, c.owner.uid, p.dino, [n.late]);
    assert.equal((await eventRow(t, n.event)).voting_closed_at, null);
  }));

test('raw availability is hidden from members; Dino reads the matrix', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    await ballot(t, c.alice.uid, p.alice, [n.early]);
    await t.fails(c.bob.uid, `select * from public.showtime_availability`, [], /permission denied/);
    await t.fails(c.bob.uid, `select * from public.showtime_ballots`, [], /permission denied/);
    await t.fails(c.owner.uid, `select * from public.showtime_availability`, [], /permission denied/);
    const bob = await t.rpc(c.bob.uid, 'get_voting', { p_event_id: n.event });
    assert.equal(JSON.stringify(bob).includes(p.alice), false);
    const dino = await t.rpc(c.owner.uid, 'get_voting', { p_event_id: n.event });
    assert.equal(dino.matrix.length, 3);
    assert.deepEqual(dino.matrix.find((r: any) => r.participant_id === p.alice).showtime_ids, [n.early]);
    await t.rpcFails('anon', 'get_voting', { p_event_id: n.event }, /permission denied/);
  }));

test('auto-close: only when RSVP is locked and every eligible participant has voted', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    const ginaPart = await participantOf(t, n.event, { guest: gina });
    await ballot(t, c.alice.uid, p.alice, [n.early]);
    await ballot(t, c.owner.uid, p.dino, [n.early]);
    await passRsvpDeadline(t, n.event);
    await t.sql(`select private.event_changed($1)`, [n.event]);
    assert.equal((await eventRow(t, n.event)).voting_closed_at, null, 'Bob and Gina have not voted');
    await ballot(t, c.bob.uid, p.bob, []);
    assert.equal((await eventRow(t, n.event)).voting_closed_at, null, 'the guest still has not');
    await ballot(t, c.alice.uid, ginaPart, [n.late]);
    assert.notEqual((await eventRow(t, n.event)).voting_closed_at, null);
    await t.rpcFails(c.alice.uid, 'submit_ballot', { p_participant_id: p.alice, p_showtime_ids: [] }, /Voting is closed/);
    assert.equal(await t.val('postgres', `select count(*)::int from public.notifications where kind = 'voting_complete' and recipient_member_id = $1`, [c.owner.id]), 1);
  }));

test('auto-close also happens when the deadline passes after the last vote', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    await ballot(t, c.alice.uid, p.alice, [n.early]);
    await ballot(t, c.owner.uid, p.dino, [n.early]);
    await ballot(t, c.bob.uid, p.bob, [n.early]);
    assert.equal((await eventRow(t, n.event)).voting_closed_at, null);
    await passRsvpDeadline(t, n.event);
    await t.sql(`select private.event_changed($1)`, [n.event]);
    assert.notEqual((await eventRow(t, n.event)).voting_closed_at, null);
  }));

test('revisions: add/edit makes every ballot stale; remove affects only those who picked it', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    await ballot(t, c.alice.uid, p.alice, [n.early]);
    await ballot(t, c.bob.uid, p.bob, [n.late]);
    await ballot(t, c.owner.uid, p.dino, [n.early, n.late]);
    const voted = async () => (await t.rpc(c.owner.uid, 'get_voting', { p_event_id: n.event })).matrix.filter((r: any) => r.current).map((r: any) => r.participant_id);

    // Removing "late": Bob and Dino picked it, Alice did not.
    await t.rpc(c.owner.uid, 'remove_showtime', { p_showtime_id: n.late });
    assert.deepEqual(await voted(), [p.alice]);
    await ballot(t, c.bob.uid, p.bob, []);
    await ballot(t, c.owner.uid, p.dino, [n.early]);
    assert.equal((await voted()).length, 3);

    // Adding one: everybody re-reviews.
    const third = await addShowtime(t, c, n.event, n.theater, 12);
    assert.deepEqual(await voted(), []);
    await ballot(t, c.alice.uid, p.alice, [n.early, third]);
    assert.deepEqual(await voted(), [p.alice]);

    // Editing one: stale again.
    await t.rpc(c.owner.uid, 'update_showtime', { p_showtime_id: third, p_theater_id: n.theater, p_starts_at: inDays(13), p_format: 'dolby' });
    assert.deepEqual(await voted(), []);

    // A newly eligible participant must vote before voting can auto-close.
    await ballot(t, c.alice.uid, p.alice, [third]);
    await ballot(t, c.bob.uid, p.bob, [third]);
    await ballot(t, c.owner.uid, p.dino, [third]);
    await passRsvpDeadline(t, n.event);
    await t.rpc(c.owner.uid, 'set_rsvp', { p_event_id: n.event, p_status: 'going', p_member_id: c.carol.id });
    assert.equal((await eventRow(t, n.event)).voting_closed_at, null);
    await ballot(t, c.carol.uid, await participantOf(t, n.event, { member: c.carol.id }), []);
    assert.notEqual((await eventRow(t, n.event)).voting_closed_at, null);
  }));

test('Dino closes early, reopens, and enters availability for others (audited)', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    await t.rpcFails(c.alice.uid, 'close_voting', { p_event_id: n.event }, /Only the organizer/);
    await t.rpc(c.owner.uid, 'close_voting', { p_event_id: n.event });
    await t.rpcFails(c.alice.uid, 'submit_ballot', { p_participant_id: p.alice, p_showtime_ids: [n.early] }, /Voting is closed/);
    await t.rpcFails(c.owner.uid, 'add_showtime', { p_event_id: n.event, p_theater_id: n.theater, p_starts_at: inDays(14) }, /Reopen/);
    // Dino can still record what someone told him.
    await ballot(t, c.owner.uid, p.alice, [n.late]);
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'ballot.entered_by_owner'`), 1);

    await t.rpc(c.owner.uid, 'reopen_voting', { p_event_id: n.event });
    await ballot(t, c.owner.uid, p.dino, [n.late]);
    await ballot(t, c.bob.uid, p.bob, [n.late]);
    // Reopened with everyone voted and RSVP locked: waits for a new ballot, then closes.
    await t.rpc(c.owner.uid, 'close_voting', { p_event_id: n.event });
    await passRsvpDeadline(t, n.event);
    await t.rpc(c.owner.uid, 'reopen_voting', { p_event_id: n.event });
    await t.sql(`select private.event_changed($1)`, [n.event]);
    assert.equal((await eventRow(t, n.event)).voting_closed_at, null);
    await ballot(t, c.alice.uid, p.alice, [n.early]);
    assert.notEqual((await eventRow(t, n.event)).voting_closed_at, null);
  }));

// --- selection --------------------------------------------------------------

test('selecting a showtime is one atomic step', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const erin = await addMember(t, 'Erin'); // never answered
    const args = { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) };
    await t.rpcFails(c.alice.uid, 'select_showtime', args, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'select_showtime', { ...args, p_confirmation_deadline: inDays(20) }, /between now and the showtime/);
    await t.rpcFails(c.owner.uid, 'select_showtime', { ...args, p_confirmation_deadline: inDays(-1) }, /between now and the showtime/);
    await t.rpcFails(c.owner.uid, 'select_showtime', { ...args, p_showtime_id: n.event }, /not on this event/);
    // A failed attempt changed nothing.
    assert.equal((await eventRow(t, n.event)).selected_showtime_id, null);

    await t.rpc(c.owner.uid, 'select_showtime', args);
    const e = await eventRow(t, n.event);
    assert.equal(e.selected_showtime_id, n.early);
    assert.equal(e.schedule_revision, 1);
    assert.ok(e.voting_closed_at && e.showtime_selected_at && e.confirmation_deadline);
    assert.ok(new Date(e.rsvp_deadline).getTime() <= Date.now() + 1000, 'RSVP closed now');
    // Unanswered became Can't Go; Going/Maybe are pending.
    assert.equal(await t.val('postgres', `select rsvp_status from public.event_participants where member_id = $1`, [erin.id]), 'cant_go');
    assert.equal(await t.val('postgres', `select count(*)::int from public.event_participants where event_id = $1 and rsvp_status in ('going','maybe') and confirmation_status is null`, [n.event]), 3);
    // Participants notified; decliners not.
    const notified = (await t.sql(`select recipient_member_id from public.notifications where kind = 'showtime_selected'`)).map((r) => r.recipient_member_id);
    assert.deepEqual(new Set(notified), new Set([c.owner.id, c.alice.id, c.bob.id]));
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'showtime.selected'`), 1);

    await t.rpcFails(c.alice.uid, 'set_rsvp', { p_event_id: n.event, p_status: 'cant_go' }, /RSVP is closed/);
    await t.rpcFails(c.owner.uid, 'select_showtime', { ...args, p_showtime_id: n.late }, /already selected/);
    await t.rpcFails(c.owner.uid, 'reopen_voting', { p_event_id: n.event }, /already selected/);
    await t.rpcFails(c.owner.uid, 'update_event', { p_event_id: n.event, p_patch: JSON.stringify({ rsvp_deadline: inDays(5) }) }, /RSVP closed/);
  }));

// --- confirmation -----------------------------------------------------------

test('picking a showtime confirms the people who already said it works', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    const dana = await addMember(t, 'Dana');
    await t.rpc(dana.uid, 'set_rsvp', { p_event_id: n.event, p_status: 'going' });
    const gus = await participantOf(t, n.event, { guest: await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gus' }) });
    // Dino: either. Alice: only the late one. Bob (Maybe): the early one. Alice's guest: the early one. Dana: no vote.
    await ballot(t, c.owner.uid, p.dino, [n.early, n.late]);
    await ballot(t, c.alice.uid, p.alice, [n.late]);
    await ballot(t, c.bob.uid, p.bob, [n.early]);
    await ballot(t, c.alice.uid, gus, [n.early]);

    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const answer = (id: string) => t.val('postgres', `select confirmation_status from public.event_participants where id = $1`, [id]);
    assert.equal(await answer(p.dino), 'attending', 'Going, and ticked it');
    assert.equal(await answer(gus), 'attending', 'a guest whose host ticked it for them');
    assert.equal(await answer(p.alice), null, 'Going, but did not tick this time');
    assert.equal(await answer(p.bob), null, 'ticked it, but only Maybe');
    assert.equal(await answer(await participantOf(t, n.event, { member: dana.id })), null, 'never voted');

    // Each member hears once, and it says which of the two happened.
    const told = (member: string) => t.sql(`select title, body from public.notifications where recipient_member_id = $1 and kind = 'showtime_selected'`, [member]);
    assert.deepEqual(await told(c.alice.id), [{ title: 'Showtime picked', body: 'Confirm whether you can make it.' }], 'asked for herself, though her guest is set');
    assert.deepEqual((await told(c.bob.id)).map((row) => row.title), ['Showtime picked']);
    assert.deepEqual((await told(c.owner.id)).map((row) => row.title), ["Showtime picked: you're in"]);
    assert.match((await told(c.owner.id))[0].body, /you are confirmed/);
    assert.equal(
      await t.val('postgres', `select (details ->> 'confirmed_from_ballots')::int from private.audit_log where action = 'showtime.selected' and target_id = $1`, [n.event]),
      2,
    );

    // It is still an answer like any other: changeable until the deadline, and it counts for the ticket split.
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: gus, p_status: 'not_attending' });
    assert.equal(await answer(gus), 'not_attending');
    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 1500 });
    assert.deepEqual(await t.sql(`select participant_id, amount_cents from public.charges where event_id = $1`, [n.event]), [{ participant_id: p.dino, amount_cents: 1500 }]);
  }));

test('a ballot from before the showtimes changed confirms nobody', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const p = await parts(t, c, n);
    await ballot(t, c.alice.uid, p.alice, [n.early]);
    // A third option appears: every ballot is stale until it is submitted again.
    await addShowtime(t, c, n.event, n.theater, 12);
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    assert.equal(await t.val('postgres', `select confirmation_status from public.event_participants where id = $1`, [p.alice]), null);
    // Moving the night asks everyone again, whatever they ticked.
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'attending' });
    await t.rpc(c.owner.uid, 'reschedule_event', {
      p_event_id: n.event, p_theater_id: n.theater, p_starts_at: inDays(11), p_format: 'imax', p_format_other: null, p_confirmation_deadline: inDays(9),
    });
    assert.equal(await t.val('postgres', `select confirmation_status from public.event_participants where id = $1`, [p.alice]), null);
  }));

test('confirmation: each person and each guest independently, until deadline or tickets', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    await t.rpcFails(c.alice.uid, 'set_confirmation', { p_participant_id: await participantOf(t, n.event, { member: c.alice.id }), p_status: 'attending' }, /no showtime to confirm/);
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const p = await parts(t, c, n);
    const ginaPart = await participantOf(t, n.event, { guest: gina });
    const carol = await participantOf(t, n.event, { member: c.carol.id });

    await t.rpcFails(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'yes' }, /Confirmed or Can't Make It/);
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: ginaPart, p_status: 'not_attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'not_attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'attending' });
    await t.rpcFails(c.bob.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'not_attending' }, /Only the organizer/);
    await t.rpcFails(c.bob.uid, 'set_confirmation', { p_participant_id: ginaPart, p_status: 'attending' }, /Only the organizer/);
    await t.rpcFails(c.carol.uid, 'set_confirmation', { p_participant_id: carol, p_status: 'attending' }, /Only Going and Maybe/);
    await t.fails(c.alice.uid, `update public.event_participants set confirmation_status = 'attending'`, [], /permission denied/);

    // Deadline passes: members are locked, pending becomes Not Attending, Dino overrides.
    await t.sql(`update public.events set confirmation_deadline = now() - interval '1 minute' where id = $1`, [n.event]);
    await t.rpcFails(c.bob.uid, 'set_confirmation', { p_participant_id: p.bob, p_status: 'attending' }, /deadline has passed/);
    await t.sql(`select private.settle_confirmations($1)`, [n.event]);
    assert.equal(await t.val('postgres', `select confirmation_status from public.event_participants where id = $1`, [p.bob]), 'not_attending');
    await t.rpc(c.owner.uid, 'set_confirmation', { p_participant_id: p.bob, p_status: 'attending' });
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'confirmation.overridden'`), 1);
  }));

test('reschedule before tickets resets confirmations and keeps the history', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    await ballot(t, c.alice.uid, await participantOf(t, n.event, { member: c.alice.id }), [n.early]);
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const s = { ...n, ...(await parts(t, c, n)) };
    await t.rpc(c.owner.uid, 'set_confirmation', { p_participant_id: s.dino, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: s.alice, p_status: 'attending' });
    await t.rpc(c.bob.uid, 'set_confirmation', { p_participant_id: s.bob, p_status: 'not_attending' });
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 4.25 });
    const votesBefore = await t.val('postgres', `select count(*)::int from public.showtime_availability`);
    const args = { p_event_id: s.event, p_theater_id: s.theater, p_starts_at: inDays(15), p_format: 'imax', p_format_other: null, p_confirmation_deadline: inDays(14) };
    await t.rpcFails(c.alice.uid, 'reschedule_event', args, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'reschedule_event', { ...args, p_confirmation_deadline: inDays(16) }, /between now and the showtime/);

    const moved = await t.rpc(c.owner.uid, 'reschedule_event', args);
    const e = await eventRow(t, s.event);
    assert.equal(e.selected_showtime_id, moved);
    assert.equal(e.schedule_revision, 2);
    const rows = await t.sql(`select id, confirmation_status, prior_confirmation_status from public.event_participants where event_id = $1 and rsvp_status in ('going','maybe')`, [s.event]);
    assert.ok(rows.every((r) => r.confirmation_status === null));
    assert.equal(rows.find((r) => r.id === s.alice)!.prior_confirmation_status, 'attending');
    assert.equal(rows.find((r) => r.id === s.bob)!.prior_confirmation_status, 'not_attending');
    // Members cannot read the prior answers; Dino can.
    await t.fails(c.alice.uid, `select prior_confirmation_status from public.event_participants`, [], /permission denied/);
    const roster = await t.rpc(c.owner.uid, 'owner_roster', { p_event_id: s.event });
    assert.equal(roster.find((r: any) => r.participant_id === s.bob).prior_confirmation_status, 'not_attending');
    // Dino learns WHETHER someone has predicted (for check-in), never the value, even before predicting himself.
    assert.equal(roster.find((r: any) => r.participant_id === s.alice).has_prediction, true);
    assert.equal(roster.find((r: any) => r.participant_id === s.bob).has_prediction, false);
    assert.ok(roster.every((r: any) => !('score' in r) && !('prediction' in r)));
    assert.deepEqual(await t.q(c.owner.uid, `select participant_id from public.predictions`), []);
    await t.rpcFails(c.alice.uid, 'owner_roster', { p_event_id: s.event }, /Only the organizer/);
    // Votes untouched, prediction kept but inactive until re-confirmed.
    assert.equal(await t.val('postgres', `select count(*)::int from public.showtime_availability`), votesBefore);
    assert.deepEqual((await t.sql(`select score::text, is_active from public.predictions where participant_id = $1`, [s.alice]))[0], { score: '4.25', is_active: false });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: s.alice, p_status: 'attending' });
    assert.equal(await t.val('postgres', `select is_active from public.predictions where participant_id = $1`, [s.alice]), true);
    assert.equal(await t.val('postgres', `select count(*)::int from public.notifications where kind = 'event_rescheduled'`), 3);
  }));

test('correcting theater or format does not reset confirmations; a new time must be a reschedule', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await confirmed(t, c);
    const other = await makeTheater(t, c, 'AMC');
    const starts = await t.val('postgres', `select starts_at from public.showtimes where id = $1`, [s.early]);
    await t.rpc(c.owner.uid, 'update_showtime', { p_showtime_id: s.early, p_theater_id: other, p_starts_at: starts, p_format: 'dolby' });
    assert.equal(await t.val('postgres', `select confirmation_status from public.event_participants where id = $1`, [s.alice]), 'attending');
    assert.equal((await eventRow(t, s.event)).schedule_revision, 2);
    await t.rpcFails(c.owner.uid, 'update_showtime', { p_showtime_id: s.early, p_theater_id: other, p_starts_at: inDays(20), p_format: 'dolby' }, /is a reschedule/);
    await t.rpcFails(c.owner.uid, 'update_showtime', { p_showtime_id: s.late, p_theater_id: other, p_starts_at: inDays(20), p_format: 'dolby' }, /Only the selected showtime/);
  }));

// --- tickets and payments ---------------------------------------------------

test('no ticket purchase before a showtime is selected', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    await t.rpcFails(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 3000 }, /Select a showtime/);
    await t.fails('postgres', `update public.events set tickets_purchased_at = now() where id = $1`, [n.event], /events_tickets_need_showtime_check/);
  }));

test('tickets: even split with stable cent remainder; Dino\'s share is paid; confirmations lock', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const p = await parts(t, c, n);
    const ginaPart = await participantOf(t, n.event, { guest: gina });
    await t.rpc(c.owner.uid, 'set_confirmation', { p_participant_id: p.dino, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: ginaPart, p_status: 'attending' });
    // Bob never answers.

    await t.rpcFails(c.alice.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 5000 }, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: -1 }, /what the tickets cost/);
    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 5000 });

    const charges = await t.sql(
      `select c.participant_id, c.amount_cents, c.status from public.charges c join public.event_participants p on p.id = c.participant_id
       where c.event_id = $1 order by p.created_at, p.id`, [n.event]);
    // 5000 / 3 = 1666 r 2: the first two in joining order carry the extra cent.
    assert.deepEqual(charges.map((r) => r.amount_cents), [1667, 1667, 1666]);
    assert.equal(charges.reduce((sum, r) => sum + r.amount_cents, 0), 5000);
    assert.equal(charges.find((r) => r.participant_id === p.dino)!.status, 'paid');
    assert.equal(charges.find((r) => r.participant_id === ginaPart)!.status, 'unpaid');
    assert.equal(await t.val('postgres', `select confirmation_status from public.event_participants where id = $1`, [p.bob]), 'not_attending');

    // Locked for members now; reschedule is off the table.
    await t.rpcFails(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'not_attending' }, /Tickets are bought/);
    await t.rpcFails(c.owner.uid, 'reschedule_event', { p_event_id: n.event, p_theater_id: n.theater, p_starts_at: inDays(15), p_format: 'standard', p_format_other: null, p_confirmation_deadline: inDays(14) }, /already bought/);
    await t.rpcFails(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 5000 }, /already recorded/);

    // The push text never carries the amount.
    const texts = await t.sql(`select title || ' ' || coalesce(body, '') as text, recipient_member_id from public.notifications where kind = 'payment_posted'`);
    assert.deepEqual(texts.map((r) => r.recipient_member_id), [c.alice.id]);
    assert.doesNotMatch(texts[0].text, /\d/);

    // Corrected total re-splits and keeps who paid.
    await t.rpc(c.owner.uid, 'update_ticket_cost', { p_event_id: n.event, p_total_cost_cents: 6000 });
    assert.deepEqual((await t.sql(`select amount_cents, status from public.charges where event_id = $1 order by status, amount_cents`, [n.event])), [
      { amount_cents: 2000, status: 'paid' }, { amount_cents: 2000, status: 'unpaid' }, { amount_cents: 2000, status: 'unpaid' },
    ]);
  }));

test('payments: only Dino marks paid or changes amounts; no peer visibility', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const p = await parts(t, c, n);
    const ginaPart = await participantOf(t, n.event, { guest: gina });
    for (const [uid, part] of [[c.owner.uid, p.dino], [c.alice.uid, p.alice], [c.alice.uid, ginaPart], [c.bob.uid, p.bob]] as const) {
      await t.rpc(uid, 'set_confirmation', { p_participant_id: part, p_status: 'attending' });
    }
    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 4000 });
    const charge = (part: string) => t.val('postgres', `select id from public.charges where participant_id = $1`, [part]);

    const see = async (uid: string) => (await t.q(uid, `select participant_id from public.charges`)).map((r) => r.participant_id);
    assert.deepEqual(new Set(await see(c.alice.uid)), new Set([p.alice, ginaPart]));
    assert.deepEqual(await see(c.bob.uid), [p.bob]);
    assert.deepEqual(await see(c.carol.uid), []);
    assert.equal((await see(c.owner.uid)).length, 4);

    const aliceCharge = await charge(p.alice);
    await t.rpcFails(c.alice.uid, 'set_charge_paid', { p_charge_id: aliceCharge, p_paid: true }, /Only the organizer/);
    await t.rpcFails(c.alice.uid, 'set_charge_amount', { p_charge_id: aliceCharge, p_amount_cents: 0 }, /Only the organizer/);
    await t.rpcFails(c.alice.uid, 'delete_charge', { p_charge_id: aliceCharge }, /Only the organizer/);
    await t.fails(c.alice.uid, `update public.charges set status = 'paid', paid_at = now()`, [], /permission denied/);
    await t.fails(c.alice.uid, `delete from public.charges`, [], /permission denied/);

    await t.rpc(c.owner.uid, 'set_charge_paid', { p_charge_id: aliceCharge, p_paid: true });
    await t.rpc(c.owner.uid, 'set_charge_amount', { p_charge_id: await charge(ginaPart), p_amount_cents: 500 });
    assert.deepEqual((await t.q(c.alice.uid, `select amount_cents, status from public.charges order by amount_cents`)), [
      { amount_cents: 500, status: 'unpaid' }, { amount_cents: 1000, status: 'paid' },
    ]);
    await t.rpc(c.owner.uid, 'set_charge_paid', { p_charge_id: aliceCharge, p_paid: false });
    await t.rpc(c.owner.uid, 'delete_charge', { p_charge_id: await charge(p.bob) });
    assert.deepEqual(await see(c.bob.uid), []);
    assert.ok((await t.val('postgres', `select count(*)::int from private.audit_log where action like 'charge.%'`)) >= 4);
  }));

// --- predictions ------------------------------------------------------------

test('predictions: confirmed only, out of 5 to two decimals, locked on submit, blind until you submit', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await confirmed(t, c);
    for (const bad of [3.625, -0.01, 5.01, 7.5, null]) {
      await t.rpcFails(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: bad }, /0\.00 to 5\.00/);
    }
    await t.rpcFails(c.bob.uid, 'submit_prediction', { p_participant_id: s.bob, p_score: 3 }, /Only confirmed/);
    await t.rpcFails(c.bob.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 3 }, /Only the organizer/);

    await t.rpc(c.owner.uid, 'submit_prediction', { p_participant_id: s.dino, p_score: 0 });
    // Alice has not predicted: she sees nothing, not even that Dino has.
    assert.deepEqual(await t.q(c.alice.uid, `select participant_id from public.predictions`), []);
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 4.25 });
    assert.deepEqual((await t.q(c.alice.uid, `select score::text from public.predictions order by score`)).map((r) => r.score), ['0.00', '4.25']);
    // Bob (not attending, no prediction) and Carol stay blind.
    assert.deepEqual(await t.q(c.bob.uid, `select participant_id from public.predictions`), []);
    assert.deepEqual(await t.q(c.carol.uid, `select participant_id from public.predictions`), []);

    // Locked: no edit, no delete, for members and through the member path for Dino too.
    await t.rpcFails(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 4.5 }, /locked in/);
    await t.rpcFails(c.owner.uid, 'submit_prediction', { p_participant_id: s.dino, p_score: 4.5 }, /locked in/);
    await t.fails(c.alice.uid, `update public.predictions set score = 9`, [], /permission denied/);
    await t.fails(c.alice.uid, `delete from public.predictions`, [], /permission denied/);
    await t.rpcFails(c.alice.uid, 'owner_set_prediction', { p_participant_id: s.alice, p_score: 4.5 }, /Only the organizer/);
    await t.rpc(c.owner.uid, 'owner_set_prediction', { p_participant_id: s.alice, p_score: 4.5 });
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'prediction.corrected'`), 1);
  }));

test('a guest\'s prediction is entered by the host; dropping out makes a prediction inactive', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const p = await parts(t, c, n);
    const ginaPart = await participantOf(t, n.event, { guest: gina });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: p.alice, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: ginaPart, p_status: 'attending' });
    await t.rpc(c.bob.uid, 'set_confirmation', { p_participant_id: p.bob, p_status: 'attending' });
    await t.rpcFails(c.bob.uid, 'submit_prediction', { p_participant_id: ginaPart, p_score: 2.5 }, /Only the organizer/);
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: ginaPart, p_score: 2.5 });
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: p.alice, p_score: 3.5 });
    await t.rpc(c.bob.uid, 'submit_prediction', { p_participant_id: p.bob, p_score: 1.5 });
    assert.equal((await t.q(c.bob.uid, `select 1 from public.predictions`)).length, 3);

    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: ginaPart, p_status: 'not_attending' });
    assert.deepEqual((await t.sql(`select score::text, is_active from public.predictions where participant_id = $1`, [ginaPart]))[0], { score: '2.50', is_active: false });
    // Others no longer see it; the host still does.
    assert.equal((await t.q(c.bob.uid, `select 1 from public.predictions`)).length, 2);
    assert.equal((await t.q(c.alice.uid, `select 1 from public.predictions`)).length, 3);
  }));

// --- check-in, ratings, Past ------------------------------------------------

test('check-in is Dino\'s, can fill a missing prediction, and supports walk-ins with charges', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await confirmed(t, c);
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 4.25 });
    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: s.event, p_total_cost_cents: 3000 });

    await t.rpcFails(c.alice.uid, 'check_in', { p_participant_id: s.alice }, /Only the organizer/);
    await t.fails(c.alice.uid, `update public.event_participants set checked_in_at = now()`, [], /permission denied/);
    await t.rpcFails(c.owner.uid, 'check_in', { p_participant_id: s.alice, p_prediction: 3.885 }, /0\.00 to 5\.00/);

    // Alice already predicted: check-in never replaces it.
    await t.rpc(c.owner.uid, 'check_in', { p_participant_id: s.alice, p_prediction: 0.5 });
    assert.equal(await t.val('postgres', `select score::text from public.predictions where participant_id = $1`, [s.alice]), '4.25');
    // Dino has none: filled in the same step.
    await t.rpc(c.owner.uid, 'check_in', { p_participant_id: s.dino, p_prediction: 3.25 });
    assert.equal(await t.val('postgres', `select score::text from public.predictions where participant_id = $1`, [s.dino]), '3.25');

    // Bob said he could not make it, then showed up: attending, and charged the going rate.
    await t.rpc(c.owner.uid, 'check_in', { p_participant_id: s.bob });
    assert.deepEqual((await t.sql(`select p.confirmation_status, c.amount_cents, c.status from public.event_participants p join public.charges c on c.participant_id = p.id where p.id = $1`, [s.bob]))[0],
      { confirmation_status: 'attending', amount_cents: 1500, status: 'unpaid' });

    // Walk-ins: a member who had declined, and a guest.
    await t.rpcFails(c.alice.uid, 'add_walk_in', { p_event_id: s.event, p_member_id: c.carol.id }, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'add_walk_in', { p_event_id: s.event }, /either a member or a named guest/);
    await t.rpcFails(c.owner.uid, 'add_walk_in', { p_event_id: s.event, p_guest_name: 'Walt' }, /needs a host/);
    const carol = await t.rpc(c.owner.uid, 'add_walk_in', { p_event_id: s.event, p_member_id: c.carol.id, p_prediction: 2 });
    const walt = await t.rpc(c.owner.uid, 'add_walk_in', { p_event_id: s.event, p_guest_name: 'Walt', p_host_member_id: c.bob.id });
    const rows = await t.sql(`select p.id, p.rsvp_status, p.confirmation_status, p.checked_in_at is not null as checked, c.amount_cents
                              from public.event_participants p left join public.charges c on c.participant_id = p.id where p.id = any($1)`, [[carol, walt]]);
    for (const r of rows) assert.deepEqual({ ...r, id: 0 }, { id: 0, rsvp_status: 'going', confirmation_status: 'attending', checked: true, amount_cents: 1500 });
    // Bob sees his walk-in guest's charge.
    assert.equal((await t.q(c.bob.uid, `select 1 from public.charges`)).length, 2);

    await t.rpc(c.owner.uid, 'undo_check_in', { p_participant_id: walt });
    assert.equal(await t.val('postgres', `select checked_in_at from public.event_participants where id = $1`, [walt]), null);
    await t.fails(c.alice.uid, `select seat_label from public.event_participants`, [], /permission denied/);
  }));

/** confirmed(), tickets bought, Dino and Alice checked in with predictions. */
async function watched(t: Tx, c: Club): Promise<Night & Parts> {
  const s = await confirmed(t, c);
  await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: s.event, p_total_cost_cents: 3000 });
  await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 4.25 });
  await t.rpc(c.owner.uid, 'check_in', { p_participant_id: s.alice });
  await t.rpc(c.owner.uid, 'check_in', { p_participant_id: s.dino, p_prediction: 3 });
  return s;
}

test('ratings: checked-in only, editable for 48 hours after the end, then locked', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await watched(t, c);
    await t.rpcFails(c.bob.uid, 'submit_rating', { p_event_id: s.event, p_score: 3.5 }, /checked in/);
    await t.rpcFails(c.carol.uid, 'submit_rating', { p_event_id: s.event, p_score: 3.5 }, /checked in/);
    await t.rpcFails(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 3.775 }, /0\.00 to 5\.00/);
    await t.rpcFails(c.alice.uid, 'end_event', { p_event_id: s.event }, /Only the organizer/);

    await t.rpc(c.owner.uid, 'end_event', { p_event_id: s.event });
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 0 });
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 4.88 });
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 5 });
    await t.rpcFails(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 5.01 }, /0\.00 to 5\.00/);
    await t.rpcFails(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 10 }, /0\.00 to 5\.00/);
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 4.75 });
    assert.equal(await t.val('postgres', `select score::text from public.ratings where participant_id = $1`, [s.alice]), '4.75');
    await t.fails(c.alice.uid, `update public.ratings set score = 1`, [], /permission denied/);

    // 48 hours later.
    await t.sql(`update public.events set ended_at = now() - interval '49 hours' where id = $1`, [s.event]);
    await t.rpcFails(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 0.5 }, /locked 48 hours/);
    await t.rpcFails(c.owner.uid, 'submit_rating', { p_event_id: s.event, p_score: 0.5 }, /locked 48 hours/);
    await t.rpcFails(c.alice.uid, 'owner_set_rating', { p_participant_id: s.alice, p_score: 0.5 }, /Only the organizer/);
    await t.rpc(c.owner.uid, 'owner_set_rating', { p_participant_id: s.dino, p_score: 3.5 });
    await t.rpcFails(c.owner.uid, 'owner_set_rating', { p_participant_id: s.bob, p_score: 3.5 }, /was checked in/);
    await t.rpcFails(c.owner.uid, 'reopen_event', { p_event_id: s.event }, /already in Past/);
  }));

test('a guest who was there is rated by their host, and counts like anyone else', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await watched(t, c);
    // Alice brought Gus: he walked in, which checks him in.
    const gus = await t.rpc(c.owner.uid, 'add_walk_in', { p_event_id: s.event, p_guest_name: 'Gus', p_host_member_id: c.alice.id });
    await t.rpc(c.owner.uid, 'end_event', { p_event_id: s.event });
    const asked = async (who: { uid: string }) => ((await t.rpc(who.uid, 'get_pending_actions')) as any[]).filter((a) => a.kind === 'rate').map((a) => a.participant_id).sort();

    // Alice is asked twice: for herself and for her guest.
    assert.deepEqual(await asked(c.alice), [s.alice, gus].sort());
    await t.rpcFails(c.bob.uid, 'submit_guest_rating', { p_participant_id: gus, p_score: 2.5 }, /Only the organizer/);
    await t.rpcFails(c.alice.uid, 'submit_guest_rating', { p_participant_id: s.alice, p_score: 2.5 }, /not a guest/);
    await t.rpcFails(c.alice.uid, 'submit_guest_rating', { p_participant_id: gus, p_score: 2.775 }, /0\.00 to 5\.00/);
    await t.rpcFails('anon', 'submit_guest_rating', { p_participant_id: gus, p_score: 2.5 }, /permission denied/);
    await t.rpc(c.alice.uid, 'submit_guest_rating', { p_participant_id: gus, p_score: 3 });
    await t.rpc(c.alice.uid, 'submit_guest_rating', { p_participant_id: gus, p_score: 3.25 });
    assert.deepEqual(await asked(c.alice), [s.alice]);
    // She reads her guest's rating, but entering it does not open everyone else's: her own does that.
    assert.deepEqual((await t.q(c.alice.uid, `select score::text from public.ratings where event_id = $1`, [s.event])).map((r) => r.score), ['3.25']);
    await t.rpc(c.owner.uid, 'submit_rating', { p_event_id: s.event, p_score: 4 });
    assert.equal((await t.q(c.alice.uid, `select 1 from public.ratings where event_id = $1`, [s.event])).length, 1);
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 4.5 });
    assert.equal((await t.q(c.alice.uid, `select 1 from public.ratings where event_id = $1`, [s.event])).length, 3);

    // A guest who was not checked in has no rating, from anyone.
    const noShow = await t.val(
      'postgres',
      `with g as (insert into public.guests (display_name, host_member_id, event_id) values ('Ned', $2, $1) returning id)
       insert into public.event_participants (event_id, guest_id, rsvp_status) select $1, id, 'going' from g returning id`,
      [s.event, c.alice.id],
    );
    await t.rpcFails(c.alice.uid, 'submit_guest_rating', { p_participant_id: noShow, p_score: 2.5 }, /checked in/);
    await t.rpcFails(c.owner.uid, 'owner_set_rating', { p_participant_id: noShow, p_score: 2.5 }, /was checked in/);

    // After the 48 hours it is locked for the host; Dino can still correct it, on the record.
    await t.sql(`update public.events set ended_at = now() - interval '49 hours' where id = $1`, [s.event]);
    await t.rpcFails(c.alice.uid, 'submit_guest_rating', { p_participant_id: gus, p_score: 0.5 }, /locked 48 hours/);
    await t.rpc(c.owner.uid, 'owner_set_rating', { p_participant_id: gus, p_score: 3.5 });
    assert.equal(await t.val('postgres', `select score::text from public.ratings where participant_id = $1`, [gus]), '3.50');
    // Everyone in the club sees it in Past, with the rest.
    assert.equal((await t.q(c.carol.uid, `select 1 from public.ratings where event_id = $1`, [s.event])).length, 3);
  }));

test('rating privacy during the 48 hours; everything opens to every current member in Past', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await watched(t, c);
    const erin = await addMember(t, 'Erin'); // joined later, was not there
    await t.rpc(c.owner.uid, 'end_event', { p_event_id: s.event });
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 4.5 });

    const ratings = async (uid: string) => (await t.q(uid, `select score::text from public.ratings order by score`)).map((r) => r.score);
    // Dino has not rated yet: he sees nothing. Neither do non-attenders.
    assert.deepEqual(await ratings(c.owner.uid), []);
    assert.deepEqual(await ratings(c.bob.uid), []);
    assert.deepEqual(await ratings(erin.uid), []);
    assert.deepEqual(await ratings(c.alice.uid), ['4.50']);
    await t.rpc(c.owner.uid, 'submit_rating', { p_event_id: s.event, p_score: 3.25 });
    assert.deepEqual(await ratings(c.owner.uid), ['3.25', '4.50']);
    assert.deepEqual(await ratings(c.alice.uid), ['3.25', '4.50']);
    // Predictions are open to everyone as soon as the night has ended.
    assert.equal((await t.q(c.bob.uid, `select 1 from public.predictions`)).length, 2);

    await t.sql(`update public.events set ended_at = now() - interval '49 hours' where id = $1`, [s.event]);
    for (const who of [c.bob, c.carol, erin]) {
      assert.deepEqual(await ratings(who.uid), ['3.25', '4.50']);
      // Attendees are visible by name, even to someone who never RSVPed.
      const names = (await t.q(who.uid, `select m.first_name from public.event_participants p join public.members m on m.id = p.member_id where p.event_id = $1 and p.checked_in_at is not null order by 1`, [s.event])).map((r) => r.first_name);
      assert.deepEqual(names, ['Alice', 'Dino']);
    }
    // A removed member keeps their place in history.
    await t.rpc(c.owner.uid, 'set_member_status', { p_member_id: c.alice.id, p_status: 'removed' });
    assert.deepEqual(await ratings(c.bob.uid), ['3.25', '4.50']);
    assert.equal(await t.val(c.bob.uid, `select first_name from public.members where id = $1`, [c.alice.id]), 'Alice');
    assert.deepEqual(await ratings(c.alice.uid), []);
  }));

test('ending the night keeps only attendees\' predictions active and opens rating', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await confirmed(t, c);
    await t.rpc(c.owner.uid, 'set_confirmation', { p_participant_id: s.bob, p_status: 'attending' });
    await t.rpc(c.bob.uid, 'submit_prediction', { p_participant_id: s.bob, p_score: 1 });
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: s.alice, p_score: 4 });
    await t.rpc(c.owner.uid, 'check_in', { p_participant_id: s.alice });
    await t.rpcFails(c.owner.uid, 'end_event', { p_event_id: (await makeEvent(t, c)) }, /never had a showtime/);
    await t.rpc(c.owner.uid, 'end_event', { p_event_id: s.event });
    // Bob predicted but never showed: stored, inactive, not in the results.
    assert.deepEqual((await t.sql(`select is_active from public.predictions where participant_id = $1`, [s.bob]))[0], { is_active: false });
    assert.equal((await t.q(c.carol.uid, `select 1 from public.predictions`)).length, 1);
    assert.deepEqual((await t.sql(`select recipient_member_id from public.notifications where kind = 'rating_open'`)).map((r) => r.recipient_member_id), [c.alice.id]);
    await t.rpcFails(c.alice.uid, 'submit_prediction', { p_participant_id: s.dino, p_score: 1 }, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'submit_prediction', { p_participant_id: s.dino, p_score: 1 }, /is over/);
    await t.rpc(c.owner.uid, 'reopen_event', { p_event_id: s.event });
    assert.equal((await eventRow(t, s.event)).ended_at, null);
  }));

test('a guest becomes a member: the night, and everything on it, becomes theirs', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const guest = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gus' });
    const place = await participantOf(t, n.event, { guest });
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    for (const who of [c.owner, c.alice]) {
      await t.rpc(who.uid, 'set_confirmation', { p_participant_id: await participantOf(t, n.event, { member: who.id }), p_status: 'attending' });
    }
    // Alice answers for her guest all the way through.
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: place, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: place, p_score: 3.75 });
    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 3000 });
    const pays = async (who: { uid: string }) => ((await t.rpc(who.uid, 'get_pending_actions')) as any[]).filter((a) => a.kind === 'pay').length;
    assert.equal(await pays(c.alice), 2, 'her own ticket and her guest\'s');

    // Gus joins the club.
    const gus = await addMember(t, 'Gus');
    assert.equal(await pays(gus), 0);
    await t.rpcFails(c.alice.uid, 'promote_guest', { p_guest_id: guest, p_member_id: gus.id }, /Only the organizer/);
    await t.rpcFails(gus.uid, 'promote_guest', { p_guest_id: guest, p_member_id: gus.id }, /Only the organizer/);
    assert.equal(await t.rpc(c.owner.uid, 'promote_guest', { p_guest_id: guest, p_member_id: gus.id }), place, 'the same place on the night');

    // It is his own row now, with what was recorded on it.
    assert.deepEqual(
      (await t.sql(`select member_id, guest_id, rsvp_status, confirmation_status from public.event_participants where id = $1`, [place]))[0],
      { member_id: gus.id, guest_id: null, rsvp_status: 'going', confirmation_status: 'attending' },
    );
    assert.equal(await t.val('postgres', `select count(*)::int from public.guests where id = $1`, [guest]), 0);
    assert.equal(Number(await t.val(gus.uid, `select score from public.predictions where participant_id = $1`, [place])), 3.75);
    assert.deepEqual(await t.q(gus.uid, `select amount_cents, status from public.charges where participant_id = $1`, [place]), [{ amount_cents: 1000, status: 'unpaid' }]);
    // The ticket is his to settle, and no longer Alice's to be reminded about.
    assert.equal(await pays(gus), 1);
    assert.equal(await pays(c.alice), 1);
    // The night's totals did not move.
    assert.equal(await t.val('postgres', `select sum(amount_cents)::int from public.charges where event_id = $1`, [n.event]), 3000);

    // One person cannot be on a night twice.
    const walkIn = await t.rpc(c.owner.uid, 'add_walk_in', { p_event_id: n.event, p_guest_name: 'Gus again', p_host_member_id: c.alice.id });
    const secondGuest = await t.val('postgres', `select guest_id from public.event_participants where id = $1`, [walkIn]);
    await t.rpcFails(c.owner.uid, 'promote_guest', { p_guest_id: secondGuest, p_member_id: gus.id }, /already have their own place/);
    await t.rpcFails(c.owner.uid, 'promote_guest', { p_guest_id: secondGuest, p_member_id: c.bob.id }, /already have their own place/);
    // Not a guest, not a member, not an active member.
    await t.rpcFails(c.owner.uid, 'promote_guest', { p_guest_id: guest, p_member_id: gus.id }, /no longer exists/);
    await t.rpcFails(c.owner.uid, 'promote_guest', { p_guest_id: secondGuest, p_member_id: '00000000-0000-4000-8000-000000000000' }, /active member/);
    const paused = await addMember(t, 'Pat', { status: 'deactivated' });
    await t.rpcFails(c.owner.uid, 'promote_guest', { p_guest_id: secondGuest, p_member_id: paused.id }, /active member/);
    // Someone not yet on the night can take the second guest's place.
    const dana = await addMember(t, 'Dana');
    await t.rpc(c.owner.uid, 'promote_guest', { p_guest_id: secondGuest, p_member_id: dana.id });
    assert.equal(await t.val('postgres', `select count(*)::int from public.event_participants where event_id = $1 and member_id = $2`, [n.event, dana.id]), 1);
    assert.equal(await t.val('postgres', `select count(*)::int from public.guests where event_id = $1`, [n.event]), 0);
  }));

test('Delete Event takes charges, scores, and check-ins with it', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await watched(t, c);
    await t.rpc(c.owner.uid, 'end_event', { p_event_id: s.event });
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: s.event, p_score: 4.5 });
    await t.rpc(c.owner.uid, 'delete_event', { p_event_id: s.event });
    await t.sql(`set constraints all immediate`);
    for (const table of ['events', 'showtimes', 'event_participants', 'charges', 'predictions', 'ratings', 'showtime_ballots', 'notifications']) {
      assert.equal(await t.val('postgres', `select count(*)::int from public.${table}`), 0, table);
    }
  }));
