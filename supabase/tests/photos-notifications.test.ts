// Photos, "Needs You", the notification planner, the outbox, and dispatch.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { addMember, club, createDb, inDays, inTx, makeEvent, night, participantOf, type Club, type Night, type Tx } from './harness.ts';

let pg: PGlite;
before(async () => {
  pg = await createDb();
});

const TOKEN = (n: number) => `ExponentPushToken[testdevice${String(n).padStart(6, '0')}]`;

/** Selected, Dino and Alice confirmed and checked in, Bob declined. */
async function atTheTheater(t: Tx, c: Club): Promise<Night & { dino: string; alice: string; bob: string }> {
  const n = await night(t, c);
  await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
  const dino = await participantOf(t, n.event, { member: c.owner.id });
  const alice = await participantOf(t, n.event, { member: c.alice.id });
  const bob = await participantOf(t, n.event, { member: c.bob.id });
  await t.rpc(c.owner.uid, 'set_confirmation', { p_participant_id: dino, p_status: 'attending' });
  await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: alice, p_status: 'attending' });
  await t.rpc(c.bob.uid, 'set_confirmation', { p_participant_id: bob, p_status: 'not_attending' });
  await t.rpc(c.owner.uid, 'check_in', { p_participant_id: dino, p_prediction: 3 });
  await t.rpc(c.owner.uid, 'check_in', { p_participant_id: alice, p_prediction: 4 });
  return { ...n, dino, alice, bob };
}

// --- photos -----------------------------------------------------------------

test('photos: only checked-in members upload, into their own folder; everyone views', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await atTheTheater(t, c);
    const put = `insert into storage.objects (bucket_id, name) values ('event-photos', $1)`;
    const mine = `${s.event}/${c.alice.id}/photo1.jpg`;

    await t.q(c.alice.uid, put, [mine]);
    await t.fails(c.bob.uid, put, [`${s.event}/${c.bob.id}/photo1.jpg`], /row-level security/); // not checked in
    await t.fails(c.alice.uid, put, [`${s.event}/${c.owner.id}/photo2.jpg`], /row-level security/); // someone else's folder
    await t.fails(c.alice.uid, put, [`${s.event}/${c.alice.id}/../x.jpg`], /row-level security/);
    await t.fails(c.alice.uid, put, [`${s.event}/${c.alice.id}/clip.mp4`], /row-level security/);
    await t.fails(c.alice.uid, put, [`${await makeEvent(t, c)}/${c.alice.id}/photo1.jpg`], /row-level security/); // other event
    await t.fails('anon', put, [mine.replace('photo1', 'photo9')], /permission denied|row-level security/);

    await t.rpcFails(c.bob.uid, 'register_event_photo', { p_event_id: s.event, p_storage_path: mine }, /not in your folder/);
    await t.rpcFails(c.alice.uid, 'register_event_photo', { p_event_id: s.event, p_storage_path: `${s.event}/${c.alice.id}/missing.jpg` }, /Upload the photo first/);
    const media = await t.rpc(c.alice.uid, 'register_event_photo', { p_event_id: s.event, p_storage_path: mine, p_width: 2048, p_height: 1536, p_byte_size: 400000 });
    await t.fails(c.alice.uid, `insert into public.event_media (event_id, uploader_member_id, media_type, storage_path, mime_type) values ($1, $2, 'photo', 'x.jpg', 'image/jpeg')`, [s.event, c.alice.id], /permission denied/);

    // Non-attenders and people who never RSVPed can view.
    const erin = await addMember(t, 'Erin');
    for (const who of [c.bob, c.carol, erin]) {
      assert.equal((await t.q(who.uid, `select 1 from public.event_media where event_id = $1`, [s.event])).length, 1);
      assert.equal((await t.q(who.uid, `select 1 from storage.objects where bucket_id = 'event-photos'`)).length, 1);
    }
    await t.fails('anon', `select 1 from storage.objects`, [], /permission denied/);

    // Delete: uploader or Dino, nobody else.
    await t.rpcFails(c.bob.uid, 'delete_event_photo', { p_media_id: media }, /Only the organizer/);
    assert.equal((await t.q(c.bob.uid, `delete from storage.objects where bucket_id = 'event-photos' returning 1`)).length, 0);
    assert.equal(await t.rpc(c.owner.uid, 'delete_event_photo', { p_media_id: media }), mine);
    assert.equal((await t.q(c.owner.uid, `delete from storage.objects where name = $1 returning 1`, [mine])).length, 1);
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'photo.deleted_by_owner'`), 1);

    // A removed member loses access to the files too.
    await t.rpc(c.owner.uid, 'set_member_status', { p_member_id: c.alice.id, p_status: 'removed' });
    await t.fails(c.alice.uid, put, [`${s.event}/${c.alice.id}/photo3.jpg`], /row-level security/);
  }));

// --- pending actions --------------------------------------------------------

const needs = async (t: Tx, uid: string) => ((await t.rpc(uid, 'get_pending_actions')) as any[]).map((a) => a.kind).sort();

test('Needs You follows the state of the night', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const event = await makeEvent(t, c);
    assert.deepEqual(await needs(t, c.alice.uid), ['rsvp']);
    await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' });
    assert.deepEqual(await needs(t, c.alice.uid), []);
    await t.rpc(c.owner.uid, 'delete_event', { p_event_id: event });

    const n = await night(t, c);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    const alice = await participantOf(t, n.event, { member: c.alice.id });
    const ginaPart = await participantOf(t, n.event, { guest: gina });
    assert.deepEqual(await needs(t, c.alice.uid), ['vote', 'vote']); // herself and her guest
    assert.deepEqual(await needs(t, c.carol.uid), []); // Can't Go: nothing asked
    await t.rpc(c.alice.uid, 'submit_ballot', { p_participant_id: alice, p_showtime_ids: [] });
    await t.rpc(c.alice.uid, 'submit_ballot', { p_participant_id: ginaPart, p_showtime_ids: [n.early] });
    assert.deepEqual(await needs(t, c.alice.uid), []);

    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    // Her guest ticked the time Dino picked, so only Alice herself is still asked.
    assert.deepEqual(await needs(t, c.alice.uid), ['confirm', 'predict']);
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: alice, p_status: 'attending' });
    await t.rpc(c.alice.uid, 'set_confirmation', { p_participant_id: ginaPart, p_status: 'attending' });
    assert.deepEqual(await needs(t, c.alice.uid), ['predict', 'predict']);
    await t.rpc(c.alice.uid, 'submit_prediction', { p_participant_id: alice, p_score: 3.5 });

    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: n.event, p_total_cost_cents: 2000 });
    assert.deepEqual(await needs(t, c.alice.uid), ['pay', 'pay', 'predict']);
    assert.deepEqual(await needs(t, c.bob.uid), []); // never confirmed: nothing owed
    for (const id of (await t.sql(`select id from public.charges where status = 'unpaid'`)).map((r) => r.id)) {
      await t.rpc(c.owner.uid, 'set_charge_paid', { p_charge_id: id, p_paid: true });
    }
    assert.deepEqual(await needs(t, c.alice.uid), ['predict']);

    await t.rpc(c.owner.uid, 'check_in', { p_participant_id: alice });
    await t.rpc(c.owner.uid, 'end_event', { p_event_id: n.event });
    assert.deepEqual(await needs(t, c.alice.uid), ['rate']);
    await t.rpc(c.alice.uid, 'submit_rating', { p_event_id: n.event, p_score: 4 });
    assert.deepEqual(await needs(t, c.alice.uid), []);
    await t.rpcFails('anon', 'get_pending_actions', {}, /permission denied/);
  }));

// --- planner ----------------------------------------------------------------

const kinds = async (t: Tx, member: string, kind: string) =>
  t.val('postgres', `select count(*)::int from public.notifications where recipient_member_id = $1 and kind = $2`, [member, kind]);

test('Dino hears how far a new night reached', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    await t.sql(`insert into private.push_devices (member_id, push_token, platform) values ($1, 'ExponentPushToken[a]', 'ios'), ($2, 'ExponentPushToken[b]', 'ios'), ($3, 'ExponentPushToken[c]', 'ios')`, [c.owner.id, c.alice.id, c.bob.id]);
    await addMember(t, 'Zed', { claim: false });
    assert.deepEqual(await t.rpc(c.owner.uid, 'owner_reach'), { phones: 2, not_signed_in: ['Zed T.'] });
    await t.rpcFails(c.alice.uid, 'owner_reach', {}, /Only the organizer/);
  }));

test('a member can delete their own account', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    // Zed was never on a movie night: he is gone entirely.
    const zed = await addMember(t, 'Zed');
    await t.sql(`insert into private.push_devices (member_id, push_token, platform) values ($1, 'ExponentPushToken[z]', 'ios')`, [zed.id]);
    assert.equal(await t.rpc(zed.uid, 'delete_my_account'), 'deleted');
    assert.equal(await t.val('postgres', `select count(*)::int from public.members where id = $1`, [zed.id]), 0);
    assert.equal(await t.val('postgres', `select count(*)::int from auth.users where id = $1`, [zed.uid]), 0);
    assert.equal(await t.val('postgres', `select count(*)::int from private.push_devices where member_id = $1`, [zed.id]), 0);

    // Alice was: her scores stay with the night, her identity does not.
    const n = await night(t, c);
    await t.rpc(c.alice.uid, 'set_my_avatar', { p_kind: 'emoji', p_emoji: '🍿' });
    assert.equal(await t.rpc(c.alice.uid, 'delete_my_account'), 'anonymized');
    assert.deepEqual(
      (await t.sql(`select first_name, last_initial, avatar_kind, avatar_emoji, status from public.members where id = $1`, [c.alice.id]))[0],
      { first_name: 'Former member', last_initial: 'X', avatar_kind: 'initials', avatar_emoji: null, status: 'removed' },
    );
    assert.equal(await t.val('postgres', `select count(*)::int from public.event_participants where event_id = $1 and member_id = $2`, [n.event, c.alice.id]), 1);
    assert.equal((await t.rpc(c.alice.uid, 'whoami')).outcome, 'no_member');
    assert.equal(await t.val('postgres', `select count(*)::int from public.notifications where recipient_member_id = $1`, [c.alice.id]), 0);
    // Nobody can do it for someone else, and the organizer cannot do it at all.
    await t.rpcFails(c.owner.uid, 'delete_my_account', {}, /organizer cannot/);
    await t.rpcFails('anon', 'delete_my_account', {}, /permission denied/);
  }));

test('RSVP reminders: gentle, near, final; idempotent; stop once answered', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const event = await makeEvent(t, c, 10);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'rsvp_reminder'), 0, 'too soon for a gentle nudge');

    // A day on: the night, and the news of it, are a day old.
    await t.sql(`update public.events set created_at = now() - interval '25 hours' where id = $1`, [event]);
    await t.sql(`update public.notifications set created_at = now() - interval '25 hours' where event_id = $1 and kind = 'event_created'`, [event]);
    await t.sql(`select private.tick()`);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'rsvp_reminder'), 1, 'gentle, once');

    await t.sql(`update public.events set rsvp_deadline = now() + interval '40 hours' where id = $1`, [event]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'rsvp_reminder'), 2, 'near');

    await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'maybe' });
    await t.sql(`update public.events set rsvp_deadline = now() + interval '3 hours' where id = $1`, [event]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'rsvp_reminder'), 2, 'answered: no final reminder');
    assert.equal(await kinds(t, c.bob.id, 'rsvp_reminder'), 3, 'still unanswered: final');

    await t.sql(`update public.events set rsvp_deadline = now() - interval '1 minute' where id = $1`, [event]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.bob.id, 'rsvp_reminder'), 3, 'deadline passed: nothing more');
    assert.equal(await t.val('postgres', `select rsvp_status from public.event_participants where member_id = $1`, [c.bob.id]), 'cant_go');
  }));

test('the tick settles deadlines and closes voting on its own', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    for (const who of [c.owner, c.alice, c.bob]) {
      await t.rpc(who.uid, 'submit_ballot', { p_participant_id: await participantOf(t, n.event, { member: who.id }), p_showtime_ids: [n.early] });
    }
    await t.sql(`update public.events set rsvp_deadline = now() - interval '1 minute' where id = $1`, [n.event]);
    await t.sql(`select private.tick()`);
    assert.notEqual(await t.val('postgres', `select voting_closed_at from public.events where id = $1`, [n.event]), null);

    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    await t.sql(`select private.tick()`);
    // Bob said Maybe, so he is asked. (Alice and Dino said Going and ticked this time: they are already confirmed.)
    assert.equal(await kinds(t, c.bob.id, 'showtime_selected'), 1);
    assert.equal(await kinds(t, c.bob.id, 'confirm_reminder'), 0, 'just told: no second notification saying the same thing');
    // Half a day on and still unanswered: the daily reminder starts, once.
    await t.sql(`update public.notifications set created_at = created_at - interval '13 hours' where kind = 'showtime_selected'`);
    await t.sql(`select private.tick()`);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.bob.id, 'confirm_reminder'), 1);
    assert.equal(await kinds(t, c.alice.id, 'confirm_reminder'), 0, 'already confirmed: never reminded');
    await t.sql(`update public.events set confirmation_deadline = now() - interval '1 minute' where id = $1`, [n.event]);
    await t.sql(`select private.tick()`);
    assert.equal(await t.val('postgres', `select count(*)::int from public.event_participants where event_id = $1 and confirmation_status = 'not_attending'`, [n.event]), 1);
    assert.equal(await t.val('postgres', `select count(*)::int from public.event_participants where event_id = $1 and confirmation_status = 'attending'`, [n.event]), 2);
    assert.equal(await kinds(t, c.bob.id, 'confirm_reminder'), 1);
    // The tick belongs to the schedule: no API role can run it.
    await t.fails(c.alice.uid, `select private.tick()`, [], /permission denied/);
    await t.fails('service_role', `select private.tick()`, [], /permission denied/);
  }));

test('the day-before reminder says today when the showtime is today', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    const title = () => t.val('postgres', `select title from public.notifications where recipient_member_id = $1 and kind = 'event_reminder'`, [c.alice.id]);
    // The showtime is later on the club's own today.
    await t.sql(
      `update public.showtimes set starts_at = now() + least(interval '2 hours', ((now() at time zone 'America/Chicago')::date + 1)::timestamp at time zone 'America/Chicago' - now() - interval '1 minute')
       where id = $1`,
      [n.early],
    );
    await t.sql(`select private.tick()`);
    assert.equal(await title(), 'The Matrix is today');
  }));

test('a night posted with a short deadline does not nudge on the heels of announcing it', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    // Posted today, RSVP closes tonight: inside the "coming up" window from the start.
    await makeEvent(t, c, 0.4);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'event_created'), 1);
    assert.equal(await kinds(t, c.alice.id, 'rsvp_reminder'), 0, 'just told about it');
    // The last call is never held back.
    await t.sql(`update public.events set rsvp_deadline = now() + interval '3 hours'`);
    await t.sql(`select private.tick()`);
    assert.equal(await t.val('postgres', `select title from public.notifications where recipient_member_id = $1 and kind = 'rsvp_reminder'`, [c.alice.id]), 'Last call: The Matrix');
  }));

test('confirm: the last call goes out even right after the showtime is picked', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    await t.rpc(c.owner.uid, 'select_showtime', { p_event_id: n.event, p_showtime_id: n.early, p_confirmation_deadline: inDays(8) });
    await t.sql(`update public.events set confirmation_deadline = now() + interval '3 hours' where id = $1`, [n.event]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'confirm_reminder'), 1);
    assert.equal(await t.val('postgres', `select title from public.notifications where recipient_member_id = $1 and kind = 'confirm_reminder'`, [c.alice.id]), 'Last call to confirm');
  }));

test('payment reminders: no amount, keep coming while it is owed, stop at once when paid', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await atTheTheater(t, c);
    await t.rpc(c.owner.uid, 'record_ticket_purchase', { p_event_id: s.event, p_total_cost_cents: 3333 });
    const charge = await t.val('postgres', `select id from public.charges where participant_id = $1`, [s.alice]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'payment_reminder'), 0, 'just posted');

    await t.sql(`update public.charges set created_at = now() - interval '3 days' where id = $1`, [charge]);
    await t.sql(`select private.tick()`);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'payment_reminder'), 1);
    assert.equal(await kinds(t, c.owner.id, 'payment_reminder'), 0, 'Dino owes himself nothing');
    await t.sql(`update public.charges set created_at = now() - interval '7 days' where id = $1`, [charge]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'payment_reminder'), 2, 'next cooldown bucket');
    const texts = await t.sql(`select title || ' ' || body as text from public.notifications where kind in ('payment_reminder', 'payment_posted')`);
    for (const row of texts) assert.doesNotMatch(row.text, /\d|\$/);

    await t.sql(`update public.charges set created_at = now() - interval '11 days' where id = $1`, [charge]);
    await t.sql(`select private.tick()`);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'payment_reminder'), 3, 'still owed: the next reminder, and nothing else');

    // Paid: reminders stop.
    const before = await kinds(t, c.alice.id, 'payment_reminder');
    await t.rpc(c.owner.uid, 'set_charge_paid', { p_charge_id: charge, p_paid: true });
    await t.sql(`update public.charges set created_at = now() - interval '30 days' where id = $1`, [charge]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'payment_reminder'), before);
  }));

test('event and rating reminders', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const s = await atTheTheater(t, c);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'event_reminder'), 0);
    await t.sql(`update public.showtimes set starts_at = now() + interval '20 hours' where id = $1`, [s.early]);
    await t.sql(`select private.tick()`);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'event_reminder'), 1);
    assert.equal(await kinds(t, c.bob.id, 'event_reminder'), 0, 'Bob is not coming');
    assert.equal(await kinds(t, c.carol.id, 'event_reminder'), 0);

    await t.rpc(c.owner.uid, 'end_event', { p_event_id: s.event });
    await t.rpc(c.owner.uid, 'submit_rating', { p_event_id: s.event, p_score: 3.5 });
    await t.sql(`update public.events set ended_at = now() - interval '25 hours' where id = $1`, [s.event]);
    await t.sql(`select private.tick()`);
    assert.equal(await kinds(t, c.alice.id, 'rating_reminder'), 1);
    assert.equal(await kinds(t, c.owner.id, 'rating_reminder'), 0, 'already rated');
  }));

// --- devices, outbox, dispatch ----------------------------------------------

test('push devices are private; a member registers only their own', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    await t.rpcFails(c.alice.uid, 'register_push_device', { p_push_token: 'not-a-token', p_platform: 'ios' }, /not a push token/);
    await t.rpcFails(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'web' }, /ios or android/);
    await t.rpcFails('anon', 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'ios' }, /permission denied/);
    await t.rpc(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'ios' });
    await t.fails(c.alice.uid, `select * from private.push_devices`, [], /permission denied/);
    await t.fails(c.owner.uid, `select * from private.push_devices`, [], /permission denied/);
    await t.fails(c.alice.uid, `select * from private.notification_deliveries`, [], /permission denied/);
    // The same phone, a different person signs in: the token moves.
    await t.rpc(c.bob.uid, 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'ios' });
    assert.deepEqual(await t.sql(`select member_id from private.push_devices`), [{ member_id: c.bob.id }]);
    await t.rpc(c.alice.uid, 'unregister_push_device', { p_push_token: TOKEN(1) });
    assert.equal(await t.val('postgres', `select count(*)::int from private.push_devices`), 1, 'not hers to remove');
    await t.rpc(c.bob.uid, 'unregister_push_device', { p_push_token: TOKEN(1) });
    assert.equal(await t.val('postgres', `select count(*)::int from private.push_devices`), 0);
  }));

test('announcements: an expiry takes them out of every Inbox, and Dino can take one back', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const inbox = (who: { uid: string }) => t.q(who.uid, `select title from public.notifications order by title`);

    await t.rpcFails(c.owner.uid, 'send_notification', { p_title: 'Too late', p_expires_at: new Date(Date.now() - 60_000).toISOString() }, /at least a little while/);
    await t.rpc(c.owner.uid, 'send_notification', { p_title: 'Doors at 7', p_expires_at: inDays(1) });
    await t.rpc(c.owner.uid, 'send_notification', { p_title: 'Bring cash' });
    assert.deepEqual((await inbox(c.alice)).map((row) => row.title), ['Bring cash', 'Doors at 7']);

    // Alice opens her Inbox; Dino can see that one member has.
    await t.q(c.alice.uid, `update public.notifications set read_at = now()`);
    const sent = (await t.rpc(c.owner.uid, 'list_announcements')) as any[];
    assert.equal(sent.length, 2);
    const doors = sent.find((row) => row.title === 'Doors at 7');
    assert.equal(doors.recipients, 4);
    assert.equal(doors.seen, 1);
    assert.ok(doors.expires_at);
    assert.equal(sent.find((row) => row.title === 'Bring cash').expires_at, null);
    assert.match(doors.batch, /^[0-9a-f-]{36}$/);

    // Past its expiry it is gone for the reader, Dino's own copy included, with nothing having to run.
    await t.sql(`update public.notifications set expires_at = now() - interval '1 minute' where title = 'Doors at 7'`);
    assert.deepEqual((await inbox(c.alice)).map((row) => row.title), ['Bring cash']);
    assert.deepEqual((await inbox(c.owner)).map((row) => row.title), ['Bring cash']);
    assert.equal(await t.val(c.bob.uid, `select count(*)::int from public.notifications where read_at is null`), 1);
    // Dino still sees that it was sent.
    assert.equal(((await t.rpc(c.owner.uid, 'list_announcements')) as any[]).length, 2);

    // Only Dino lists or removes; a made-up batch is refused; removal is for everyone.
    await t.rpcFails(c.alice.uid, 'list_announcements', {}, /Only the organizer/);
    const cash = sent.find((row) => row.title === 'Bring cash').batch;
    await t.rpcFails(c.alice.uid, 'remove_announcement', { p_batch: cash }, /Only the organizer/);
    await t.rpcFails(c.owner.uid, 'remove_announcement', { p_batch: "x' or true --" }, /not an announcement/);
    await t.rpcFails(c.owner.uid, 'remove_announcement', { p_batch: '00000000-0000-4000-8000-000000000000' }, /already gone/);
    await t.fails(c.alice.uid, `delete from public.notifications`, [], /permission denied/);
    assert.equal(await t.rpc(c.owner.uid, 'remove_announcement', { p_batch: cash }), 4);
    assert.deepEqual(await inbox(c.alice), []);
    assert.deepEqual(await inbox(c.bob), []);
    assert.equal(((await t.rpc(c.owner.uid, 'list_announcements')) as any[]).length, 1);
    // Removing an announcement touches nothing else.
    await makeEvent(t, c);
    const others = () => t.val('postgres', `select count(*)::int from public.notifications where kind <> 'announcement'`);
    const before = await others();
    assert.ok(before > 0, 'the new movie night notified people');
    await t.rpc(c.owner.uid, 'send_notification', { p_title: 'Last one' });
    const last = ((await t.rpc(c.owner.uid, 'list_announcements')) as any[]).find((row) => row.title === 'Last one').batch;
    await t.rpc(c.owner.uid, 'remove_announcement', { p_batch: last });
    assert.equal(await others(), before);
  }));

test('only Dino sends notifications, and only the server pushes', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    await t.rpc(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'ios' });
    await t.rpc(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(2), p_platform: 'android' });
    await t.rpc(c.bob.uid, 'register_push_device', { p_push_token: TOKEN(3), p_platform: 'ios' });

    await t.rpcFails(c.alice.uid, 'send_notification', { p_title: 'Free tickets!!' }, /Only the organizer/);
    await t.fails(c.alice.uid, `insert into public.notifications (recipient_member_id, kind, title) values ($1, 'announcement', 'spam')`, [c.bob.id], /permission denied/);
    await t.rpcFails(c.alice.uid, 'dispatch_claim', {}, /permission denied/);
    await t.rpcFails(c.owner.uid, 'dispatch_claim', {}, /permission denied/);
    await t.rpcFails(c.alice.uid, 'dispatch_report', { p_results: '{}' }, /permission denied/);
    await t.rpcFails(c.owner.uid, 'send_notification', { p_title: '  ' }, /short title/);

    assert.equal(await t.rpc(c.owner.uid, 'send_notification', { p_title: 'Doors at 7', p_body: 'Meet in the lobby.' }), 4);
    assert.equal(await t.rpc(c.owner.uid, 'send_notification', { p_title: 'Just you', p_member_ids: [c.bob.id] }), 1);
    // Inbox: each member reads only their own, and can only mark it read.
    assert.equal((await t.q(c.alice.uid, `select 1 from public.notifications`)).length, 1);
    assert.equal((await t.q(c.bob.uid, `select 1 from public.notifications`)).length, 2);
    await t.q(c.alice.uid, `update public.notifications set read_at = now()`);
    assert.equal(await t.val('postgres', `select count(*)::int from public.notifications where read_at is not null`), 1);
    await t.fails(c.alice.uid, `update public.notifications set title = 'x'`, [], /permission denied/);

    const claim = await t.rpc('service_role', 'dispatch_claim', {});
    assert.equal(claim.push.length, 4); // Alice x2 devices, Bob x2 notifications
    assert.deepEqual(Object.keys(claim).sort(), ['push', 'receipts']);
    await t.fails('service_role', `select * from private.auth_claims`, [], /permission denied/);
    assert.ok(claim.push.every((p: any) => p.token.startsWith('ExponentPushToken[') && p.data.kind === 'announcement'));
    // Claimed work is not handed out twice.
    assert.equal((await t.rpc('service_role', 'dispatch_claim', {})).push.length, 0);

    const [sent, failed, dead, also] = claim.push;
    await t.rpc('service_role', 'dispatch_report', {
      p_results: JSON.stringify({ push: [
        { delivery_id: sent.delivery_id, status: 'sent', ticket_id: 'ticket-1' },
        { delivery_id: failed.delivery_id, status: 'failed', error: 'MessageRateExceeded' },
        { delivery_id: dead.delivery_id, status: 'dead', error: 'DeviceNotRegistered' },
        { delivery_id: also.delivery_id, status: 'sent', ticket_id: 'ticket-2' },
      ] }),
    });
    const status = async (id: string) => (await t.sql(`select status, attempt_count from private.notification_deliveries where id = $1`, [id]))[0];
    assert.deepEqual(await status(sent.delivery_id), { status: 'sent', attempt_count: 1 });
    assert.deepEqual(await status(failed.delivery_id), { status: 'queued', attempt_count: 1 });
    assert.deepEqual(await status(dead.delivery_id), { status: 'failed', attempt_count: 1 });
    assert.equal(await t.val('postgres', `select count(*)::int from private.push_devices where disabled_at is not null`), 1);
    // The failed one is retried; the dead device gets nothing new.
    const retry = await t.rpc('service_role', 'dispatch_claim', {});
    assert.deepEqual(retry.push.map((p: any) => p.delivery_id), [failed.delivery_id]);

    // Receipts, 15 minutes later: a device that turned out to be gone is switched off.
    await t.sql(`update private.notification_deliveries set sent_at = now() - interval '20 minutes' where status = 'sent'`);
    const later = await t.rpc('service_role', 'dispatch_claim', {});
    assert.equal(later.receipts.length, 2);
    await t.rpc('service_role', 'dispatch_report', {
      p_results: JSON.stringify({ receipts: [
        { delivery_id: sent.delivery_id, status: 'ok' },
        { delivery_id: also.delivery_id, status: 'dead', error: 'DeviceNotRegistered' },
      ] }),
    });
    assert.equal((await t.rpc('service_role', 'dispatch_claim', {})).receipts.length, 0);
    assert.equal(await t.val('postgres', `select pd.disabled_reason from private.push_devices pd join private.notification_deliveries d on d.push_device_id = pd.id where d.id = $1`, [also.delivery_id]), 'DeviceNotRegistered');
    // Registering again from the app brings a device back.
    await t.rpc(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'ios' });
    await t.rpc(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(2), p_platform: 'android' });
    assert.equal(await t.val('postgres', `select count(*)::int from private.push_devices where member_id = $1 and disabled_at is null`, [c.alice.id]), 2);
  }));

test('per-kind policy: caps and high priority', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    await t.rpc(c.alice.uid, 'register_push_device', { p_push_token: TOKEN(1), p_platform: 'ios' });
    for (let i = 0; i < 3; i += 1) {
      await t.sql(`select private.notify($1, null, 'payment_reminder', 'Movie night payment', 'x', '{}', $2)`, [c.alice.id, `k${i}`]);
    }
    await t.sql(`select private.notify($1, null, 'seat_assigned', 'Your seat', 'Row F', '{}', 'seat')`, [c.alice.id]);
    await t.sql(`select private.notify($1, null, 'seat_assigned', 'Your seat', 'Row F', '{}', 'seat')`, [c.alice.id]);
    // All in the inbox (once each), but the capped kind pushed once.
    assert.equal(await t.val('postgres', `select count(*)::int from public.notifications`), 4);
    const claim = await t.rpc('service_role', 'dispatch_claim', {});
    assert.deepEqual(claim.push.map((p: any) => p.priority).sort(), ['default', 'high']);
  }));
