// Sign-in (invite code alone), member management, owner provisioning, owner
// bootstrap, and the Before User Created hook.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { addMember, anonymousUser, club, createDb, HASH_A, HASH_B, HASH_C, inTx, type Tx } from './harness.ts';

let pg: PGlite;
before(async () => {
  pg = await createDb();
});

const CLIENT = 'f'.repeat(64);

// Claim tickets as the Edge Function makes them: 64 hex characters, stored hashed.
const TICKET_1 = '1'.repeat(64);
const TICKET_2 = '2'.repeat(64);
const ticketHash = (ticket: string) => createHash('sha256').update(ticket, 'utf8').digest('hex');

const begin = (t: Tx, codeHash: string, ticket: string) =>
  t.rpc('service_role', 'begin_invite_claim', { p_code_hash: codeHash, p_ticket_hash: ticketHash(ticket), p_client_key_hash: CLIENT });

/** Enters the code and signs in: the two steps between Dino creating an invite and complete_invite_claim. */
async function signInWith(t: Tx, codeHash: string, ticket: string): Promise<string> {
  assert.deepEqual(await begin(t, codeHash, ticket), { outcome: 'ok' });
  return anonymousUser(t, ticket);
}

// --- claim flow -------------------------------------------------------------

test('first claim: code, ticket, anonymous sign-in, linked', () =>
  inTx(pg, async (t) => {
    const { owner } = await club(t);
    const dana = await t.rpc(owner.uid, 'create_member', { p_first_name: 'Dana', p_last_initial: 'd' });
    await t.rpc(owner.uid, 'create_member_invite', { p_member_id: dana, p_code_hash: HASH_A });

    const preview = await t.rpc('service_role', 'preview_member_invite', { p_code_hash: HASH_A, p_client_key_hash: CLIENT });
    assert.deepEqual(preview, { outcome: 'ok', first_name: 'Dana', last_initial: 'D' });

    const uid = await signInWith(t, HASH_A, TICKET_1);
    // Only the hash of the ticket is stored.
    assert.equal(await t.val('postgres', `select ticket_hash from private.member_invites where code_hash = $1`, [HASH_A]), ticketHash(TICKET_1));
    assert.deepEqual(await t.rpc(uid, 'whoami'), { outcome: 'no_member', pending_invite: true });
    const done = await t.rpc(uid, 'complete_invite_claim');
    assert.deepEqual(done, { outcome: 'ok', member_id: dana, mode: 'claimed' });
    const me = await t.rpc(uid, 'whoami');
    assert.equal(me.outcome, 'ok');
    assert.equal(me.member_id, dana);
    assert.equal(me.role, 'member');

    // The code is spent, and so is the ticket.
    const again = await t.rpc('service_role', 'preview_member_invite', { p_code_hash: HASH_A, p_client_key_hash: CLIENT });
    assert.equal(again.outcome, 'invalid_invite');
    assert.equal((await begin(t, HASH_A, TICKET_2)).outcome, 'invalid_invite');
    const late = await anonymousUser(t, TICKET_1);
    assert.deepEqual(await t.rpc(late, 'whoami'), { outcome: 'no_member', pending_invite: false });
    assert.equal((await t.rpc(late, 'complete_invite_claim')).outcome, 'no_pending_invite');
  }));

test('an Auth user links only through the ticket it signed up with', () =>
  inTx(pg, async (t) => {
    const { owner, alice } = await club(t);
    const dana = await t.rpc(owner.uid, 'create_member', { p_first_name: 'Dana', p_last_initial: 'D' });
    await t.rpc(owner.uid, 'create_member_invite', { p_member_id: dana, p_code_hash: HASH_A });
    await begin(t, HASH_A, TICKET_1);

    // No ticket, a ticket nobody issued, a malformed one, a non-anonymous user holding the right one.
    for (const uid of [
      await anonymousUser(t),
      await anonymousUser(t, TICKET_2),
      await anonymousUser(t, 'not-a-ticket'),
      await t.val('postgres', `insert into auth.users (raw_user_meta_data) values ($1::jsonb) returning id`, [JSON.stringify({ claim_ticket: TICKET_1 })]),
    ]) {
      assert.deepEqual(await t.rpc(uid, 'whoami'), { outcome: 'no_member', pending_invite: false });
      assert.equal((await t.rpc(uid, 'complete_invite_claim')).outcome, 'no_pending_invite');
    }

    // A signed-in member cannot be moved onto someone else's invite.
    await t.sql(`update auth.users set raw_user_meta_data = $2::jsonb where id = $1`, [alice.uid, JSON.stringify({ claim_ticket: TICKET_1 })]);
    assert.equal((await t.rpc(alice.uid, 'complete_invite_claim')).outcome, 'auth_user_already_claimed');
    assert.equal((await t.rpc(alice.uid, 'whoami')).member_id, alice.id);

    // The ticket goes stale after 10 minutes; entering the code again issues a fresh one.
    const uid = await anonymousUser(t, TICKET_1);
    await t.sql(`update private.member_invites set ticket_issued_at = now() - interval '11 minutes' where code_hash = $1`, [HASH_A]);
    assert.equal((await t.rpc(uid, 'complete_invite_claim')).outcome, 'no_pending_invite');
    const fresh = await signInWith(t, HASH_A, TICKET_2);
    assert.equal((await t.rpc(fresh, 'complete_invite_claim')).mode, 'claimed');

    await t.rpcFails('service_role', 'begin_invite_claim', { p_code_hash: HASH_A, p_ticket_hash: 'nope', p_client_key_hash: CLIENT }, /64 hex/);
  }));

test('a new code moves a signed-in member to the new phone and cuts the old one off', () =>
  inTx(pg, async (t) => {
    const { owner, alice, bob } = await club(t);
    await t.rpc(owner.uid, 'create_member_invite', { p_member_id: alice.id, p_code_hash: HASH_A });
    // Nothing changes until the code is used.
    assert.equal((await t.rpc(alice.uid, 'whoami')).member_id, alice.id);

    const uid = await signInWith(t, HASH_A, TICKET_1);
    assert.deepEqual(await t.rpc(uid, 'complete_invite_claim'), { outcome: 'ok', member_id: alice.id, mode: 'relinked' });
    assert.equal((await t.rpc(uid, 'whoami')).member_id, alice.id);
    assert.equal((await t.rpc(alice.uid, 'whoami')).outcome, 'no_member');
    assert.equal(await t.val('postgres', `select count(*)::int from private.auth_claims where member_id = $1 and revoked_at is null`, [alice.id]), 1);
    assert.equal((await t.rpc(bob.uid, 'whoami')).member_id, bob.id);
  }));

test('a login record keeps its history: its binding never changes, and a revoked one is frozen', () =>
  inTx(pg, async (t) => {
    const { alice, bob } = await club(t);
    const claim = (member: string) => t.val('postgres', `select id from private.auth_claims where member_id = $1`, [member]);
    const id = await claim(alice.id);
    // Even the table owner cannot re-point a claim at another member or login.
    await t.fails('postgres', `update private.auth_claims set member_id = $2 where id = $1`, [id, bob.id], /immutable/);
    await t.fails('postgres', `update private.auth_claims set auth_user_id = $2 where id = $1`, [id, bob.uid], /immutable/);
    await t.fails('postgres', `update private.auth_claims set claimed_at = now() - interval '1 day' where id = $1`, [id], /immutable/);
    // Revoking is allowed once; after that the row cannot be brought back to life.
    await t.sql(`update private.auth_claims set revoked_at = now() where id = $1`, [id]);
    await t.fails('postgres', `update private.auth_claims set revoked_at = null where id = $1`, [id], /frozen/);
    assert.equal((await t.rpc(alice.uid, 'whoami')).outcome, 'no_member');
    // Nothing about phone numbers is kept any more.
    const columns = (await t.sql(`select column_name from information_schema.columns where table_schema = 'private' and table_name in ('auth_claims', 'member_invites')`)).map((row) => row.column_name);
    assert.ok(!columns.some((name) => name.includes('phone')), columns.join(', '));
  }));

test('the owner moves to a new phone with a code he makes for himself', () =>
  inTx(pg, async (t) => {
    const { owner } = await club(t);
    await t.rpc(owner.uid, 'create_member_invite', { p_member_id: owner.id, p_code_hash: HASH_A });
    const uid = await signInWith(t, HASH_A, TICKET_1);
    assert.equal((await t.rpc(uid, 'complete_invite_claim')).mode, 'relinked');
    assert.equal((await t.rpc(uid, 'whoami')).role, 'owner');
    assert.equal((await t.rpc(owner.uid, 'whoami')).outcome, 'no_member');
    assert.equal(await t.val('postgres', `select count(*)::int from public.members where role = 'owner'`), 1);
  }));

test('invite guessing is rate limited per client', () =>
  inTx(pg, async (t) => {
    await club(t);
    for (let i = 0; i < 10; i += 1) {
      const r = await t.rpc('service_role', 'preview_member_invite', { p_code_hash: HASH_C, p_client_key_hash: CLIENT });
      assert.equal(r.outcome, 'invalid_invite');
    }
    const locked = await t.rpc('service_role', 'preview_member_invite', { p_code_hash: HASH_C, p_client_key_hash: CLIENT });
    assert.equal(locked.outcome, 'rate_limited');
  }));

test('pre-auth steps are service_role only; anon reaches nothing', () =>
  inTx(pg, async (t) => {
    const { alice } = await club(t);
    const args = { p_code_hash: HASH_A, p_client_key_hash: CLIENT };
    await t.rpcFails(alice.uid, 'preview_member_invite', args, /permission denied/);
    await t.rpcFails('anon', 'preview_member_invite', args, /permission denied/);
    await t.rpcFails('anon', 'whoami', {}, /permission denied/);
    await t.rpcFails('anon', 'complete_invite_claim', {}, /permission denied/);
  }));

// --- member management ------------------------------------------------------

test('only the owner manages members; members cannot rename or promote themselves', () =>
  inTx(pg, async (t) => {
    const { owner, alice, bob } = await club(t);
    await t.rpcFails(alice.uid, 'create_member', { p_first_name: 'X', p_last_initial: 'X' }, /only the owner/);
    await t.rpcFails(alice.uid, 'rename_member', { p_member_id: alice.id, p_first_name: 'Queen', p_last_initial: 'A' }, /only the owner/);
    await t.rpcFails(alice.uid, 'set_member_status', { p_member_id: bob.id, p_status: 'removed' }, /only the owner/);
    await t.rpcFails(alice.uid, 'reset_member_access', { p_member_id: bob.id }, /only the owner/);
    await t.rpcFails(alice.uid, 'create_member_invite', { p_member_id: alice.id, p_code_hash: HASH_A }, /only the owner/);
    await t.rpcFails(alice.uid, 'owner_member_access', {}, /only the owner/);
    await t.fails(alice.uid, `update public.members set role = 'owner' where id = $1`, [alice.id], /permission denied/);
    await t.fails(alice.uid, `update public.members set first_name = 'Queen' where id = $1`, [alice.id], /permission denied/);
    await t.fails(alice.uid, `insert into public.members (first_name, last_initial) values ('X', 'X')`, [], /permission denied/);
    // Even the table owner cannot change a role or sideline the owner.
    await t.fails('postgres', `update public.members set role = 'owner' where id = $1`, [alice.id], /immutable/);
    await t.fails('postgres', `update public.members set status = 'removed' where id = $1`, [owner.id], /owner cannot/);

    await t.rpc(owner.uid, 'rename_member', { p_member_id: alice.id, p_first_name: 'Alicia', p_last_initial: 'q' });
    const row = (await t.sql(`select first_name, last_initial from public.members where id = $1`, [alice.id]))[0];
    assert.deepEqual(row, { first_name: 'Alicia', last_initial: 'Q' });
  }));

test('removed members lose access at once; one who was on a movie night keeps their name there', () =>
  inTx(pg, async (t) => {
    const { owner, alice, bob } = await club(t);
    // Alice has been part of a night: something still points at her.
    const event = await t.rpc(owner.uid, 'create_event', {
      p_movie: JSON.stringify({ tmdb_id: 603, title: 'The Matrix', metadata: {} }), p_rsvp_deadline: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await t.rpc(alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' });
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: alice.id, p_status: 'removed' });
    assert.equal((await t.rpc(alice.uid, 'whoami')).outcome, 'no_member');
    assert.equal((await t.q(alice.uid, `select id from public.members`)).length, 0);
    // History keeps the name.
    const seen = await t.q(bob.uid, `select first_name, status from public.members where id = $1`, [alice.id]);
    assert.deepEqual(seen, [{ first_name: 'Alice', status: 'removed' }]);
    assert.equal(await t.val('postgres', `select count(*)::int from private.auth_claims where member_id = $1 and revoked_at is not null`, [alice.id]), 1);
    assert.equal(await t.val('postgres', `select count(*)::int from auth.users where id = $1`, [alice.uid]), 1);
    await t.rpcFails(owner.uid, 'create_member_invite', { p_member_id: alice.id, p_code_hash: HASH_A }, /active members/);
    // She can be brought back as herself.
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: alice.id, p_status: 'active' });
    assert.equal(await t.val('postgres', `select status from public.members where id = $1`, [alice.id]), 'active');
  }));

test('removing a member who was never on a movie night deletes them completely', () =>
  inTx(pg, async (t) => {
    const { owner, alice, bob } = await club(t);
    await t.rpc(owner.uid, 'create_member_invite', { p_member_id: bob.id, p_code_hash: HASH_A });
    await t.sql(`insert into public.notifications (recipient_member_id, kind, title) values ($1, 'announcement', 'Hello')`, [bob.id]);
    await t.rpcFails(alice.uid, 'set_member_status', { p_member_id: bob.id, p_status: 'removed' }, /only the owner/);
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: bob.id, p_status: 'removed' });

    assert.equal((await t.rpc(bob.uid, 'whoami')).outcome, 'no_member');
    for (const [what, sql] of [
      ['member', `select count(*)::int from public.members where id = $1`],
      ['login', `select count(*)::int from private.auth_claims where member_id = $1`],
      ['invites', `select count(*)::int from private.member_invites where member_id = $1`],
      ['inbox', `select count(*)::int from public.notifications where recipient_member_id = $1`],
    ] as const) {
      assert.equal(await t.val('postgres', sql, [bob.id]), 0, what);
    }
    assert.equal(await t.val('postgres', `select count(*)::int from auth.users where id = $1`, [bob.uid]), 0, 'the Auth user behind the login');
    // Nobody else is touched, and the log says who it was.
    assert.equal(await t.val('postgres', `select count(*)::int from public.members`), 3);
    assert.equal(await t.val('postgres', `select details ->> 'first_name' from private.audit_log where action = 'member.deleted' and target_id = $1`, [bob.id]), 'Bob');
    // Pausing never deletes anyone.
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: alice.id, p_status: 'deactivated' });
    assert.equal(await t.val('postgres', `select status from public.members where id = $1`, [alice.id]), 'deactivated');
  }));

test('a member links their own Letterboxd, by name or by profile address', () =>
  inTx(pg, async (t) => {
    const { alice, bob } = await club(t);
    for (const typed of ['alicewatches', '@alicewatches', 'https://letterboxd.com/alicewatches/films/', 'letterboxd.com/AliceWatches']) {
      const kept = await t.rpc(alice.uid, 'set_my_letterboxd', { p_username: typed });
      assert.equal(kept.toLowerCase(), 'alicewatches', typed);
    }
    // Everyone in the club sees it; only she can change it.
    assert.equal(await t.val(bob.uid, `select letterboxd from public.members where id = $1`, [alice.id]), 'AliceWatches');
    await t.fails(bob.uid, `update public.members set letterboxd = 'bob' where id = $1`, [alice.id], /permission denied/);
    await t.rpcFails(alice.uid, 'set_my_letterboxd', { p_username: 'not a name!' }, /Letterboxd username/);
    assert.equal(await t.rpc(alice.uid, 'set_my_letterboxd', { p_username: '  ' }), null);
    assert.equal(await t.val(bob.uid, `select letterboxd from public.members where id = $1`, [alice.id]), null);
    await t.rpcFails('anon', 'set_my_letterboxd', { p_username: 'x' }, /permission denied/);
  }));

test('deactivate pauses access; reactivate restores the same login', () =>
  inTx(pg, async (t) => {
    const { owner, alice } = await club(t);
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: alice.id, p_status: 'deactivated' });
    assert.equal((await t.rpc(alice.uid, 'whoami')).outcome, 'no_member');
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: alice.id, p_status: 'active' });
    assert.equal((await t.rpc(alice.uid, 'whoami')).member_id, alice.id);
  }));

test('reset access: signed out at once, and the next code lets them back in', () =>
  inTx(pg, async (t) => {
    const { owner, alice } = await club(t);
    await t.rpc(owner.uid, 'reset_member_access', { p_member_id: alice.id });
    assert.equal((await t.rpc(alice.uid, 'whoami')).outcome, 'no_member');
    await t.rpc(owner.uid, 'create_member_invite', { p_member_id: alice.id, p_code_hash: HASH_B });
    const uid = await signInWith(t, HASH_B, TICKET_1);
    assert.equal((await t.rpc(uid, 'complete_invite_claim')).mode, 'claimed');
    assert.equal((await t.rpc(uid, 'whoami')).member_id, alice.id);
    await t.rpcFails(owner.uid, 'reset_member_access', { p_member_id: owner.id }, /owner's access/);
  }));

// --- owner provisioning -----------------------------------------------------

test('create_member_with_invite is atomic and owner-only', () =>
  inTx(pg, async (t) => {
    const { owner, alice } = await club(t);
    const args = { p_first_name: ' Erin ', p_last_initial: 'e', p_code_hash: HASH_A };
    await t.rpcFails(alice.uid, 'create_member_with_invite', args, /only the owner/);
    await t.rpcFails('service_role', 'create_member_with_invite', args, /permission denied/);

    const made = await t.rpc(owner.uid, 'create_member_with_invite', args);
    const member = (await t.sql(`select first_name, last_initial, role, status from public.members where id = $1`, [made.member_id]))[0];
    assert.deepEqual(member, { first_name: 'Erin', last_initial: 'E', role: 'member', status: 'active' });
    assert.ok(made.expires_at);

    // A refused invite (duplicate hash) takes the member down with it.
    const before = await t.val('postgres', `select count(*)::int from public.members`);
    await t.rpcFails(owner.uid, 'create_member_with_invite', { ...args, p_first_name: 'Frank' }, /member_invites_code_hash_key/);
    await t.rpcFails(owner.uid, 'create_member_with_invite', { ...args, p_code_hash: 'nope' }, /64 hex/);
    assert.equal(await t.val('postgres', `select count(*)::int from public.members`), before);
  }));

test('owner_member_access reports login and invite state', () =>
  inTx(pg, async (t) => {
    const { owner, alice } = await club(t);
    const made = await t.rpc(owner.uid, 'create_member_with_invite', { p_first_name: 'Erin', p_last_initial: 'E', p_code_hash: HASH_A });
    const access = (await t.rpc(owner.uid, 'owner_member_access')) as any[];
    const erin = access.find((row) => row.member_id === made.member_id);
    assert.equal(erin.has_login, false);
    assert.equal(erin.invite_open, true);
    assert.equal(erin.invite_started, false);
    assert.equal(access.find((row) => row.member_id === alice.id).has_login, true);
    await begin(t, HASH_A, TICKET_1);
    const started = (await t.rpc(owner.uid, 'owner_member_access')) as any[];
    assert.equal(started.find((row) => row.member_id === made.member_id).invite_started, true);
    assert.doesNotMatch(JSON.stringify(started), new RegExp(`${TICKET_1}|${ticketHash(TICKET_1)}|${HASH_A}`));
  }));

// --- owner bootstrap --------------------------------------------------------

test('bootstrap: creates the owner, can reissue, closes itself at first claim', () =>
  inTx(pg, async (t) => {
    const args = { p_first_name: 'Dino', p_last_initial: 'w', p_code_hash: HASH_A };
    await t.rpcFails('anon', 'bootstrap_owner_invite', args, /permission denied/);

    const first = await t.rpc('service_role', 'bootstrap_owner_invite', args);
    assert.equal(first.outcome, 'ok');
    assert.equal(first.mode, 'created');
    const owner = (await t.sql(`select id, first_name, last_initial, role from public.members`))[0];
    assert.deepEqual({ ...owner, id: undefined }, { id: undefined, first_name: 'Dino', last_initial: 'W', role: 'owner' });

    // Lost code: reissue replaces the open invite.
    const second = await t.rpc('service_role', 'bootstrap_owner_invite', { ...args, p_code_hash: HASH_B });
    assert.equal(second.mode, 'reissued');
    assert.equal((await t.rpc('service_role', 'preview_member_invite', { p_code_hash: HASH_A, p_client_key_hash: CLIENT })).outcome, 'invalid_invite');

    // Dino signs in through the ordinary flow.
    const uid = await signInWith(t, HASH_B, TICKET_1);
    assert.equal((await t.rpc(uid, 'complete_invite_claim')).outcome, 'ok');
    assert.equal((await t.rpc(uid, 'whoami')).role, 'owner');

    // The surface is gone, for every role.
    await t.rpcFails('service_role', 'bootstrap_owner_invite', { ...args, p_code_hash: HASH_C }, /permission denied/);
    await t.rpcFails(uid, 'bootstrap_owner_invite', { ...args, p_code_hash: HASH_C }, /permission denied/);
    assert.equal(await t.val('postgres', `select count(*)::int from private.audit_log where action = 'owner.bootstrap_closed'`), 1);
  }));

test('bootstrap refuses once the club exists', () =>
  inTx(pg, async (t) => {
    // The owner's claim already closed the surface (the fixture's insert fires
    // the same trigger a real claim does).
    await club(t);
    const args = { p_first_name: 'Mallory', p_last_initial: 'M', p_code_hash: HASH_A };
    await t.rpcFails('service_role', 'bootstrap_owner_invite', args, /permission denied/);
    // And the implementation refuses on its own, even called as the database owner.
    const r = await t.val('postgres', `select private.bootstrap_owner_invite_impl('Mallory', 'M', $1)`, [HASH_A]);
    assert.equal(r.outcome, 'already_bootstrapped');
    assert.equal(await t.val('postgres', `select count(*)::int from public.members where role = 'owner'`), 1);
  }));

test('bootstrap never renames the owner once other members exist, and never creates a second owner', () =>
  inTx(pg, async (t) => {
    await addMember(t, 'Dino', { role: 'owner', claim: false });
    await addMember(t, 'Alice', { claim: false });
    const r = await t.rpc('service_role', 'bootstrap_owner_invite', { p_first_name: 'Mallory', p_last_initial: 'M', p_code_hash: HASH_A });
    assert.equal(r.mode, 'reissued');
    assert.deepEqual(await t.sql(`select first_name, role from public.members order by role desc`), [
      { first_name: 'Dino', role: 'owner' },
      { first_name: 'Alice', role: 'member' },
    ]);
    // The invite is the owner's, nobody else's.
    assert.equal(
      await t.val('postgres', `select m.role from private.member_invites i join public.members m on m.id = i.member_id where i.code_hash = $1`, [HASH_A]),
      'owner',
    );
  }));

test('owner recovery: only by a deliberate administrator re-grant, and it closes itself again', () =>
  inTx(pg, async (t) => {
    const c = await club(t);
    const args = { p_first_name: 'Dino', p_last_initial: 'T', p_code_hash: HASH_A };
    // Normal operation: closed to every API role, and the app cannot reset the owner.
    await t.rpcFails('service_role', 'bootstrap_owner_invite', args, /permission denied/);
    await t.rpcFails(c.owner.uid, 'bootstrap_owner_invite', args, /permission denied/);
    await t.rpcFails(c.owner.uid, 'reset_member_access', { p_member_id: c.owner.id }, /owner's access/);
    // Re-granting alone is not enough while the owner still holds a login.
    await t.sql(`grant execute on function public.bootstrap_owner_invite(text, text, text) to service_role`);
    await t.sql(`grant execute on function private.bootstrap_owner_invite_impl(text, text, text) to service_role`);
    assert.equal((await t.rpc('service_role', 'bootstrap_owner_invite', args)).outcome, 'already_bootstrapped');

    // The documented break-glass: revoke the owner's claim as the database administrator.
    await t.sql(`update private.auth_claims set revoked_at = now() where member_id = $1 and revoked_at is null`, [c.owner.id]);
    assert.equal((await t.rpc(c.owner.uid, 'whoami')).outcome, 'no_member');
    const r = await t.rpc('service_role', 'bootstrap_owner_invite', args);
    assert.equal(r.mode, 'reissued');
    assert.equal(r.member_id, c.owner.id);
    assert.equal(await t.val('postgres', `select first_name from public.members where id = $1`, [c.owner.id]), 'Dino');

    // Dino signs in on his new phone through the ordinary flow.
    const uid = await signInWith(t, HASH_A, TICKET_1);
    assert.equal((await t.rpc(uid, 'complete_invite_claim')).outcome, 'ok');
    assert.equal((await t.rpc(uid, 'whoami')).role, 'owner');
    assert.equal(await t.val('postgres', `select count(*)::int from public.members where role = 'owner'`), 1);
    // And the door is shut again.
    await t.rpcFails('service_role', 'bootstrap_owner_invite', { ...args, p_code_hash: HASH_B }, /permission denied/);
    // Everyone else was untouched.
    assert.equal((await t.rpc(c.alice.uid, 'whoami')).member_id, c.alice.id);
  }));

// --- Before User Created hook -----------------------------------------------

const hook = (t: Tx, user: Record<string, unknown>) =>
  t.val('supabase_auth_admin', `select private.hook_before_user_created($1::jsonb)`, [JSON.stringify({ metadata: {}, user })]);

test('hook: only an anonymous sign-in carrying a live claim ticket may become an Auth user', () =>
  inTx(pg, async (t) => {
    const { owner } = await club(t);
    const made = await t.rpc(owner.uid, 'create_member_with_invite', { p_first_name: 'Erin', p_last_initial: 'E', p_code_hash: HASH_A });
    const signUp = (ticket: unknown, user: Record<string, unknown> = {}) =>
      hook(t, { phone: '', email: '', is_anonymous: true, user_metadata: { claim_ticket: ticket }, ...user });
    const NO_TICKET = /Start with your invite code/;
    const NOT_ON_AN_INVITE = /no longer valid/;

    // The code has not been entered yet.
    const early = await signUp(TICKET_1);
    assert.equal(early.error.http_code, 403);
    assert.match(early.error.message, NOT_ON_AN_INVITE);

    await begin(t, HASH_A, TICKET_1);
    assert.deepEqual(await signUp(TICKET_1), {});

    assert.match((await signUp(TICKET_2)).error.message, NOT_ON_AN_INVITE);
    // The stored hash is not a ticket.
    assert.match((await signUp(ticketHash(TICKET_1))).error.message, NOT_ON_AN_INVITE);
    for (const bad of [undefined, '', 'nope', 'A'.repeat(64), 42, TICKET_1 + '1']) {
      assert.match((await signUp(bad)).error.message, NO_TICKET, String(bad));
    }
    assert.match((await hook(t, { is_anonymous: true })).error.message, NO_TICKET);
    assert.match((await hook(t, {})).error.message, NO_TICKET);
    // Any other kind of sign-up is refused, right ticket or not.
    assert.match((await signUp(TICKET_1, { is_anonymous: false })).error.message, NO_TICKET);
    assert.match((await signUp(TICKET_1, { phone: '14155550123' })).error.message, NO_TICKET);
    assert.match((await signUp(TICKET_1, { email: 'someone@example.test' })).error.message, NO_TICKET);
    assert.ok((await hook(t, { phone: '14155550123', is_anonymous: false })).error);
    assert.ok((await hook(t, { email: 'someone@example.test', is_anonymous: false })).error);

    // Stale ticket, expired invite, or the member no longer active: refused again.
    await t.sql(`update private.member_invites set ticket_issued_at = now() - interval '11 minutes' where member_id = $1`, [made.member_id]);
    assert.ok((await signUp(TICKET_1)).error);
    await t.sql(`update private.member_invites set ticket_issued_at = now() where member_id = $1`, [made.member_id]);
    assert.deepEqual(await signUp(TICKET_1), {});
    await t.sql(`update private.member_invites set expires_at = now() - interval '1 minute' where member_id = $1`, [made.member_id]);
    assert.ok((await signUp(TICKET_1)).error);
    await t.sql(`update private.member_invites set expires_at = now() + interval '1 day' where member_id = $1`, [made.member_id]);
    assert.deepEqual(await signUp(TICKET_1), {});
    await t.rpc(owner.uid, 'set_member_status', { p_member_id: made.member_id, p_status: 'deactivated' });
    assert.ok((await signUp(TICKET_1)).error);
  }));

test('hook: callable by the Auth service only, and it can read nothing else', () =>
  inTx(pg, async (t) => {
    const { alice } = await club(t);
    await t.fails(alice.uid, `select private.hook_before_user_created('{}'::jsonb)`, [], /permission denied/);
    await t.fails('anon', `select private.hook_before_user_created('{}'::jsonb)`, [], /permission denied/);
    await t.fails('service_role', `select private.hook_before_user_created('{}'::jsonb)`, [], /permission denied/);
    await t.fails('supabase_auth_admin', `select code_hash from private.member_invites`, [], /permission denied/);
    await t.fails('supabase_auth_admin', `select first_name from public.members`, [], /permission denied/);
    await t.fails('supabase_auth_admin', `select * from private.auth_claims`, [], /permission denied/);
    await t.fails('supabase_auth_admin', `update public.members set status = 'removed'`, [], /permission denied/);
  }));
