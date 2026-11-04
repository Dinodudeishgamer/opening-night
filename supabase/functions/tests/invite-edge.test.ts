// Tests for the deployed shape of the two invite endpoints: the real
// @supabase/server publishable-key gate in front of the gateway handlers.
// The network is replaced by a stand-in for the project's REST API, so no
// Docker, database, or Supabase project is involved.
//
//   npm run test:functions
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, before, beforeEach, test } from 'node:test';

// Test-only values. None of these is a real credential.
const PUBLISHABLE_KEY = 'sb_publishable_TESTONLYnotarealkey';
const SECRET_KEY = 'sb_secret_TESTONLYnotarealkey';
const HMAC_SECRET = 'test-only-hmac-secret-0123456789abcdef';
const LEGACY_ANON_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.dGVzdG9ubHk';
const PROJECT_URL = 'https://project.example.test';
const CODE = 'ABCD2345EFGH';

type Endpoint = { fetch: (req: Request) => Promise<Response> | Response };
let preview: Endpoint;
let claimBegin: Endpoint;

type Outbound = { url: string; apikey: string | null; authorization: string | null; body: string };
let outbound: Outbound[] = [];
let logged: string[] = [];
const realFetch = globalThis.fetch;
const realConsoleError = console.error;

before(async () => {
  // What the Edge runtime provides: Deno.env, with the platform's variables.
  process.env.SUPABASE_URL = PROJECT_URL;
  process.env.SUPABASE_PUBLISHABLE_KEYS = JSON.stringify({ default: PUBLISHABLE_KEY });
  process.env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET_KEY });
  process.env.INVITE_CODE_HMAC_SECRET = HMAC_SECRET;
  (globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => process.env[name] } };

  preview = (await import('../invite-preview/index.ts')).default;
  claimBegin = (await import('../invite-claim-begin/index.ts')).default;
});

beforeEach(() => {
  outbound = [];
  logged = [];
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(' '));
  };
  // Stand-in for the project's REST API.
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    outbound.push({
      url: req.url,
      apikey: req.headers.get('apikey'),
      authorization: req.headers.get('authorization'),
      body: await req.text(),
    });
    const fn = new URL(req.url).pathname.split('/').pop();
    const data =
      fn === 'preview_member_invite'
        ? { outcome: 'ok', first_name: 'Alice', last_initial: 'A' }
        : fn === 'begin_invite_claim'
          ? { outcome: 'ok' }
          : true;
    return Response.json(data);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

function post(path: string, headers: Record<string, string>, body: unknown = { invite_code: CODE }) {
  return new Request(`${PROJECT_URL}/functions/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const endpoints = () => [
  { name: 'invite-preview', endpoint: preview },
  { name: 'invite-claim-begin', endpoint: claimBegin },
];

test('a request without an apikey is rejected before the handler', async () => {
  for (const { name, endpoint } of endpoints()) {
    const res = await endpoint.fetch(post(name, {}));
    assert.equal(res.status, 401);
    assert.equal(outbound.length, 0);
  }
});

test('a malformed or incorrect apikey is rejected before the handler', async () => {
  const wrongKeys = [
    'sb_publishable_someotherproject',
    'not-a-key',
    '',
    LEGACY_ANON_JWT,
    // The secret key is not a way in either: it must never be in a client.
    SECRET_KEY,
  ];
  for (const { name, endpoint } of endpoints()) {
    for (const apikey of wrongKeys) {
      const res = await endpoint.fetch(post(name, { apikey }));
      assert.equal(res.status, 401, `${name} accepted apikey "${apikey.slice(0, 16)}"`);
    }
    // A bearer token is no substitute for the apikey header.
    for (const authorization of [`Bearer ${PUBLISHABLE_KEY}`, `Bearer ${LEGACY_ANON_JWT}`]) {
      const res = await endpoint.fetch(post(name, { authorization }));
      assert.equal(res.status, 401);
    }
  }
  assert.equal(outbound.length, 0);
});

test('spoofed address headers do not get a caller past the key check', async () => {
  const res = await preview.fetch(post('invite-preview', { 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1' }));
  assert.equal(res.status, 401);
  assert.equal(outbound.length, 0);
});

test('the publishable key alone reaches the preview handler; no user JWT is needed', async () => {
  const res = await preview.fetch(post('invite-preview', { apikey: PUBLISHABLE_KEY }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { outcome: 'ok', first_name: 'Alice', last_initial: 'A' });
  assert.deepEqual(outbound.map((o) => o.url), [`${PROJECT_URL}/rest/v1/rpc/preview_member_invite`]);
});

test('the publishable key alone reaches the claim handler', async () => {
  const res = await claimBegin.fetch(post('invite-claim-begin', { apikey: PUBLISHABLE_KEY }));
  assert.equal(res.status, 200);
  const answer = (await res.json()) as { outcome: string; claim_ticket: string };
  assert.equal(answer.outcome, 'ok');
  assert.match(answer.claim_ticket, /^[0-9a-f]{64}$/);
  assert.deepEqual(outbound.map((o) => o.url), [`${PROJECT_URL}/rest/v1/rpc/begin_invite_claim`]);
  // The database gets the ticket's hash, never the ticket.
  assert.ok(!outbound[0].body.includes(answer.claim_ticket));
});

test('supabase-js style headers (apikey plus the same key as bearer) are accepted', async () => {
  const res = await preview.fetch(post('invite-preview', { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${PUBLISHABLE_KEY}` }));
  assert.equal(res.status, 200);
});

test('gateway behavior is unchanged behind the key check', async () => {
  const get = await preview.fetch(new Request(`${PROJECT_URL}/functions/v1/invite-preview`, { method: 'GET', headers: { apikey: PUBLISHABLE_KEY } }));
  assert.equal(get.status, 405);
  const malformed = await preview.fetch(post('invite-preview', { apikey: PUBLISHABLE_KEY }, { invite_code: '' }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { outcome: 'invalid_request' });
  const oversized = await preview.fetch(post('invite-preview', { apikey: PUBLISHABLE_KEY }, { invite_code: CODE, padding: 'x'.repeat(2000) }));
  assert.equal(oversized.status, 400);
  assert.equal(outbound.length, 0);
});

test('the privileged client stays server-side', async () => {
  const responses: string[] = [];
  for (const { name, endpoint } of endpoints()) {
    const attempts: Record<string, string>[] = [{ apikey: PUBLISHABLE_KEY }, {}, { apikey: 'sb_publishable_wrong' }];
    for (const headers of attempts) {
      const res = await endpoint.fetch(post(name, headers));
      responses.push(await res.text(), JSON.stringify([...res.headers]));
    }
  }

  // The database is called with the secret key, never the caller's key...
  assert.ok(outbound.length > 0);
  for (const call of outbound) {
    assert.ok(call.url.startsWith(`${PROJECT_URL}/rest/v1/rpc/`));
    assert.equal(call.apikey, SECRET_KEY);
    assert.ok(!call.authorization?.includes(PUBLISHABLE_KEY));
  }
  // ...and neither it, the HMAC secret, nor invite material comes back or is logged.
  const visible = [...responses, ...logged].join('\n');
  for (const value of [SECRET_KEY, HMAC_SECRET, CODE, 'p_code_hash']) {
    assert.ok(!visible.includes(value), `leaked "${value}"`);
  }
  // The code and the HMAC secret never go to the database either: only the hash does.
  for (const call of outbound) {
    assert.ok(!call.body.includes(CODE) && !call.body.includes(HMAC_SECRET));
  }
});

test('without a configured secret key the endpoint fails closed with a generic 500', async () => {
  const saved = process.env.SUPABASE_SECRET_KEYS;
  delete process.env.SUPABASE_SECRET_KEYS;
  try {
    const res = await preview.fetch(post('invite-preview', { apikey: PUBLISHABLE_KEY }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { outcome: 'server_error' });
    assert.equal(outbound.length, 0);
  } finally {
    process.env.SUPABASE_SECRET_KEYS = saved;
  }
});

test('config.toml keeps verify_jwt = false for both functions, and the wrapper does the authorizing', () => {
  const config = readFileSync(new URL('../../config.toml', import.meta.url), 'utf8');
  for (const name of ['invite-preview', 'invite-claim-begin']) {
    const start = config.indexOf(`[functions.${name}]`);
    assert.ok(start >= 0, `${name} is missing from config.toml`);
    const next = config.indexOf('\n[', start + 1);
    const block = config.slice(start, next === -1 ? undefined : next);
    assert.match(block, /^verify_jwt = false$/m);
  }
  const edge = readFileSync(new URL('../_shared/edge.ts', import.meta.url), 'utf8');
  assert.match(edge, /withSupabase\(\s*\{ auth: 'publishable'/);
});
