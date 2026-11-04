// A pretend backend for looking at every screen in a web browser without
// signing in. It is NOT part of the app: nothing imports it, and it must not
// be committed wired in.
//
// To use it for a visual check:
//   1. Copy this file to src/lib/dev-mock.ts and add, as the very first line
//      of src/app/_layout.tsx:   import '@/lib/dev-mock';
//   2. Run the web app and open any page with ?mock=owner or ?mock=member
//      (add &theme=dark or &theme=light). Every request to Supabase is
//      answered from the made-up data below; nothing reaches the real server.
//   3. Remove the import and the copy again before committing.
//
// It fakes a signed-in session in the browser's storage, so use a throwaway
// browser profile (headless Edge with its own --user-data-dir works well for
// screenshots), not the browser a real member is signed in with.
const BASE = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const ART = { poster: '/9RmZu33qHdyZFGLfhEOmkTjdNEu.jpg', backdrop: '/vxhnRV7jGncAZmf0FFHMs6rFHWn.jpg' };

function install(role: string) {
  const meId = role === 'owner' ? 'm1' : 'm2';
  const members = [
    ['m1', 'Dino', 'W', 'owner', 'active', 'emoji', '🦖'],
    ['m2', 'Gavin', 'G', 'member', 'active', 'emoji', '🍿'],
    ['m3', 'Alice', 'A', 'member', 'active', 'initials', null],
    ['m4', 'Bob', 'B', 'member', 'active', 'emoji', '👻'],
    ['m5', 'Carol', 'C', 'member', 'active', 'initials', null],
    ['m6', 'Eve', 'E', 'member', 'deactivated', 'initials', null],
  ].map(([id, first_name, last_initial, r, status, avatar_kind, avatar_emoji]) => ({ id, first_name, last_initial, role: r, status, avatar_kind, avatar_emoji, avatar_path: null }));

  const movie = (id: string, title: string, year: string, runtime: number, art = false, tagline: string | null = null) => ({
    id, tmdb_id: 1, title, release_date: `${year}-06-01`, runtime_minutes: runtime,
    overview: `${title} is the one everybody has been saying we should finally see on a big screen, with the lights down and the sound up, the way it was meant to be seen.`,
    poster_path: art ? ART.poster : null, backdrop_path: art ? ART.backdrop : null, metadata: { tagline, genres: ['Comedy', 'Drama'], trailer_key: null },
  });
  const event = (id: string, mv: any, over: any) => ({
    id, movie_id: mv.id, rsvp_deadline: days(3), voting_revision: 1, selected_showtime_id: null, showtime_selected_at: null, confirmation_deadline: null,
    tickets_purchased_at: null, ended_at: null, created_at: days(-2), poster_path: null, backdrop_path: null, title_override: null, description_override: null,
    owner_note: null, voting_closed_at: null, schedule_revision: 1, total_cost_cents: null, movie: mv, ...over,
  });
  const events = [
    event('e1', movie('v1', 'That Thing You Do!', '1996', 108, true, 'In every life there comes a time when that dream you dream becomes that thing you do.'), { selected_showtime_id: 's1', tickets_purchased_at: days(-1), confirmation_deadline: days(-1), total_cost_cents: 9300, owner_note: 'Meet in the lobby at 7. Popcorn is on me if we fill the row.', created_at: days(-9) }),
    event('e2', movie('v2', 'The Grand Budapest Hotel', '2014', 100), { selected_showtime_id: 's2', confirmation_deadline: days(9), rsvp_deadline: days(-2), created_at: days(-6) }),
    event('e3', movie('v3', 'Over the Garden Wall', '2014', 110, true), { created_at: days(-1) }),
    event('e7', movie('v7', 'A Very Long Movie Title That Goes On And On', '2001', 131), { rsvp_deadline: days(-1), created_at: days(-3) }),
    event('e4', movie('v4', 'Paddington 2', '2017', 103, true), { selected_showtime_id: 's4', tickets_purchased_at: days(-3), ended_at: days(-0.5), total_cost_cents: 6000, rsvp_deadline: days(-9), created_at: days(-14) }),
    event('e5', movie('v5', 'Mad Max: Fury Road', '2015', 120), { selected_showtime_id: 's5', tickets_purchased_at: days(-14), ended_at: days(-12), total_cost_cents: 6000, rsvp_deadline: days(-20), created_at: days(-25) }),
    event('e6', movie('v6', 'Arrival', '2016', 116, true), { selected_showtime_id: 's6', tickets_purchased_at: days(-42), ended_at: days(-40), total_cost_cents: 6000, rsvp_deadline: days(-50), created_at: days(-55) }),
  ];
  const theaters = [
    { id: 't1', name: 'Cinemark Tinseltown', address: '11841 Eubank Blvd', time_zone: 'America/Chicago' },
    { id: 't2', name: 'Alamo Drafthouse', address: '320 E 6th St', time_zone: 'America/Chicago' },
  ];
  const st = (id: string, event_id: string, inDays: number, t = 0, format = 'imax') => ({ id, event_id, theater_id: theaters[t].id, starts_at: days(inDays), format, format_other: null, removed_at: null, theater: theaters[t] });
  const showtimes = [st('s1', 'e1', 6), st('s2', 'e2', 20, 1, 'standard'), st('s3a', 'e3', 10), st('s3b', 'e3', 12, 1, 'dolby'), st('s4', 'e4', -0.6), st('s5', 'e5', -12, 1, 'standard'), st('s6', 'e6', -40)];
  const guests = [{ id: 'g1', display_name: 'Sam', host_member_id: 'm2' }];

  const participants: any[] = [];
  const charges: any[] = [];
  const predictions: any[] = [];
  const ratings: any[] = [];
  const add = (e: string, m: string | null, over: any = {}) => {
    const row = { id: `p-${e}-${m ?? over.guest_id}`, event_id: e, member_id: m, guest_id: null, rsvp_status: 'going', confirmation_status: null, checked_in_at: null, ...over };
    participants.push(row);
    return row.id;
  };
  ['m1', 'm2', 'm3', 'm4', 'm5'].forEach((m, i) => {
    const p = add('e1', m, { confirmation_status: 'attending' });
    charges.push({ id: `c-${p}`, event_id: 'e1', participant_id: p, amount_cents: 1550, status: m === 'm1' || m === 'm3' ? 'paid' : 'unpaid', paid_at: null });
    if (m !== 'm2') predictions.push({ participant_id: p, event_id: 'e1', score: [4.75, 0, 3.6, 4, 3.25][i], is_active: true });
  });
  const sam = add('e1', null, { guest_id: 'g1', confirmation_status: 'attending' });
  charges.push({ id: 'c-sam', event_id: 'e1', participant_id: sam, amount_cents: 1550, status: 'unpaid', paid_at: null });
  add('e2', 'm1', { confirmation_status: 'attending' }); add('e2', 'm2'); add('e2', 'm3', { confirmation_status: 'not_attending' }); add('e2', 'm4', { rsvp_status: 'maybe' }); add('e2', 'm5', { rsvp_status: 'cant_go' });
  add('e3', 'm1'); add('e3', 'm2'); add('e3', 'm3', { rsvp_status: 'maybe' }); add('e3', 'm4', { rsvp_status: null });
  add('e7', 'm1'); add('e7', 'm2', { rsvp_status: 'maybe' });
  const past = (e: string, guesses: number[], scores: (number | null)[]) =>
    ['m1', 'm2', 'm3', 'm4', 'm5'].forEach((m, i) => {
      const p = add(e, m, { confirmation_status: 'attending', checked_in_at: days(-1) });
      charges.push({ id: `c-${p}`, event_id: e, participant_id: p, amount_cents: 1200, status: 'paid', paid_at: days(-1) });
      predictions.push({ participant_id: p, event_id: e, score: guesses[i], is_active: true });
      if (scores[i] !== null) ratings.push({ participant_id: p, event_id: e, score: scores[i] });
    });
  past('e4', [4, 3.75, 4.5, 3, 3.5], [4.6, role === 'owner' ? 4.4 : null, 4.75, 3.55, role === 'owner' ? null : 4.2]);
  past('e5', [4.5, 4.1, 3.5, 4.75, 3], [4.8, 4.55, 4.15, 4.4, 3.95]);
  past('e6', [3.5, 4.4, 4, 3.75, 4.5], [4.2, 4.5, 3.05, 3.85, 4.65]);

  const mine = (e: string) => participants.filter((p) => p.event_id === e && (p.member_id === meId || guests.some((g) => g.id === p.guest_id && g.host_member_id === meId)));
  const voting = (e: string) => {
    const open = e === 'e3';
    const here = participants.filter((p) => p.event_id === e && (p.rsvp_status === 'going' || p.rsvp_status === 'maybe'));
    const rows = here.map((p, i) => ({ participant_id: p.id, member_id: p.member_id, guest_id: p.guest_id, current: open ? i % 2 === 1 : true, showtime_ids: open && i % 2 === 1 ? ['s3a'] : [] }));
    return {
      voting_revision: 1, open, closed_at: open ? null : days(-1), eligible: here.length, voted: rows.filter((r) => r.current && open).length,
      counts: open ? [{ showtime_id: 's3a', available: 1 }, { showtime_id: 's3b', available: 0 }] : [],
      mine: rows.filter((r) => mine(e).some((p) => p.id === r.participant_id)), matrix: role === 'owner' ? rows : null,
    };
  };
  const note = (id: string, kind: string, title: string, body: string | null, ago: number, read: boolean, event_id: string | null = null) => ({ id, event_id, kind, title, body, created_at: days(-ago), read_at: read ? days(-ago / 2) : null });
  const tables: Record<string, any[]> = {
    members, events, showtimes, theaters, guests, event_participants: participants, charges, predictions, ratings, event_media: [],
    app_settings: [{ venmo_username: 'dino-w', apple_cash_recipient: '+15055550123', payment_note: 'Cash at the theater is fine too.' }],
    notifications: [
      note('n1', 'announcement', 'Doors at 7', 'Meet in the lobby. I have the tickets.', 0.1, false),
      note('n2', 'payment_posted', 'Tickets are bought', 'Your share is ready. Open the app to pay Dino.', 0.9, false, 'e1'),
      note('n3', 'rating_open', 'Rate Paddington 2', 'Ratings lock 48 hours after the movie.', 0.5, false, 'e4'),
      note('n4', 'showtime_selected', 'Showtime picked', 'Confirm whether you can make it.', 3, true, 'e2'),
      note('n5', 'event_created', 'New movie night: Over the Garden Wall', 'Are you in? RSVP in the app.', 1, true, 'e3'),
      note('n6', 'event_created', 'New movie night: Mad Max: Fury Road', 'Are you in?', 25, true, 'e5'),
    ],
  };
  const pending = role === 'owner'
    ? [{ event_id: 'e3', participant_id: 'p-e3-m1', kind: 'vote', due_at: null }, { event_id: 'e4', participant_id: 'p-e4-m1', kind: 'rate', due_at: null }]
    : [
        { event_id: 'e1', participant_id: 'p-e1-m2', kind: 'pay', due_at: null }, { event_id: 'e1', participant_id: sam, kind: 'pay', due_at: null },
        { event_id: 'e1', participant_id: 'p-e1-m2', kind: 'predict', due_at: null }, { event_id: 'e2', participant_id: 'p-e2-m2', kind: 'confirm', due_at: days(9) },
        { event_id: 'e3', participant_id: 'p-e3-m2', kind: 'vote', due_at: null }, { event_id: 'e4', participant_id: 'p-e4-m2', kind: 'rate', due_at: days(1.5) },
      ];
  const me = members.find((m) => m.id === meId)!;
  const rpcs: Record<string, (args: any) => unknown> = {
    whoami: () => ({ outcome: 'ok', member_id: me.id, first_name: me.first_name, last_initial: me.last_initial, role: me.role }),
    get_pending_actions: () => pending,
    get_voting: (a) => voting(a.p_event_id),
    owner_member_access: () => members.map((m, i) => ({ member_id: m.id, has_login: i < 3, invite_open: i === 3, invite_expires_at: i === 3 ? days(1.5) : null, invite_started: false })),
    list_announcements: () => [
      { batch: 'b1', title: 'Doors at 7', body: 'Meet in the lobby.', sent_at: days(-0.1), expires_at: days(0.9), recipients: 5, seen: 2 },
      { batch: 'b2', title: 'Parking is free after 6', body: null, sent_at: days(-4), expires_at: null, recipients: 5, seen: 5 },
    ],
    owner_roster: (a) => participants.filter((p) => p.event_id === a.p_event_id).map((p) => ({ participant_id: p.id, prior_confirmation_status: null, has_prediction: predictions.some((x) => x.participant_id === p.id) })),
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const real = window.fetch.bind(window);
  window.fetch = async (input: any, init?: any) => {
    const href = typeof input === 'string' ? input : (input.href ?? input.url);
    if (!href.startsWith(BASE)) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? input.method ?? 'GET').toUpperCase();
    const accept = new Headers(init?.headers ?? input.headers).get('accept') ?? '';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body || '{}') : {};
    const path = url.pathname;
    if (path.startsWith('/rest/v1/rpc/')) return json(rpcs[path.split('/').pop()!]?.(body) ?? null);
    if (path.startsWith('/rest/v1/')) {
      let list = [...(tables[path.split('/').pop()!] ?? [])];
      for (const [key, raw] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        if (raw.startsWith('eq.')) list = list.filter((row) => String(row[key]) === raw.slice(3));
        else if (raw.startsWith('in.(')) list = list.filter((row) => raw.slice(4, -1).split(',').map((v) => v.replace(/"/g, '')).includes(String(row[key])));
        else if (raw === 'is.null') list = list.filter((row) => row[key] === null);
        else if (raw.startsWith('gte.')) list = list.filter((row) => String(row[key]) >= raw.slice(4));
      }
      const order = url.searchParams.get('order');
      if (order) {
        const [field, direction] = order.split('.');
        list.sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (direction === 'desc' ? -1 : 1));
      }
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `0-0/${list.length}` } });
      if (method !== 'GET') return new Response(null, { status: 204 });
      return accept.includes('vnd.pgrst.object') ? json(list[0] ?? null) : json(list, 200, { 'content-range': `0-${list.length}/${list.length}` });
    }
    if (path === '/functions/v1/tmdb') {
      const hit = { tmdb_id: 9, title: 'The Princess Bride', release_date: '1987-09-25', overview: 'A fairy tale adventure about a beautiful young woman and her one true love.', poster_path: ART.poster, backdrop_path: ART.backdrop };
      return body.action === 'details'
        ? json({ outcome: 'ok', movie: { ...hit, runtime_minutes: 98, metadata: { tagline: 'Scaling the Cliffs of Insanity.', genres: ['Adventure', 'Family'] } }, posters: [ART.poster, ART.poster, ART.poster], backdrops: [ART.backdrop, ART.backdrop] })
        : json({ outcome: 'ok', results: [hit, { ...hit, tmdb_id: 10, title: 'The Princess and the Frog', release_date: '2009-12-08', poster_path: null }] });
    }
    if (path === '/functions/v1/owner-members') return json({ outcome: 'ok', member_id: 'm9', invite_code: 'ABCD-EFGH-JKLM-NPQR' });
    if (path.startsWith('/storage/')) return json({ error: 'mock' }, 400);
    return json({});
  };

  // A session for the app to find, so it believes someone is signed in.
  const ref = new URL(BASE).hostname.split('.')[0];
  window.localStorage.setItem(
    `sb-${ref}-auth-token`,
    JSON.stringify({ access_token: 'mock.mock.mock', refresh_token: 'mock', token_type: 'bearer', expires_in: 9e8, expires_at: Math.floor(Date.now() / 1000) + 9e8, user: { id: 'mock-user', aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: days(-1) } }),
  );
}

if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined' && BASE) {
  const theme = new URLSearchParams(window.location.search).get('theme');
  if (theme) window.localStorage.setItem('opening-night:appearance', theme);
  const asked = new URLSearchParams(window.location.search).get('mock');
  if (asked) window.sessionStorage.setItem('on-mock', asked);
  const role = window.sessionStorage.getItem('on-mock');
  if (role) {
    install(role);
    // The welcome tour shows once per member per browser. Add &tour=1 to see it; otherwise it counts as seen.
    const tour = new URLSearchParams(window.location.search).get('tour');
    for (const id of ['m1', 'm2']) {
      if (tour) window.localStorage.removeItem(`opening-night.intro-seen.${id}`);
      else window.localStorage.setItem(`opening-night.intro-seen.${id}`, '1');
    }
  }
}

export {};
