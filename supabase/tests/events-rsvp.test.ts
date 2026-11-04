// Events, avatars, settings, RSVP, guests, and who can see whom.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { addMember, club, createDb, inDays, inTx, makeEvent, makeTheater, MOVIE, night, participantOf, passRsvpDeadline } from './harness.ts';

let pg: PGlite;
before(async () => {
  pg = await createDb();
});

test('only Dino creates, edits, and deletes events', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const args = { p_movie: JSON.stringify(MOVIE), p_rsvp_deadline: inDays(3) };
    await t.rpcFails(c.alice.uid, 'create_event', args, /Only the organizer/);
    await t.rpcFails('anon', 'create_event', args, /permission denied/);
    const event = await t.rpc(c.owner.uid, 'create_event', { ...args, p_owner_note: ' Bring snacks ', p_title_override: 'Matrix Night' });
    const row = (await t.q(c.alice.uid, `select title_override, owner_note, selected_showtime_id, schedule_revision from public.events where id = $1`, [event]))[0];
    assert.deepEqual(row, { title_override: 'Matrix Night', owner_note: 'Bring snacks', selected_showtime_id: null, schedule_revision: 0 });

    await t.rpcFails(c.alice.uid, 'update_event', { p_event_id: event, p_patch: '{"owner_note":"hax"}' }, /Only the organizer/);
    await t.rpcFails(c.alice.uid, 'delete_event', { p_event_id: event }, /Only the organizer/);
    await t.fails(c.alice.uid, `update public.events set owner_note = 'hax'`, [], /permission denied/);
    await t.fails(c.alice.uid, `delete from public.events`, [], /permission denied/);

    await t.rpc(c.owner.uid, 'update_event', { p_event_id: event, p_patch: JSON.stringify({ owner_note: null, poster_path: '/other.jpg' }) });
    const after = (await t.sql(`select owner_note, poster_path, title_override from public.events where id = $1`, [event]))[0];
    assert.deepEqual(after, { owner_note: null, poster_path: '/other.jpg', title_override: 'Matrix Night' });
    await t.rpcFails(c.owner.uid, 'update_event', { p_event_id: event, p_patch: '{"selected_showtime_id":null}' }, /Cannot change/);
    await t.rpcFails(c.owner.uid, 'update_event', { p_event_id: event, p_patch: '{"poster_path":"https://evil.test/x.jpg"}' }, /TMDB image path/);
    await t.rpcFails(c.owner.uid, 'update_event', { p_event_id: event, p_patch: '{"rsvp_deadline":null}' }, /needs an RSVP deadline/);
  }));

test('an event needs a movie and a future RSVP deadline; the movie row is reused', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    await t.rpcFails(c.owner.uid, 'create_event', { p_movie: '{}', p_rsvp_deadline: inDays(3) }, /Pick a movie/);
    await t.rpcFails(c.owner.uid, 'create_event', { p_movie: JSON.stringify(MOVIE), p_rsvp_deadline: inDays(-1) }, /in the future/);
    await t.rpcFails(c.owner.uid, 'create_event', { p_movie: JSON.stringify(MOVIE), p_rsvp_deadline: null }, /in the future/);
    await makeEvent(t, c);
    await makeEvent(t, c);
    assert.equal(await t.val('postgres', `select count(*)::int from public.movies`), 1);
    assert.equal(await t.val('postgres', `select count(*)::int from public.events`), 2);
    // Everyone but Dino hears about it, once per event.
    assert.equal(await t.val('postgres', `select count(*)::int from public.notifications where kind = 'event_created'`), 6);
  }));

test('settings and theaters are Dino-only writes; members read them', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    // Where members pay Dino is set in the table itself; nobody can write it through the API, Dino included.
    await t.sql(`insert into public.app_settings (id, venmo_username, apple_cash_recipient) values (true, 'dino-w', '+14155550100')`);
    assert.deepEqual(await t.q(c.alice.uid, `select venmo_username, payment_note from public.app_settings`), [{ venmo_username: 'dino-w', payment_note: null }]);
    await t.fails(c.alice.uid, `update public.app_settings set venmo_username = 'mallory'`, [], /permission denied/);
    await t.fails(c.owner.uid, `update public.app_settings set venmo_username = 'someone-else'`, [], /permission denied/);
    await t.rpcFails(c.alice.uid, 'save_theater', { p_theater_id: null, p_name: 'X' }, /Only the organizer/);
    const theater = await makeTheater(t, c);
    await t.rpc(c.owner.uid, 'save_theater', { p_theater_id: theater, p_name: 'AMC', p_address: '' });
    assert.deepEqual(await t.q(c.bob.uid, `select name, address from public.theaters`), [{ name: 'AMC', address: null }]);
    await t.rpcFails(c.owner.uid, 'save_theater', { p_theater_id: null, p_name: 'X', p_time_zone: 'Mars/Olympus' }, /time zone/);
  }));

test('a member sets their own avatar and nothing else about themselves', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    await t.rpc(c.alice.uid, 'set_my_avatar', { p_kind: 'emoji', p_emoji: '🍿' });
    assert.deepEqual((await t.sql(`select avatar_kind, avatar_emoji from public.members where id = $1`, [c.alice.id]))[0], { avatar_kind: 'emoji', avatar_emoji: '🍿' });
    await t.rpc(c.alice.uid, 'set_my_avatar', { p_kind: 'photo', p_path: `${c.alice.id}/abc123.jpg` });
    await t.rpcFails(c.alice.uid, 'set_my_avatar', { p_kind: 'photo', p_path: `${c.bob.id}/abc123.jpg` }, /not in your avatar folder/);
    await t.rpcFails(c.alice.uid, 'set_my_avatar', { p_kind: 'photo', p_path: `${c.alice.id}/../x.jpg` }, /not in your avatar folder/);
    await t.rpc(c.alice.uid, 'set_my_avatar', { p_kind: 'initials' });
    assert.equal(await t.val('postgres', `select first_name from public.members where id = $1`, [c.alice.id]), 'Alice');

    // Storage: own folder only.
    const put = `insert into storage.objects (bucket_id, name) values ('avatars', $1)`;
    await t.q(c.alice.uid, put, [`${c.alice.id}/a.jpg`]);
    await t.fails(c.alice.uid, put, [`${c.bob.id}/a.jpg`], /row-level security/);
    await t.fails('anon', put, [`${c.alice.id}/b.jpg`], /permission denied|row-level security/);
    assert.equal((await t.q(c.bob.uid, `select name from storage.objects where bucket_id = 'avatars'`)).length, 1);
    assert.equal((await t.q(c.bob.uid, `delete from storage.objects where bucket_id = 'avatars' returning name`)).length, 0);
  }));

test('RSVP: change freely before the deadline, locked after', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const event = await makeEvent(t, c);
    await t.rpcFails(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'yes' }, /Going, Maybe, or Can't Go/);
    for (const status of ['going', 'maybe', 'cant_go', 'going']) {
      await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: status });
    }
    assert.equal(await t.val('postgres', `select rsvp_status from public.event_participants where member_id = $1`, [c.alice.id]), 'going');
    await t.rpcFails(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'going', p_member_id: c.bob.id }, /Only the organizer/);
    await t.fails(c.alice.uid, `update public.event_participants set rsvp_status = 'maybe'`, [], /permission denied/);
    await t.fails(c.alice.uid, `insert into public.event_participants (event_id, member_id, rsvp_status) values ($1, $2, 'going')`, [event, c.bob.id], /permission denied/);

    await passRsvpDeadline(t, event);
    await t.rpcFails(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'cant_go' }, /RSVP is closed/);
    await t.rpcFails(c.bob.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' }, /RSVP is closed/);
    // Dino overrides and adds late, audited.
    await t.rpc(c.owner.uid, 'set_rsvp', { p_event_id: event, p_status: 'going', p_member_id: c.bob.id });
    await t.rpc(c.owner.uid, 'set_rsvp', { p_event_id: event, p_status: 'maybe', p_member_id: c.alice.id });
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'rsvp.overridden'`), 2);
  }));

test('unanswered becomes Can\'t Go once RSVP has closed', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const event = await makeEvent(t, c);
    await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' });
    await passRsvpDeadline(t, event);
    await t.sql(`select private.settle_rsvp($1)`, [event]);
    const rows = await t.sql(
      `select m.first_name, p.rsvp_status from public.event_participants p join public.members m on m.id = p.member_id where p.event_id = $1 order by 1`,
      [event],
    );
    assert.deepEqual(rows, [
      { first_name: 'Alice', rsvp_status: 'going' },
      { first_name: 'Bob', rsvp_status: 'cant_go' },
      { first_name: 'Carol', rsvp_status: 'cant_go' },
      { first_name: 'Dino', rsvp_status: 'cant_go' },
    ]);
  }));

test('guests: named, hosted, editable until the deadline', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const event = await makeEvent(t, c);
    await t.rpcFails(c.alice.uid, 'add_guest', { p_event_id: event, p_name: 'Gina' }, /Going or Maybe before/);
    await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' });
    await t.rpcFails(c.alice.uid, 'add_guest', { p_event_id: event, p_name: '   ' }, /needs a name/);
    await t.rpcFails(c.alice.uid, 'add_guest', { p_event_id: event, p_name: 'Gina', p_status: 'cant_go' }, /Going or Maybe/);
    await t.rpcFails(c.alice.uid, 'add_guest', { p_event_id: event, p_name: 'Gina', p_host_member_id: c.bob.id }, /Only the organizer/);
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: event, p_name: ' Gina ' });
    assert.equal(await t.val('postgres', `select display_name from public.guests where id = $1`, [gina]), 'Gina');

    // The host cannot bail while the guest is attached.
    await t.rpcFails(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'cant_go' }, /Remove the guest first/);
    // Neither can Dino orphan the guest.
    await t.rpcFails(c.owner.uid, 'set_rsvp', { p_event_id: event, p_status: 'cant_go', p_member_id: c.alice.id }, /Remove the guest first/);
    await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'maybe' });

    await t.rpcFails(c.bob.uid, 'update_guest', { p_guest_id: gina, p_name: 'Hacked', p_status: 'going' }, /Only the host/);
    await t.rpcFails(c.bob.uid, 'remove_guest', { p_guest_id: gina }, /Only the host/);
    await t.rpc(c.alice.uid, 'update_guest', { p_guest_id: gina, p_name: 'Gina G', p_status: 'maybe' });
    await t.fails(c.alice.uid, `insert into public.guests (display_name, host_member_id, event_id) values ('X', $1, $2)`, [c.alice.id, event], /permission denied/);

    await passRsvpDeadline(t, event);
    await t.rpcFails(c.alice.uid, 'update_guest', { p_guest_id: gina, p_name: 'Late', p_status: 'going' }, /RSVP is closed/);
    await t.rpcFails(c.alice.uid, 'remove_guest', { p_guest_id: gina }, /RSVP is closed/);
    await t.rpcFails(c.alice.uid, 'add_guest', { p_event_id: event, p_name: 'Late' }, /RSVP is closed/);
    // Dino still can, for the host.
    const late = await t.rpc(c.owner.uid, 'add_guest', { p_event_id: event, p_name: 'Late', p_host_member_id: c.alice.id });
    await t.rpc(c.owner.uid, 'remove_guest', { p_guest_id: late });
    await t.rpc(c.owner.uid, 'remove_guest', { p_guest_id: gina });
    assert.equal(await t.val('postgres', `select count(*)::int from public.guests`), 0);
    assert.equal(await t.val('postgres', `select count(*)::int from public.event_participants where guest_id is not null`), 0);
    await t.rpc(c.owner.uid, 'set_rsvp', { p_event_id: event, p_status: 'cant_go', p_member_id: c.alice.id });
  }));

test('privacy: Going/Maybe visible to those who answered; Can\'t Go hidden; Dino sees all', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    const erin = await addMember(t, 'Erin');
    const gina = await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    const hidden = await t.rpc(c.owner.uid, 'add_guest', { p_event_id: n.event, p_name: 'Hidden', p_host_member_id: c.bob.id });
    await t.sql(`update public.event_participants set rsvp_status = 'cant_go' where guest_id = $1`, [hidden]);

    const names = async (uid: string) =>
      (
        await t.q(
          uid,
          `select coalesce(m.first_name, g.display_name) as name, p.rsvp_status
           from public.event_participants p
           left join public.members m on m.id = p.member_id
           left join public.guests g on g.id = p.guest_id
           where p.event_id = $1 order by 1`,
          [n.event],
        )
      ).map((r) => `${r.name}:${r.rsvp_status}`);

    // Erin has not answered: she sees nobody.
    assert.deepEqual(await names(erin.uid), []);
    assert.deepEqual(await t.q(erin.uid, `select display_name from public.guests`), []);
    // Carol answered Can't Go: she sees who is coming and herself, not other decliners.
    assert.deepEqual(await names(c.carol.uid), ['Alice:going', 'Bob:maybe', 'Carol:cant_go', 'Dino:going', 'Gina:going']);
    // Alice does not see Carol's Can't Go or Bob's declined guest.
    assert.deepEqual(await names(c.alice.uid), ['Alice:going', 'Bob:maybe', 'Dino:going', 'Gina:going']);
    // Bob sees his own guest whatever they answered.
    assert.ok((await names(c.bob.uid)).includes('Hidden:cant_go'));
    // Dino sees everything.
    assert.equal((await names(c.owner.uid)).length, 6);
    // Bookkeeping columns stay server-side.
    await t.fails(c.alice.uid, `select rsvp_updated_at from public.event_participants`, [], /permission denied/);
    await t.fails(c.alice.uid, `select event_id from public.guests`, [], /permission denied/);
    assert.ok(await participantOf(t, n.event, { guest: gina }));
  }));

test('Delete Event removes the event and everything attached; the audit entry stays', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const n = await night(t, c);
    await t.rpc(c.alice.uid, 'add_guest', { p_event_id: n.event, p_name: 'Gina' });
    await t.rpc(c.alice.uid, 'submit_ballot', { p_participant_id: await participantOf(t, n.event, { member: c.alice.id }), p_showtime_ids: [n.early] });
    await t.rpc(c.owner.uid, 'delete_event', { p_event_id: n.event });
    await t.sql(`set constraints all immediate`);
    for (const table of ['events', 'showtimes', 'event_participants', 'guests', 'showtime_availability', 'showtime_ballots', 'notifications']) {
      assert.equal(await t.val('postgres', `select count(*)::int from public.${table}`), 0, table);
    }
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'event.deleted'`), 1);
    assert.equal(await t.val('postgres', `select count(*)::int from public.movies`), 1);
  }));
