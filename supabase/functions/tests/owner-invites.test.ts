// Tests for invite issuing: the handlers on their own, and the deployed shape
// (the real @supabase/server gate in front of them) with the network replaced
// by a stand-in. No Docker, database, or Supabase project is involved.
//
//   npm run test:functions
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterEach, before, beforeEach, test } from 'node:test';

import { inviteCodeHash, normalizeInviteCode } from '../_shared/invite-gateway.ts';
import {
  CUSTOM_CODE_TTL_MS,
  formatInviteCode,
  generateInviteCode,
  GENERATED_CODE_LENGTH,
  handleOwnerBootstrap,
  handleOwnerMembers,
  type IssueDeps,
} from '../_shared/owner-invites.ts';

// Test-only values. None of these is a real credential.
const HMAC_SECRET = 'test-only-hmac-secret-0123456789abcdef';
const MEMBER_ID = '0b5e4c1e-7a53-4f7e-9a39-0f6d3c1f2a10';

type Call = { fn: string; args: Record<string, string> };

function harness(answer: (call: Call) => { data?: unknown; error?: unknown }, overrides: Partial<IssueDeps> = {}) {
  const calls: Call[] = [];
  const logged: string[] = [];
  const deps: IssueDeps = {
    hmacSecret: HMAC_SECRET,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const r = answer({ fn, args });
      return { data: r.data ?? null, error: r.error ?? null };
    },
    log: (event) => logged.push(event),
    ...overrides,
  };
  return { deps, calls, logged };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://project.example.test/functions/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// --- code generation --------------------------------------------------------

test('generated codes satisfy the hashing contract', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const code = generateInviteCode();
    assert.equal(code.length, GENERATED_CODE_LENGTH);
    // Letters only, and none that are easy to misread or mistype.
    assert.match(code, /^[ABCDEFGHJKMNPRTW]{16}$/);
    assert.equal(normalizeInviteCode(code), code);
    assert.equal(normalizeInviteCode(formatInviteCode(code).toLowerCase()), code);
    seen.add(code);
  }
  assert.equal(seen.size, 500);
});

test('every byte value maps into the alphabet without bias', () => {
  const counts = new Map<string, number>();
  for (let b = 0; b < 256; b += 1) {
    const code = generateInviteCode(() => new Uint8Array(GENERATED_CODE_LENGTH).fill(b));
    counts.set(code[0], (counts.get(code[0]) ?? 0) + 1);
  }
  assert.equal(counts.size, 16);
  for (const n of counts.values()) assert.equal(n, 16);
});

test('formatInviteCode groups in fours', () => {
  assert.equal(formatInviteCode('ABCDEFGHJKLMNPQR'), 'ABCD-EFGH-JKLM-NPQR');
});

// --- owner-members ----------------------------------------------------------

test('create_member: stores only the hash and returns the code once', async () => {
  const { deps, calls, logged } = harness(() => ({ data: { member_id: MEMBER_ID, invite_id: 'x', expires_at: '2030-01-01T00:00:00Z' } }));
  const res = await handleOwnerMembers(post({ action: 'create_member', first_name: ' Erin ', last_initial: 'e' }), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.outcome, 'ok');
  assert.equal(body.member_id, MEMBER_ID);
  assert.match(body.invite_code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'create_member_with_invite');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_code_hash', 'p_first_name', 'p_last_initial']);
  assert.equal(calls[0].args.p_first_name, 'Erin');
  // The hash is the contract's HMAC of the returned code; the code itself is not sent.
  const canonical = normalizeInviteCode(body.invite_code)!;
  assert.equal(calls[0].args.p_code_hash, await inviteCodeHash(HMAC_SECRET, canonical));
  assert.equal(calls[0].args.p_code_hash, createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex'));
  assert.ok(!JSON.stringify(calls).includes(canonical));
  assert.deepEqual(logged, []);
});

test('the client cannot choose role, status, hash, or identity, and a code only through custom_code', async () => {
  const { deps, calls } = harness(() => ({ data: { member_id: MEMBER_ID } }));
  const res = await handleOwnerMembers(
    post({
      action: 'create_member',
      first_name: 'Erin',
      last_initial: 'E',
      role: 'owner',
      status: 'removed',
      auth_user_id: MEMBER_ID,
      p_code_hash: 'a'.repeat(64),
      code_hash: 'a'.repeat(64),
      invite_code: 'AAAAAAAAAAAAAAAA',
      owner_id: MEMBER_ID,
    }),
    deps,
  );
  const body = await res.json();
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_code_hash', 'p_first_name', 'p_last_initial']);
  assert.notEqual(calls[0].args.p_code_hash, 'a'.repeat(64));
  assert.notEqual(normalizeInviteCode(body.invite_code), 'AAAAAAAAAAAAAAAA');
});

test('create_invite: issues a replacement code for an existing member', async () => {
  const { deps, calls } = harness(() => ({ data: 'c7e0a2f4-52a1-4e0b-8a3a-000000000001' }));
  const res = await handleOwnerMembers(post({ action: 'create_invite', member_id: MEMBER_ID }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls[0].fn, 'create_member_invite');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_code_hash', 'p_member_id']);
  assert.equal(calls[0].args.p_code_hash, await inviteCodeHash(HMAC_SECRET, normalizeInviteCode(body.invite_code)!));
});

test('a non-owner is refused by the database and gets 403 with no code', async () => {
  const { deps } = harness(() => ({ error: { code: '42501', message: 'only the owner can create members' } }));
  for (const body of [
    { action: 'create_member', first_name: 'Erin', last_initial: 'E' },
    { action: 'create_invite', member_id: MEMBER_ID },
  ]) {
    const res = await handleOwnerMembers(post(body), deps);
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { outcome: 'forbidden' });
    assert.doesNotMatch(text, /only the owner|invite_code/);
  }
});

test('database errors never leak; malformed requests never reach the database', async () => {
  const leaky = harness(() => ({ error: { code: 'XX000', message: 'relation private.member_invites, hash deadbeef' } }));
  const res = await handleOwnerMembers(post({ action: 'create_member', first_name: 'Erin', last_initial: 'E' }), leaky.deps);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { outcome: 'server_error' });
  assert.deepEqual(leaky.logged, ['backend_error']);

  const notFound = harness(() => ({ error: { code: 'P0002' } }));
  assert.equal((await handleOwnerMembers(post({ action: 'create_invite', member_id: MEMBER_ID }), notFound.deps)).status, 404);
  const invalid = harness(() => ({ error: { code: '23514' } }));
  assert.equal((await handleOwnerMembers(post({ action: 'create_member', first_name: 'Erin', last_initial: 'E' }), invalid.deps)).status, 400);

  const quiet = harness(() => ({ data: null }));
  const bad: unknown[] = [
    {},
    { action: 'delete_everything' },
    { action: 'create_member', first_name: '', last_initial: 'E' },
    { action: 'create_member', first_name: 'Erin', last_initial: 'EE' },
    { action: 'create_member', first_name: 'x'.repeat(41), last_initial: 'E' },
    { action: 'create_member', first_name: 7, last_initial: 'E' },
    { action: 'create_invite', member_id: 'not-a-uuid' },
    { action: 'create_invite' },
    [],
    'not json',
    'x'.repeat(2000),
  ];
  for (const body of bad) {
    const r = await handleOwnerMembers(post(body), quiet.deps);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await handleOwnerMembers(new Request('https://x.test/', { method: 'GET' }), quiet.deps)).status, 405);
  assert.equal((await handleOwnerMembers(post({ action: 'create_invite', member_id: MEMBER_ID }, { 'content-type': 'text/plain' }), quiet.deps)).status, 400);
  assert.equal(quiet.calls.length, 0);
});

test('a missing or short HMAC secret fails closed before any database call', async () => {
  for (const hmacSecret of [undefined, '', 'short']) {
    const { deps, calls, logged } = harness(() => ({ data: { member_id: MEMBER_ID } }), { hmacSecret });
    const res = await handleOwnerMembers(post({ action: 'create_member', first_name: 'Erin', last_initial: 'E' }), deps);
    assert.equal(res.status, 500);
    assert.equal(calls.length, 0);
    assert.deepEqual(logged, ['misconfigured']);
  }
});

// --- owner-bootstrap --------------------------------------------------------

test('bootstrap: returns the owner invite code and stores only its hash', async () => {
  const { deps, calls } = harness(() => ({ data: { outcome: 'ok', mode: 'created', member_id: MEMBER_ID, expires_at: '2030-01-01T00:00:00Z' } }));
  const res = await handleOwnerBootstrap(post({ first_name: 'Dino', last_initial: 'W' }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.mode, 'created');
  assert.equal(calls[0].fn, 'bootstrap_owner_invite');
  assert.equal(calls[0].args.p_code_hash, await inviteCodeHash(HMAC_SECRET, normalizeInviteCode(body.invite_code)!));
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_code_hash', 'p_first_name', 'p_last_initial']);
});

test('bootstrap: closed is 409, whether the database answers or the grant is gone', async () => {
  const answered = harness(() => ({ data: { outcome: 'already_bootstrapped' } }));
  const revoked = harness(() => ({ error: { code: '42501', message: 'permission denied for function bootstrap_owner_invite' } }));
  for (const h of [answered, revoked]) {
    const res = await handleOwnerBootstrap(post({ first_name: 'Dino', last_initial: 'W' }), h.deps);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { outcome: 'already_bootstrapped' });
  }
  const bad = harness(() => ({ data: null }));
  assert.equal((await handleOwnerBootstrap(post({ first_name: 'Dino' }), bad.deps)).status, 400);
  assert.equal(bad.calls.length, 0);
});

// --- custom codes -----------------------------------------------------------

const NOW = Date.parse('2026-10-08T12:00:00Z');

test('custom code: hashed like any other, handed back in lower case, valid for 48 hours', async () => {
  const { deps, calls, logged } = harness(() => ({ data: { member_id: MEMBER_ID, expires_at: 'x' } }), { now: () => NOW });
  const res = await handleOwnerMembers(
    post({ action: 'create_member', first_name: 'Gavin', last_initial: 'G', custom_code: ' Kirby-Is The-Best ' }),
    deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.invite_code, 'kirbyisthebest');

  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_code_hash', 'p_expires_at', 'p_first_name', 'p_last_initial']);
  // The same hash the sign-in gateway computes when Gavin types it, however he types it.
  assert.equal(calls[0].args.p_code_hash, await inviteCodeHash(HMAC_SECRET, normalizeInviteCode('KIRBYISTHEBEST')!));
  assert.equal(calls[0].args.p_code_hash, await inviteCodeHash(HMAC_SECRET, normalizeInviteCode('kirby is the best')!));
  assert.equal(calls[0].args.p_expires_at, new Date(NOW + CUSTOM_CODE_TTL_MS).toISOString());
  assert.equal(CUSTOM_CODE_TTL_MS, 48 * 60 * 60 * 1000);
  assert.ok(!JSON.stringify(calls).toLowerCase().includes('kirbyisthebest'));
  assert.deepEqual(logged, []);
});

test('custom code: works for a replacement invite too', async () => {
  const { deps, calls } = harness(() => ({ data: 'c7e0a2f4-52a1-4e0b-8a3a-000000000001' }), { now: () => NOW });
  const res = await handleOwnerMembers(post({ action: 'create_invite', member_id: MEMBER_ID, custom_code: 'popcornforever' }), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).invite_code, 'popcornforever');
  assert.equal(calls[0].fn, 'create_member_invite');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_code_hash', 'p_expires_at', 'p_member_id']);
});

test('custom code: empty or absent means a random code with the normal expiry', async () => {
  for (const custom_code of [undefined, null, '']) {
    const { deps, calls } = harness(() => ({ data: { member_id: MEMBER_ID } }));
    const res = await handleOwnerMembers(post({ action: 'create_member', first_name: 'Erin', last_initial: 'E', custom_code }), deps);
    assert.match((await res.json()).invite_code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    assert.ok(!('p_expires_at' in calls[0].args));
  }
});

test('custom code: too short, too long, or not letters and numbers is refused before the database', async () => {
  const { deps, calls } = harness(() => ({ data: { member_id: MEMBER_ID } }));
  for (const custom_code of ['kirby', 'kirbyisbest', 'k i r b y', 'kirby_is_the_best', 'kirbyisthebest!', 'k'.repeat(33), '   ', 123456789012, ['kirbyisthebest'], {}]) {
    for (const request of [
      { action: 'create_member', first_name: 'Gavin', last_initial: 'G', custom_code },
      { action: 'create_invite', member_id: MEMBER_ID, custom_code },
    ]) {
      const res = await handleOwnerMembers(post(request), deps);
      assert.equal(res.status, 400, JSON.stringify(custom_code));
      assert.deepEqual(await res.json(), { outcome: 'invalid_code' });
    }
  }
  assert.equal(calls.length, 0);
});

test('custom code: a phrase that has been a code before is 409, and only then', async () => {
  const duplicate = { code: '23505', message: 'duplicate key value violates unique constraint "member_invites_code_hash_key"' };
  const taken = harness(() => ({ error: duplicate }));
  const res = await handleOwnerMembers(post({ action: 'create_member', first_name: 'Gavin', last_initial: 'G', custom_code: 'kirbyisthebest' }), taken.deps);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { outcome: 'code_taken' });

  // The same error for a random code is not the caller's doing: a plain server error.
  const random = harness(() => ({ error: duplicate }));
  const other = await handleOwnerMembers(post({ action: 'create_member', first_name: 'Gavin', last_initial: 'G' }), random.deps);
  assert.equal(other.status, 500);
  assert.deepEqual(await other.json(), { outcome: 'server_error' });
});

test('custom code: a non-owner still gets 403 from the database, and no code back', async () => {
  const { deps } = harness(() => ({ error: { code: '42501', message: 'only the owner can create members' } }));
  const res = await handleOwnerMembers(post({ action: 'create_member', first_name: 'Gavin', last_initial: 'G', custom_code: 'kirbyisthebest' }), deps);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { outcome: 'forbidden' });
});

test('bootstrap: the organizer never gets a custom code', async () => {
  const { deps, calls } = harness(() => ({ data: { outcome: 'ok', mode: 'created', expires_at: 'x' } }));
  const res = await handleOwnerBootstrap(post({ first_name: 'Dino', last_initial: 'W', custom_code: 'dinoisthebest' }), deps);
  const body = await res.json();
  assert.match(body.invite_code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.notEqual(calls[0].args.p_code_hash, await inviteCodeHash(HMAC_SECRET, 'DINOISTHEBEST'));
});

// --- deployed shape: the real @supabase/server gates -------------------------

const PUBLISHABLE_KEY = 'sb_publishable_TESTONLYnotarealkey';
const SECRET_KEY = 'sb_secret_TESTONLYnotarealkey';
const PROJECT_URL = 'https://project.example.test';

type Endpoint = { fetch: (req: Request) => Promise<Response> | Response };
let ownerMembers: Endpoint;
let ownerBootstrap: Endpoint;
let outbound: { url: string; apikey: string | null; authorization: string | null }[] = [];
let userJwt = '';
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

before(async () => {
  // An ES256 signing key standing in for the project's, published as JWKS.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test-key' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ iss: `${PROJECT_URL}/auth/v1`, sub: MEMBER_ID, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 600 }),
  );
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  userJwt = `${header}.${payload}.${b64url(signature)}`;

  process.env.SUPABASE_URL = PROJECT_URL;
  process.env.SUPABASE_PUBLISHABLE_KEYS = JSON.stringify({ default: PUBLISHABLE_KEY });
  process.env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET_KEY });
  process.env.SUPABASE_JWKS = JSON.stringify({ keys: [jwk] });
  process.env.INVITE_CODE_HMAC_SECRET = HMAC_SECRET;
  (globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => process.env[name] } };

  ownerMembers = (await import('../owner-members/index.ts')).default;
  ownerBootstrap = (await import('../owner-bootstrap/index.ts')).default;
});

beforeEach(() => {
  outbound = [];
  console.error = () => {};
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    outbound.push({ url: req.url, apikey: req.headers.get('apikey'), authorization: req.headers.get('authorization') });
    const fn = new URL(req.url).pathname.split('/').pop();
    if (fn === 'bootstrap_owner_invite') return Response.json({ outcome: 'ok', mode: 'created', expires_at: null });
    return Response.json({ member_id: MEMBER_ID, expires_at: null });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

const deployed = (path: string, headers: Record<string, string>, body: unknown) =>
  new Request(`${PROJECT_URL}/functions/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const CREATE = { action: 'create_member', first_name: 'Erin', last_initial: 'E' };

test('owner-members: no session, a publishable key alone, or a forged JWT is 401', async () => {
  const forged = userJwt.slice(0, -4) + 'AAAA';
  for (const headers of [
    {},
    { apikey: PUBLISHABLE_KEY },
    { apikey: SECRET_KEY },
    { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${forged}` },
    { apikey: PUBLISHABLE_KEY, authorization: 'Bearer not.a.jwt' },
  ] as Record<string, string>[]) {
    const res = await ownerMembers.fetch(deployed('owner-members', headers, CREATE));
    assert.equal(res.status, 401, JSON.stringify(Object.keys(headers)));
    assert.doesNotMatch(await res.text(), /invite_code/);
  }
  assert.equal(outbound.length, 0);
});

test('owner-members: a signed-in caller reaches the database as themselves, never as service_role', async () => {
  const res = await ownerMembers.fetch(deployed('owner-members', { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${userJwt}` }, CREATE));
  assert.equal(res.status, 200);
  assert.equal(outbound.length, 1);
  assert.match(outbound[0].url, /\/rest\/v1\/rpc\/create_member_with_invite$/);
  assert.equal(outbound[0].authorization, `Bearer ${userJwt}`);
  assert.notEqual(outbound[0].apikey, SECRET_KEY);
  assert.ok(!outbound[0].authorization?.includes(SECRET_KEY));
});

test('owner-bootstrap: only the secret key opens it', async () => {
  const body = { first_name: 'Dino', last_initial: 'W' };
  for (const headers of [
    {},
    { apikey: PUBLISHABLE_KEY },
    { apikey: 'sb_secret_WRONGnotarealkey' },
    { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${userJwt}` },
  ] as Record<string, string>[]) {
    const res = await ownerBootstrap.fetch(deployed('owner-bootstrap', headers, body));
    assert.equal(res.status, 401, JSON.stringify(Object.keys(headers)));
  }
  assert.equal(outbound.length, 0);

  const res = await ownerBootstrap.fetch(deployed('owner-bootstrap', { apikey: SECRET_KEY }, body));
  assert.equal(res.status, 200);
  assert.match(outbound[0].url, /\/rest\/v1\/rpc\/bootstrap_owner_invite$/);
  assert.equal(outbound[0].apikey, SECRET_KEY);
});
