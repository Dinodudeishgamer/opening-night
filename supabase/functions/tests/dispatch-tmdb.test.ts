// Tests for the notification dispatcher and the TMDB proxy. Providers and the
// database are stand-ins: nothing is sent anywhere.
//
//   npm run test:functions
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleDispatch, type DispatchDeps } from '../_shared/dispatch.ts';
import { handleTmdb, type TmdbDeps } from '../_shared/tmdb.ts';

const post = (body: unknown = {}) =>
  new Request('https://project.example.test/functions/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// --- dispatcher -------------------------------------------------------------

// Test-only values; none is a real token or credential.
const TOKEN_A = 'ExponentPushToken[testonlyAAAAAAAAAA]';
const TOKEN_B = 'ExponentPushToken[testonlyBBBBBBBBBB]';

function job(id: string, token: string, priority = 'default') {
  return { delivery_id: id, token, title: 'Tickets are bought', body: 'Your share is ready.', data: { event_id: 'e1' }, priority };
}

function dispatchHarness(options: {
  claims: unknown[];
  expo?: (url: string, body: any) => unknown;
}) {
  const rpcCalls: { fn: string; args: any }[] = [];
  const http: { url: string; headers: Record<string, string>; body: string }[] = [];
  const logged: string[] = [];
  let claimIndex = 0;
  const deps: DispatchDeps = {
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      if (fn === 'dispatch_claim') return { data: options.claims[claimIndex++] ?? { push: [], receipts: [] }, error: null };
      return { data: null, error: null };
    },
    fetch: (async (input: any, init: any) => {
      const url = String(input);
      http.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? '') });
      return Response.json(options.expo ? options.expo(url, JSON.parse(String(init.body))) : { data: [] });
    }) as typeof fetch,
    log: (event) => logged.push(event),
  };
  return { deps, rpcCalls, http, logged };
}

test('dispatch: sends claimed pushes through Expo and reports each outcome', async () => {
  const h = dispatchHarness({
    claims: [{ push: [job('d1', TOKEN_A), job('d2', TOKEN_B, 'high'), job('d3', TOKEN_B)], receipts: [] }],
    expo: () => ({
      data: [
        { status: 'ok', id: 'ticket-1' },
        { status: 'error', message: `"${TOKEN_B}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
      ],
    }),
  });
  const res = await handleDispatch(post(), h.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { outcome: 'ok', pushed: 1, failed: 2, receipts: 0 });

  assert.equal(h.http.length, 1);
  assert.equal(h.http[0].url, 'https://exp.host/--/api/v2/push/send');
  const sent = JSON.parse(h.http[0].body);
  assert.deepEqual(sent.map((m: any) => [m.to, m.priority]), [[TOKEN_A, 'default'], [TOKEN_B, 'high'], [TOKEN_B, 'default']]);

  const report = h.rpcCalls.find((c) => c.fn === 'dispatch_report')!.args.p_results;
  assert.deepEqual(report.push, [
    { delivery_id: 'd1', status: 'sent', ticket_id: 'ticket-1' },
    { delivery_id: 'd2', status: 'dead', error: 'DeviceNotRegistered' },
    { delivery_id: 'd3', status: 'failed', error: 'MessageRateExceeded' },
  ]);
  // Provider free text (which echoed a token) is never stored or returned.
  assert.ok(!JSON.stringify(report).includes('ExponentPushToken'));
  assert.deepEqual(h.logged, []);
});

test('dispatch: a provider outage fails the batch without losing it', async () => {
  for (const expo of [
    () => {
      throw new Error('boom');
    },
    () => ({ data: [{ status: 'ok', id: 'only-one' }] }),
  ]) {
    const h = dispatchHarness({ claims: [{ push: [job('d1', TOKEN_A), job('d2', TOKEN_B)], receipts: [] }], expo });
    const res = await handleDispatch(post(), h.deps);
    assert.equal(res.status, 200);
    const report = h.rpcCalls.find((c) => c.fn === 'dispatch_report')!.args.p_results;
    assert.deepEqual(report.push.map((r: any) => r.status), ['failed', 'failed']);
  }
});

test('dispatch: checks receipts and switches off dead devices', async () => {
  const h = dispatchHarness({
    claims: [{ push: [], receipts: [{ delivery_id: 'd1', ticket_id: 't1' }, { delivery_id: 'd2', ticket_id: 't2' }, { delivery_id: 'd3', ticket_id: 't3' }] }],
    expo: (url, body) => {
      assert.equal(url, 'https://exp.host/--/api/v2/push/getReceipts');
      assert.deepEqual(body, { ids: ['t1', 't2', 't3'] });
      return { data: { t1: { status: 'ok' }, t2: { status: 'error', details: { error: 'DeviceNotRegistered' } } } };
    },
  });
  await handleDispatch(post(), h.deps);
  const report = h.rpcCalls.find((c) => c.fn === 'dispatch_report')!.args.p_results;
  // t3 has no receipt yet: left for the next run.
  assert.deepEqual(report.receipts, [
    { delivery_id: 'd1', status: 'ok' },
    { delivery_id: 'd2', status: 'dead', error: 'DeviceNotRegistered' },
  ]);
});

test('dispatch: keeps claiming while batches are full, and stops on a failed report', async () => {
  const full = Array.from({ length: 100 }, (_, i) => job(`d${i}`, TOKEN_A));
  const h = dispatchHarness({
    claims: [{ push: full, receipts: [] }, { push: [job('last', TOKEN_B)], receipts: [] }],
    expo: (_url, body) => ({ data: body.map((_: unknown, i: number) => ({ status: 'ok', id: `t${i}` })) }),
  });
  const res = await handleDispatch(post(), h.deps);
  assert.equal((await res.json()).pushed, 101);
  assert.equal(h.rpcCalls.filter((c) => c.fn === 'dispatch_claim').length, 2);

  const broken = dispatchHarness({ claims: [{ push: full, receipts: [] }, { push: full, receipts: [] }], expo: (_u, body) => ({ data: body.map(() => ({ status: 'ok', id: 't' })) }) });
  const realRpc = broken.deps.rpc;
  broken.deps.rpc = async (fn, args) => (fn === 'dispatch_report' ? { data: null, error: { code: 'XX000' } } : realRpc(fn, args));
  const failed = await handleDispatch(post(), broken.deps);
  assert.equal(failed.status, 500);
  assert.equal(broken.http.length, 1, 'no second batch after a failed report');
  assert.deepEqual(broken.logged, ['report_failed']);
});

test('dispatch: bad claim and wrong method', async () => {
  const h = dispatchHarness({ claims: ['not an object'] });
  assert.equal((await handleDispatch(post(), h.deps)).status, 500);
  assert.equal((await handleDispatch(new Request('https://x.test/', { method: 'GET' }), h.deps)).status, 405);
});

// --- TMDB proxy -------------------------------------------------------------

const TMDB_KEY = 'testonly0123456789abcdef'; // not a real key

function tmdbHarness(role: string | null, answer: (url: URL) => { status?: number; body: unknown }, apiKey: string | undefined = TMDB_KEY) {
  const urls: URL[] = [];
  const headers: Record<string, string>[] = [];
  const logged: string[] = [];
  const deps: TmdbDeps = {
    rpc: async () => ({ data: role ? { outcome: 'ok', role } : { outcome: 'no_member' }, error: null }),
    fetch: (async (input: any, init: any) => {
      const url = new URL(String(input));
      urls.push(url);
      headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
      const a = answer(url);
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
    }) as typeof fetch,
    apiKey,
    log: (event) => logged.push(event),
  };
  return { deps, urls, headers, logged };
}

const SEARCH_BODY = {
  results: [
    { id: 603, title: 'The Matrix', release_date: '1999-03-31', overview: 'A hacker.', poster_path: '/p.jpg', backdrop_path: '/b.jpg' },
    { id: 604, title: 'Bad Paths', release_date: 'soon', overview: '', poster_path: 'https://evil.test/x.jpg', backdrop_path: null },
    { id: 'nope', title: 'No id' },
  ],
};

test('tmdb: only the owner searches; members and strangers get 403 and TMDB is never called', async () => {
  for (const role of ['member', null]) {
    const h = tmdbHarness(role, () => ({ body: SEARCH_BODY }));
    const res = await handleTmdb(post({ action: 'search', query: 'matrix' }), h.deps);
    assert.equal(res.status, 403);
    assert.equal(h.urls.length, 0);
  }
});

test('tmdb: search maps results and never returns the key', async () => {
  const h = tmdbHarness('owner', () => ({ body: SEARCH_BODY }));
  const res = await handleTmdb(post({ action: 'search', query: '  matrix ' }), h.deps);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(TMDB_KEY));
  const body = JSON.parse(text);
  assert.deepEqual(body.results, [
    { tmdb_id: 603, title: 'The Matrix', release_date: '1999-03-31', overview: 'A hacker.', poster_path: '/p.jpg', backdrop_path: '/b.jpg' },
    { tmdb_id: 604, title: 'Bad Paths', release_date: null, overview: null, poster_path: null, backdrop_path: null },
  ]);
  assert.equal(h.urls[0].origin + h.urls[0].pathname, 'https://api.themoviedb.org/3/search/movie');
  assert.equal(h.urls[0].searchParams.get('query'), 'matrix');
  assert.equal(h.urls[0].searchParams.get('include_adult'), 'false');
  assert.equal(h.urls[0].searchParams.get('api_key'), TMDB_KEY);
});

test('tmdb: a v4 read token goes in the Authorization header, not the URL', async () => {
  const token = 'eyJ0ZXN0b25seSI6dHJ1ZX0.testonly.testonly';
  const h = tmdbHarness('owner', () => ({ body: { results: [] } }), token);
  await handleTmdb(post({ action: 'search', query: 'x' }), h.deps);
  assert.equal(h.headers[0].authorization, `Bearer ${token}`);
  assert.equal(h.urls[0].searchParams.get('api_key'), null);
});

test('tmdb: details returns the movie with poster and backdrop choices', async () => {
  const h = tmdbHarness('owner', () => ({
    body: {
      id: 603, title: 'The Matrix', release_date: '1999-03-31', overview: 'A hacker.', runtime: 136, tagline: 'Free your mind.',
      poster_path: '/p.jpg', backdrop_path: '/b.jpg', genres: [{ id: 1, name: 'Action' }, { id: 2 }], original_language: 'en',
      images: { posters: [{ file_path: '/p2.jpg' }, { file_path: '/p.jpg' }, { file_path: '../../etc/passwd' }], backdrops: [{ file_path: '/b2.jpg' }] },
      videos: {
        results: [
          { site: 'YouTube', type: 'Featurette', key: 'featurette1', official: true },
          { site: 'YouTube', type: 'Teaser', key: 'teaser12345', official: true },
          { site: 'Vimeo', type: 'Trailer', key: 'vimeo123456', official: true },
          { site: 'YouTube', type: 'Trailer', key: 'https://evil.example/x', official: true },
          { site: 'YouTube', type: 'Trailer', key: 'fanTrailer_1', official: false },
          { site: 'YouTube', type: 'Trailer', key: 'vKQi3bBA1y8', official: true },
        ],
      },
    },
  }));
  const res = await handleTmdb(post({ action: 'details', tmdb_id: 603 }), h.deps);
  const body = await res.json();
  assert.equal(body.movie.runtime_minutes, 136);
  // The official YouTube trailer wins; only its id is passed on.
  assert.deepEqual(body.movie.metadata, { tagline: 'Free your mind.', genres: ['Action'], original_language: 'en', trailer_key: 'vKQi3bBA1y8' });
  assert.equal(h.urls[0].searchParams.get('append_to_response'), 'images,videos');
  assert.deepEqual(body.posters, ['/p2.jpg', '/p.jpg']);
  assert.deepEqual(body.backdrops, ['/b.jpg', '/b2.jpg']);
  assert.equal(h.urls[0].pathname, '/3/movie/603');
});

test('tmdb: malformed requests, TMDB failures, and a missing key are handled safely', async () => {
  const ok = tmdbHarness('owner', () => ({ body: SEARCH_BODY }));
  for (const body of [{}, { action: 'search' }, { action: 'search', query: '' }, { action: 'search', query: 'x'.repeat(101) },
    { action: 'details', tmdb_id: '603' }, { action: 'details', tmdb_id: -1 }, { action: 'details', tmdb_id: 1.5 }, { action: 'proxy', url: 'https://evil.test' }, [], 'not json']) {
    assert.equal((await handleTmdb(post(body), ok.deps)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(ok.urls.length, 0);
  assert.equal((await handleTmdb(new Request('https://x.test/', { method: 'GET' }), ok.deps)).status, 405);

  const down = tmdbHarness('owner', () => ({ status: 401, body: { status_message: `Invalid API key: ${TMDB_KEY}` } }));
  const res = await handleTmdb(post({ action: 'search', query: 'matrix' }), down.deps);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { outcome: 'server_error' });
  assert.deepEqual(down.logged, ['tmdb_unauthorized']);
  assert.equal((await handleTmdb(post({ action: 'details', tmdb_id: 9 }), tmdbHarness('owner', () => ({ status: 404, body: {} })).deps)).status, 404);

  for (const key of [undefined, '', 'short']) {
    const h = tmdbHarness('owner', () => ({ body: SEARCH_BODY }));
    h.deps.apiKey = key;
    assert.equal((await handleTmdb(post({ action: 'search', query: 'matrix' }), h.deps)).status, 503);
    assert.equal(h.urls.length, 0);
  }
});
