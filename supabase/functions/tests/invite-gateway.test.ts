// Tests for the pre-auth invite gateway. No Docker, database, or network: the
// database is a small in-memory stand-in that follows the outcomes documented
// in the member_access and code_only_sign_in migrations.
//
//   npm run test:functions
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';

import {
  claimTicketHash,
  clientAddress,
  clientKeyHash,
  type GatewayDeps,
  handleInviteClaimBegin,
  handleInvitePreview,
  INVITE_CODE_MIN_LENGTH,
  inviteCodeHash,
  newClaimTicket,
  normalizeInviteCode,
  type RpcResult,
} from '../_shared/invite-gateway.ts';

// Test-only values. None of these is a real credential.
const SECRET = 'test-only-hmac-secret-0123456789abcdef';
const FAKE_SERVICE_KEY = 'sb_secret_TESTONLYnotarealkey';
const CODE = 'ABCD2345EFGH';
const HEX_64 = /^[0-9a-f]{64}$/;

type Invite = { first_name: string; last_initial: string };
type Call = { fn: string; args: Record<string, string> };

// Everything the gateway writes anywhere: its log callback and the console.
let logged: string[] = [];
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originalConsole = new Map(consoleMethods.map((m) => [m, console[m]]));

beforeEach(() => {
  logged = [];
  for (const m of consoleMethods) {
    console[m] = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(' '));
    };
  }
});

afterEach(() => {
  for (const m of consoleMethods) console[m] = originalConsole.get(m)!;
});

async function fakeDatabase(options: {
  invite?: Invite;
  previewAllowed?: boolean;
  failWith?: unknown;
} = {}) {
  const invites = new Map<string, Invite>();
  if (options.invite) invites.set(await inviteCodeHash(SECRET, CODE), options.invite);
  const calls: Call[] = [];

  const rpc = async (fn: string, args: Record<string, string>): Promise<RpcResult> => {
    calls.push({ fn, args });
    if (options.failWith !== undefined) return { data: null, error: options.failWith };
    if (options.previewAllowed === false) return { data: { outcome: 'rate_limited' }, error: null };

    const invite = invites.get(args.p_code_hash);
    if (!invite) return { data: { outcome: 'invalid_invite' }, error: null };
    if (fn === 'preview_member_invite') {
      return {
        data: {
          outcome: 'ok',
          first_name: invite.first_name,
          last_initial: invite.last_initial,
          // Not part of the real function's result. Present to prove the
          // gateway forwards an allow-list, not whatever the database returns.
          member_id: '11111111-2222-3333-4444-555555555555',
          code_hash: args.p_code_hash,
        },
        error: null,
      };
    }
    if (fn === 'begin_invite_claim') return { data: { outcome: 'ok' }, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  };

  const deps: GatewayDeps = { rpc, hmacSecret: SECRET, log: (event) => logged.push(event) };
  return { deps, calls };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/functions/v1/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(response: Response) {
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const alice: Invite = { first_name: 'Alice', last_initial: 'A' };

// --- normalization and hashing ----------------------------------------------

test('invite codes normalize case, spaces and hyphens to one form', () => {
  for (const raw of ['ABCD2345EFGH', 'abcd2345efgh', 'abcd-2345-efgh', ' ABCD 2345 EFGH ', 'ab-cd-23-45-ef-gh']) {
    assert.equal(normalizeInviteCode(raw), CODE);
  }
});

test('malformed invite codes are rejected before hashing', () => {
  for (const raw of ['', '   ', 'ABC', 'ABCD2345', 'ABCD2345EFG', 'ABCD_2345_EFGH', 'ABCD2345EFGH!', 'ÀBCD2345EFGH', 'A'.repeat(33), 'A'.repeat(65), null, undefined, 123456789012, {}, ['ABCD2345EFGH']]) {
    assert.equal(normalizeInviteCode(raw), null);
  }
});

test('the HMAC is deterministic for the same normalized code', async () => {
  const first = await inviteCodeHash(SECRET, normalizeInviteCode('abcd-2345-efgh')!);
  const second = await inviteCodeHash(SECRET, normalizeInviteCode(' ABCD 2345 EFGH ')!);
  assert.equal(first, second);
  assert.match(first, HEX_64);
});

test('different codes, and different secrets, give different hashes', async () => {
  const base = await inviteCodeHash(SECRET, CODE);
  assert.notEqual(base, await inviteCodeHash(SECRET, 'ABCD2345EFGJ'));
  assert.notEqual(base, await inviteCodeHash(SECRET + 'x', CODE));
});

test('the invite and client hashes of the same text never coincide', async () => {
  assert.notEqual(await inviteCodeHash(SECRET, CODE), await clientKeyHash(SECRET, CODE));
});

test('claim tickets are 256 random bits, and their hash is plain SHA-256 in hex', async () => {
  const tickets = new Set(Array.from({ length: 50 }, newClaimTicket));
  assert.equal(tickets.size, 50);
  for (const ticket of tickets) assert.match(ticket, HEX_64);
  // What private.claim_ticket_hash computes in the database.
  const ticket = newClaimTicket();
  assert.equal(await claimTicketHash(ticket), createHash('sha256').update(ticket, 'utf8').digest('hex'));
});

test('client address prefers cf-connecting-ip, then x-forwarded-for, then a shared bucket', () => {
  assert.equal(clientAddress(new Headers({ 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' })), '198.51.100.4');
  assert.equal(clientAddress(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(clientAddress(new Headers({ 'x-forwarded-for': 'not an address' })), 'unknown');
  assert.equal(clientAddress(new Headers()), 'unknown');
});

// --- invite-preview ---------------------------------------------------------

test('valid invite preview returns only the pre-auth fields', async () => {
  const { deps, calls } = await fakeDatabase({ invite: alice });
  const res = await read(await handleInvitePreview(post({ invite_code: 'abcd-2345-efgh' }), deps));

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { outcome: 'ok', first_name: 'Alice', last_initial: 'A' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'preview_member_invite');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_client_key_hash', 'p_code_hash']);
  assert.equal(calls[0].args.p_code_hash, await inviteCodeHash(SECRET, CODE));
  assert.equal(calls[0].args.p_client_key_hash, await clientKeyHash(SECRET, '203.0.113.7'));
  assert.match(calls[0].args.p_client_key_hash, HEX_64);
});

test('an unknown code is invalid_invite, with nothing about why', async () => {
  const { deps } = await fakeDatabase({ invite: alice });
  const res = await read(await handleInvitePreview(post({ invite_code: 'ZZZZ9999ZZZZ' }), deps));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { outcome: 'invalid_invite' });
});

test('malformed preview requests get a generic 400 and never reach the database', async () => {
  const { deps, calls } = await fakeDatabase({ invite: alice });
  const requests = [
    post({ invite_code: '' }),
    post({ invite_code: '   ' }),
    post({ invite_code: 'A'.repeat(200) }),
    post({ invite_code: 123456789012 }),
    post({ invite_code: 'ABCD2345' }),
    post({}),
    post('not json'),
    post('[]'),
    post('null'),
    post({ invite_code: CODE, padding: 'x'.repeat(2000) }),
    post({ invite_code: CODE }, { 'content-type': 'text/plain' }),
  ];
  for (const request of requests) {
    const res = await read(await handleInvitePreview(request, deps));
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { outcome: 'invalid_request' });
  }
  assert.equal(calls.length, 0);
});

test('only POST is accepted', async () => {
  const { deps, calls } = await fakeDatabase({ invite: alice });
  const res = await read(await handleInvitePreview(new Request('https://example.test/', { method: 'GET' }), deps));
  assert.equal(res.status, 405);
  assert.equal(calls.length, 0);
});

test('a preview rate-limit refusal is surfaced as a bare 429', async () => {
  const { deps } = await fakeDatabase({ invite: alice, previewAllowed: false });
  const res = await read(await handleInvitePreview(post({ invite_code: CODE }), deps));
  assert.equal(res.status, 429);
  assert.deepEqual(res.json, { outcome: 'rate_limited' });
});

test('a missing or short secret is a generic 500 and the database is not called', async () => {
  for (const hmacSecret of [undefined, '', 'too-short']) {
    const { deps, calls } = await fakeDatabase({ invite: alice });
    const res = await read(await handleInvitePreview(post({ invite_code: CODE }), { ...deps, hmacSecret }));
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { outcome: 'server_error' });
    assert.equal(calls.length, 0);
  }
});

test('database errors become a generic 500 with no SQL detail', async () => {
  const sqlError = {
    code: '42501',
    message: 'permission denied for function preview_member_invite',
    details: `Failing row contains (${FAKE_SERVICE_KEY})`,
    hint: 'select * from private.member_invites',
  };
  for (const handler of [handleInvitePreview, handleInviteClaimBegin]) {
    const { deps } = await fakeDatabase({ invite: alice, failWith: sqlError });
    const res = await read(await handler(post({ invite_code: CODE }), deps));
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { outcome: 'server_error' });
  }
  const everything = logged.join('\n');
  for (const leak of ['permission denied', 'member_invites', '42501', FAKE_SERVICE_KEY]) {
    assert.ok(!everything.includes(leak), `log leaked "${leak}"`);
  }
});

test('a thrown backend failure and an unrecognized outcome are also generic 500s', async () => {
  const { deps } = await fakeDatabase();
  const throwing: GatewayDeps = { ...deps, rpc: () => Promise.reject(new Error(`connect failed ${FAKE_SERVICE_KEY}`)) };
  const strange: GatewayDeps = { ...deps, rpc: async () => ({ data: { outcome: 'something_new', secret: 'x' }, error: null }) };
  for (const broken of [throwing, strange]) {
    const res = await read(await handleInvitePreview(post({ invite_code: CODE }), broken));
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { outcome: 'server_error' });
  }
  assert.ok(!logged.join('\n').includes(FAKE_SERVICE_KEY));
});

// --- invite-claim-begin -----------------------------------------------------

test('beginning a claim returns a ticket and gives the database only its hash', async () => {
  const { deps, calls } = await fakeDatabase({ invite: alice });
  const res = await read(await handleInviteClaimBegin(post({ invite_code: 'abcd 2345 efgh' }), deps));

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['claim_ticket', 'outcome']);
  assert.equal(res.json.outcome, 'ok');
  const ticket = res.json.claim_ticket as string;
  assert.match(ticket, HEX_64);

  assert.deepEqual(calls.map((c) => c.fn), ['begin_invite_claim']);
  assert.deepEqual(calls[0].args, {
    p_code_hash: await inviteCodeHash(SECRET, CODE),
    p_ticket_hash: await claimTicketHash(ticket),
    p_client_key_hash: await clientKeyHash(SECRET, '203.0.113.7'),
  });
  assert.notEqual(calls[0].args.p_ticket_hash, ticket);
});

test('every claim attempt gets its own ticket', async () => {
  const { deps } = await fakeDatabase({ invite: alice });
  const first = await read(await handleInviteClaimBegin(post({ invite_code: CODE }), deps));
  const second = await read(await handleInviteClaimBegin(post({ invite_code: CODE }), deps));
  assert.notEqual(first.json.claim_ticket, second.json.claim_ticket);
});

test('no ticket is handed out without a valid code', async () => {
  const { deps, calls } = await fakeDatabase({ invite: alice });
  const unknown = await read(await handleInviteClaimBegin(post({ invite_code: 'ZZZZ9999ZZZZ' }), deps));
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, { outcome: 'invalid_invite' });

  const before = calls.length;
  for (const body of [{}, { invite_code: '' }, { invite_code: 'ABCD2345' }, { invite_code: 123456789012 }]) {
    const res = await read(await handleInviteClaimBegin(post(body), deps));
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { outcome: 'invalid_request' });
  }
  assert.equal(calls.length, before);
});

test('a claim rate-limit refusal is surfaced as a bare 429', async () => {
  const { deps, calls } = await fakeDatabase({ invite: alice, previewAllowed: false });
  const res = await read(await handleInviteClaimBegin(post({ invite_code: CODE }), deps));
  assert.equal(res.status, 429);
  assert.deepEqual(res.json, { outcome: 'rate_limited' });
  assert.deepEqual(calls.map((c) => c.fn), ['begin_invite_claim']);
});

// --- leakage ----------------------------------------------------------------

test('codes, hashes, tickets, the secret and credentials never appear where they should not', async () => {
  const rawCode = 'abcd-2345-efgh';
  const outputs: string[] = [];
  const run = async (handler: typeof handleInvitePreview, body: unknown, options: Parameters<typeof fakeDatabase>[0]) => {
    const { deps, calls } = await fakeDatabase(options);
    const res = await read(await handler(post(body), deps));
    outputs.push(res.text);
    return calls;
  };

  const sqlError = { code: 'XX000', message: `boom ${FAKE_SERVICE_KEY} ${SECRET}` };
  const body = { invite_code: rawCode };
  const calls = [
    ...(await run(handleInvitePreview, body, { invite: alice })),
    ...(await run(handleInvitePreview, { invite_code: 'ZZZZ-9999-ZZZZ' }, { invite: alice })),
    ...(await run(handleInvitePreview, body, { invite: alice, previewAllowed: false })),
    ...(await run(handleInvitePreview, body, { invite: alice, failWith: sqlError })),
    ...(await run(handleInviteClaimBegin, body, { invite: alice })),
    ...(await run(handleInviteClaimBegin, body, { invite: alice, previewAllowed: false })),
    ...(await run(handleInviteClaimBegin, body, { invite: alice, failWith: sqlError })),
  ];

  const hashes = calls.flatMap((c) => Object.values(c.args)).filter((v) => HEX_64.test(v));
  assert.ok(hashes.length > 0);
  const forbidden = [rawCode, CODE, 'ZZZZ-9999-ZZZZ', 'ZZZZ9999ZZZZ', SECRET, FAKE_SERVICE_KEY, 'member_id', 'code_hash', ...hashes];

  const responses = outputs.join('\n');
  const logs = logged.join('\n');
  for (const value of forbidden) {
    assert.ok(!responses.includes(value), `a response leaked "${value}"`);
    assert.ok(!logs.includes(value), `a log leaked "${value}"`);
  }
  // The caller's own ticket comes back on ok, once; it is never logged and never sent to the database.
  const tickets = outputs.flatMap((text) => {
    const ticket = (JSON.parse(text) as { claim_ticket?: string }).claim_ticket;
    return ticket ? [ticket] : [];
  });
  assert.equal(tickets.length, 1);
  for (const ticket of tickets) {
    assert.ok(!logs.includes(ticket));
    assert.ok(calls.every((c) => !Object.values(c.args).includes(ticket)));
  }

  // The secret is only ever used as a key: no database argument contains it or the code.
  for (const value of calls.flatMap((c) => Object.values(c.args))) {
    assert.ok(!value.includes(SECRET) && !value.toUpperCase().includes(CODE));
  }
});

// --- hashing contract and what guessing safety rests on ---------------------

test('code_hash is the plain HMAC-SHA-256 of the normalized code in lowercase hex', async () => {
  // Computed independently of the gateway, the way the contract states it and
  // the way `openssl dgst -sha256 -hmac` would for the owner bootstrap.
  const expected = createHmac('sha256', SECRET).update(CODE, 'utf8').digest('hex');
  assert.equal(await inviteCodeHash(SECRET, normalizeInviteCode('abcd-2345-efgh')!), expected);
  assert.match(expected, HEX_64);
});

test('guessing safety does not rest on address headers', async () => {
  // The floor on code length is what makes guessing infeasible. A code below
  // it is refused before the database, whatever address the caller claims.
  assert.ok(INVITE_CODE_MIN_LENGTH >= 12);
  const spoofed: Record<string, string>[] = [
    {},
    { 'x-forwarded-for': '198.51.100.1' },
    { 'x-forwarded-for': '198.51.100.2', 'cf-connecting-ip': '198.51.100.3' },
    { 'x-forwarded-for': 'garbage, more garbage', 'x-real-ip': '198.51.100.4' },
  ];
  const short = await fakeDatabase({ invite: alice });
  for (const headers of spoofed) {
    const res = await read(await handleInvitePreview(post({ invite_code: 'A'.repeat(INVITE_CODE_MIN_LENGTH - 1) }, headers), short.deps));
    assert.equal(res.status, 400);
  }
  assert.equal(short.calls.length, 0);

  // Address headers change only the auxiliary per-client subject. The code
  // hash the database judges is the same whatever they say.
  const seen = await fakeDatabase({ invite: alice });
  for (const headers of spoofed) {
    await handleInviteClaimBegin(post({ invite_code: CODE }, headers), seen.deps);
  }
  const claims = seen.calls.filter((c) => c.fn === 'begin_invite_claim');
  assert.equal(claims.length, spoofed.length);
  assert.equal(new Set(claims.map((c) => c.args.p_code_hash)).size, 1);

  // A refusal from the database (its per-invite limit included) is final:
  // no header gets around it or turns it into anything but a 429.
  const locked = await fakeDatabase({ invite: alice, previewAllowed: false });
  for (const headers of spoofed) {
    const res = await read(await handleInviteClaimBegin(post({ invite_code: CODE }, headers), locked.deps));
    assert.equal(res.status, 429);
    assert.deepEqual(res.json, { outcome: 'rate_limited' });
  }
  assert.ok(locked.calls.every((c) => c.fn === 'begin_invite_claim'));
});
