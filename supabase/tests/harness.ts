// Database test harness: a real Postgres (PGlite, in-process WASM) with a
// minimal stand-in for the parts of the Supabase platform the migrations rely
// on, then every migration applied in order. No Docker, no network, no hosted
// project.
//
//   npm run test:db
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// What a Supabase project provides before the first migration runs.
const PLATFORM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_auth_admin nologin;

create schema auth;
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  phone              text unique,
  phone_confirmed_at timestamptz,
  phone_change       text,
  email              text,
  is_anonymous       boolean not null default false,
  raw_user_meta_data jsonb,
  deleted_at         timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to public;

create schema extensions;

create schema storage;
create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner_id   text,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1 : greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant execute on function storage.foldername(text) to public;
`;

export type Row = Record<string, any>;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

/** A migrated database. `upTo` stops before the first migration whose name contains it. */
export async function createDb(options: { upTo?: string } = {}): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(PLATFORM);
  for (const name of migrationFiles()) {
    if (options.upTo && name.includes(options.upTo)) break;
    try {
      await pg.exec(migrationSql(name));
    } catch (error) {
      throw new Error(`migration ${name} failed: ${(error as Error).message}`);
    }
  }
  return pg;
}

/** Who a statement runs as. A string is an Auth user id acting as `authenticated`. */
export type Actor = string | 'postgres' | 'service_role' | 'anon' | 'supabase_auth_admin';

/**
 * One test's view of the database: everything runs inside a transaction that
 * is rolled back afterwards, so tests in a file share a database without
 * seeing each other.
 */
export class Tx {
  private savepoint = 0;
  private readonly pg: PGlite;
  constructor(pg: PGlite) {
    this.pg = pg;
  }

  private async become(actor: Actor): Promise<void> {
    const special = ['postgres', 'service_role', 'anon', 'supabase_auth_admin'];
    const role = special.includes(actor) ? actor : 'authenticated';
    const claims = special.includes(actor) ? '' : JSON.stringify({ sub: actor, role: 'authenticated' });
    await this.pg.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await this.pg.query(`select set_config('role', $1, true)`, [role]);
  }

  /** Runs one statement as the actor and returns its rows. */
  async q(actor: Actor, sql: string, params: unknown[] = []): Promise<Row[]> {
    await this.become(actor);
    try {
      return (await this.pg.query(sql, params)).rows as Row[];
    } finally {
      // After an error the transaction is aborted and this fails too; the
      // caller (fails) rolls back to its savepoint, which restores the role.
      await this.pg.query(`select set_config('role', 'postgres', true)`).catch(() => {});
    }
  }

  /** First column of the first row. */
  async val(actor: Actor, sql: string, params: unknown[] = []): Promise<any> {
    const rows = await this.q(actor, sql, params);
    return rows.length ? Object.values(rows[0])[0] : undefined;
  }

  /** Calls a public RPC with named arguments and returns its result. */
  async rpc(actor: Actor, fn: string, args: Record<string, unknown> = {}): Promise<any> {
    const names = Object.keys(args);
    const list = names.map((name, i) => `${name} => $${i + 1}`).join(', ');
    return this.val(actor, `select public.${fn}(${list})`, names.map((name) => args[name]));
  }

  /** Asserts the statement raises, matching the message, and leaves the transaction usable. */
  async fails(actor: Actor, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
    const name = `sp_${++this.savepoint}`;
    await this.pg.query(`savepoint ${name}`);
    let error: Error | null = null;
    try {
      await this.q(actor, sql, params);
      // Deferred constraints only report at commit; surface them here.
      await this.pg.query('set constraints all immediate');
      await this.pg.query('set constraints all deferred');
    } catch (caught) {
      error = caught as Error;
    }
    await this.pg.query(`rollback to savepoint ${name}`);
    await this.pg.query(`select set_config('role', 'postgres', true)`);
    assert.ok(error, `expected failure matching ${pattern}, but it succeeded: ${sql}`);
    assert.match(error.message, pattern);
  }

  async rpcFails(actor: Actor, fn: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
    const names = Object.keys(args);
    const list = names.map((name, i) => `${name} => $${i + 1}`).join(', ');
    await this.fails(actor, `select public.${fn}(${list})`, names.map((name) => args[name]), pattern);
  }

  /** Moves the transaction's clock: now() is frozen per transaction, so tests shift data instead. */
  async sql(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.q('postgres', sql, params);
  }
}

/** Runs the body in a transaction that is always rolled back. */
export async function inTx(pg: PGlite, body: (t: Tx) => Promise<void>): Promise<void> {
  await pg.query('begin');
  try {
    await body(new Tx(pg));
  } finally {
    await pg.query('rollback');
  }
}

// ---------------------------------------------------------------------------
// Fixtures. Written as the database owner, the way no API caller can.
// ---------------------------------------------------------------------------

export interface Person {
  /** members.id */
  id: string;
  /** auth.users.id: pass as the actor to act as this member. */
  uid: string;
}

/** An anonymous Auth user, the only kind sign-in creates. `ticket` is the claim ticket it signed up with. */
export async function anonymousUser(t: Tx, ticket?: string): Promise<string> {
  return t.val('postgres', `insert into auth.users (is_anonymous, raw_user_meta_data) values (true, $1::jsonb) returning id`, [
    JSON.stringify(ticket ? { claim_ticket: ticket } : {}),
  ]);
}

export async function addMember(
  t: Tx,
  firstName: string,
  options: { role?: 'owner' | 'member'; claim?: boolean; status?: string } = {},
): Promise<Person> {
  const status = options.status ?? 'active';
  const id = await t.val(
    'postgres',
    `insert into public.members (first_name, last_initial, role, status, status_changed_at)
     values ($1, 'T', $2, $3, case when $3 = 'active' then null else now() end) returning id`,
    [firstName, options.role ?? 'member', status],
  );
  const uid = await anonymousUser(t);
  if (options.claim !== false) {
    await t.sql(`insert into private.auth_claims (auth_user_id, member_id) values ($1, $2)`, [uid, id]);
  }
  return { id, uid };
}

export interface Club {
  owner: Person;
  alice: Person;
  bob: Person;
  carol: Person;
}

/** Dino plus three signed-in members. */
export async function club(t: Tx): Promise<Club> {
  const owner = await addMember(t, 'Dino', { role: 'owner' });
  const alice = await addMember(t, 'Alice');
  const bob = await addMember(t, 'Bob');
  const carol = await addMember(t, 'Carol');
  return { owner, alice, bob, carol };
}

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);

// ---------------------------------------------------------------------------
// Scenario helpers: each drives the real RPCs as the right person.
// ---------------------------------------------------------------------------

export const MOVIE = {
  tmdb_id: 603,
  title: 'The Matrix',
  release_date: '1999-03-31',
  runtime_minutes: 136,
  overview: 'A hacker learns the truth.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  metadata: { genres: ['Action'] },
};

export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export async function makeEvent(t: Tx, c: Club, deadlineDays = 3): Promise<string> {
  return t.rpc(c.owner.uid, 'create_event', { p_movie: JSON.stringify(MOVIE), p_rsvp_deadline: inDays(deadlineDays) });
}

export async function makeTheater(t: Tx, c: Club, name = 'Cinemark'): Promise<string> {
  return t.rpc(c.owner.uid, 'save_theater', { p_theater_id: null, p_name: name, p_address: '1 Main St' });
}

export async function addShowtime(t: Tx, c: Club, event: string, theater: string, days: number, format = 'standard'): Promise<string> {
  return t.rpc(c.owner.uid, 'add_showtime', { p_event_id: event, p_theater_id: theater, p_starts_at: inDays(days), p_format: format });
}

/** The participant row id for a member (or a guest) at an event. */
export async function participantOf(t: Tx, event: string, who: { member?: string; guest?: string }): Promise<string> {
  return t.val(
    'postgres',
    `select id from public.event_participants where event_id = $1 and (member_id = $2 or guest_id = $3)`,
    [event, who.member ?? null, who.guest ?? null],
  );
}

/** Pretends the RSVP deadline has passed (now() is frozen inside a test's transaction). */
export async function passRsvpDeadline(t: Tx, event: string): Promise<void> {
  await t.sql(`update public.events set rsvp_deadline = now() - interval '1 minute' where id = $1`, [event]);
}

export interface Night {
  event: string;
  theater: string;
  early: string;
  late: string;
}

/** An event with two showtimes; Dino, Alice and Bob going or maybe, Carol can't. */
export async function night(t: Tx, c: Club): Promise<Night> {
  const event = await makeEvent(t, c);
  const theater = await makeTheater(t, c);
  const early = await addShowtime(t, c, event, theater, 10);
  const late = await addShowtime(t, c, event, theater, 11, 'imax');
  await t.rpc(c.owner.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' });
  await t.rpc(c.alice.uid, 'set_rsvp', { p_event_id: event, p_status: 'going' });
  await t.rpc(c.bob.uid, 'set_rsvp', { p_event_id: event, p_status: 'maybe' });
  await t.rpc(c.carol.uid, 'set_rsvp', { p_event_id: event, p_status: 'cant_go' });
  return { event, theater, early, late };
}
