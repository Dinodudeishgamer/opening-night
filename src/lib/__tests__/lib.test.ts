// Unit tests for the app's pure logic.
//
//   npm run test:lib
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayTime, firstEmoji, isInviteCodeComplete, memberName, money, parseMoney, parseScore, score, timeUntil, tmdbImage, formatLabel } from '../format.ts';
import { inboxShows } from '../inbox.ts';
import { ANDROID_INSTALL_LINK, appleCashLink, letterboxdLink, calendarEnd, calendarLocation, calendarNotes, INSTALL_LINK, inviteMessage, mapsLink, trailerLink, venmoLinks } from '../links.ts';
import { confirmationOpen, isPast, ownerNextStep, rsvpOpen, stageOf } from '../stage.ts';
import { eventStats, memberTotals, summarize, tiedNames, verdict } from '../stats.ts';

const NOW = new Date('2026-10-05T12:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

// --- format -----------------------------------------------------------------

test('names are first name and last initial', () => {
  assert.equal(memberName({ first_name: 'Alice', last_initial: 'A' }), 'Alice A.');
  assert.equal(memberName(null), 'Someone');
});

test('money formats and parses whole cents', () => {
  assert.equal(money(1667), '$16.67');
  assert.equal(money(5), '$0.05');
  assert.equal(money(0), '$0.00');
  assert.equal(money(120000), '$1200.00');
  assert.equal(parseMoney('16.67'), 1667);
  assert.equal(parseMoney('$16'), 1600);
  assert.equal(parseMoney('1,200.5'), 120050);
  assert.equal(parseMoney('0'), 0);
  for (const bad of ['', 'abc', '1.234', '-5', '1e3', '12.']) assert.equal(parseMoney(bad), null, bad);
});

test('scores: out of 5, two decimals, and 0.00 is a real score', () => {
  assert.equal(score(4), '4.00');
  assert.equal(score(4.88), '4.88');
  assert.equal(score(0), '0.00');
  assert.equal(parseScore('4'), 4);
  assert.equal(parseScore('4.5'), 4.5);
  assert.equal(parseScore('4.88'), 4.88);
  assert.equal(parseScore('0'), 0);
  assert.equal(parseScore('0.00'), 0);
  assert.equal(parseScore('5'), 5);
  assert.equal(parseScore(' 5.00 '), 5);
  for (const bad of ['4.885', '5.01', '5.1', '7', '10', '-1', '', 'abc', '4.', '.5', '04']) assert.equal(parseScore(bad), null, bad);
});

test('an avatar emoji is the first emoji typed, whole, and nothing else', () => {
  assert.equal(firstEmoji('🦄'), '🦄');
  assert.equal(firstEmoji(' 🍿🎬 '), '🍿', 'only the first one');
  assert.equal(firstEmoji('👍🏽 nice'), '👍🏽', 'keeps its skin tone');
  assert.equal(firstEmoji('❤️'), '❤️', 'keeps its variation selector');
  assert.equal(firstEmoji('👨‍👩‍👧‍👦!'), '👨‍👩‍👧‍👦', 'keeps a joined family together');
  assert.equal(firstEmoji('🇺🇸🇨🇦'), '🇺🇸', 'a flag is two indicators');
  assert.equal(firstEmoji('🏴󠁧󠁢󠁳󠁣󠁴󠁿'), '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'a subdivision flag keeps its tags');
  for (const bad of ['', '  ', 'a', 'hi 🦄', '7', '!', '🇺', 'Dino']) assert.equal(firstEmoji(bad), null, bad);
});

test('the inbox keeps only what is still about something', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const item = (kind: string, daysAgo = 1, event_id: string | null = 'e') => ({ kind, event_id, created_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString() });
  const upcoming = { endedAt: null, owes: false };
  const justEnded = { endedAt: '2026-10-20T04:00:00Z', owes: false };
  const longOver = { endedAt: '2026-10-10T04:00:00Z', owes: false };

  // A night still to come: everything from the last 30 days.
  for (const kind of ['event_created', 'rsvp_reminder', 'showtime_selected', 'payment_posted', 'announcement']) {
    assert.equal(inboxShows(item(kind), upcoming, now), true, kind);
  }
  assert.equal(inboxShows(item('event_created', 31), upcoming, now), false, 'older than 30 days');
  assert.equal(inboxShows(item('announcement', 31, null), undefined, now), false, 'even Dino\'s own');

  // The moment a night ends, the planning chatter goes.
  for (const kind of ['event_created', 'rsvp_reminder', 'vote_reminder', 'voting_complete', 'showtime_selected', 'event_rescheduled', 'confirm_reminder', 'event_reminder']) {
    assert.equal(inboxShows(item(kind), justEnded, now), false, kind);
  }
  // Rating notices last as long as rating does.
  assert.equal(inboxShows(item('rating_open'), justEnded, now), true);
  assert.equal(inboxShows(item('rating_reminder'), justEnded, now), true);
  assert.equal(inboxShows(item('rating_open', 9), longOver, now), false);
  // Payment notices last as long as the debt does, however long the night has been over.
  assert.equal(inboxShows(item('payment_reminder'), longOver, now), false);
  assert.equal(inboxShows(item('payment_reminder'), { ...longOver, owes: true }, now), true);
  assert.equal(inboxShows(item('payment_posted'), { ...justEnded, owes: true }, now), true);
  // Dino's own messages are never tidied by a night ending.
  assert.equal(inboxShows(item('announcement'), longOver, now), true);
  // Not about a night, or about one that no longer exists: shown.
  assert.equal(inboxShows(item('announcement', 2, null), undefined, now), true);
  assert.equal(inboxShows(item('event_created', 2, 'gone'), undefined, now), true);
});

test('invite codes know when they are complete, however they are typed', () => {
  assert.equal(isInviteCodeComplete('abcd-2345-efgh'), true);
  assert.equal(isInviteCodeComplete('ABCD 2345 EFGH JKLM'), true);
  assert.equal(isInviteCodeComplete('ABCD-2345'), false);
});

test('time and image helpers', () => {
  assert.equal(timeUntil(at(-1), NOW), 'passed');
  assert.equal(timeUntil(at(0.5), NOW), 'in 30 minutes');
  assert.equal(timeUntil(at(5), NOW), 'in 5 hours');
  assert.equal(timeUntil(at(72), NOW), 'in 3 days');
  assert.match(dayTime(at(0)), /·/);
  assert.equal(tmdbImage('/abc.jpg', 'w500'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.equal(tmdbImage('https://evil.test/x.jpg'), null);
  assert.equal(tmdbImage(null), null);
  assert.equal(formatLabel({ format: 'imax', format_other: null }), 'IMAX');
  assert.equal(formatLabel({ format: 'other', format_other: '70mm' }), '70mm');
});

// --- stage ------------------------------------------------------------------

const base = {
  rsvp_deadline: at(48),
  selected_showtime_id: null as string | null,
  tickets_purchased_at: null as string | null,
  ended_at: null as string | null,
  confirmation_deadline: null as string | null,
  voting_closed_at: null as string | null,
};

test('an event moves through its stages from its milestones alone', () => {
  assert.equal(stageOf(base, NOW), 'rsvp');
  assert.equal(rsvpOpen(base, NOW), true);
  assert.equal(stageOf({ ...base, rsvp_deadline: at(-1) }, NOW), 'voting');
  const selected = { ...base, rsvp_deadline: at(-1), selected_showtime_id: 's1', confirmation_deadline: at(24) };
  assert.equal(stageOf(selected, NOW), 'confirming');
  assert.equal(rsvpOpen(selected, NOW), false);
  assert.equal(confirmationOpen(selected, NOW), true);
  assert.equal(confirmationOpen({ ...selected, confirmation_deadline: at(-1) }, NOW), false);
  const ticketed = { ...selected, tickets_purchased_at: at(-2) };
  assert.equal(stageOf(ticketed, NOW), 'ticketed');
  assert.equal(confirmationOpen(ticketed, NOW), false);
  assert.equal(stageOf({ ...ticketed, ended_at: at(-47) }, NOW), 'rating');
  assert.equal(stageOf({ ...ticketed, ended_at: at(-48) }, NOW), 'past');
  assert.equal(isPast({ ended_at: at(-49) }, NOW), true);
  assert.equal(isPast({ ended_at: null }, NOW), false);
});

test('Dino is told the next step', () => {
  const facts = { activeShowtimes: 0, eligible: 0, voted: 0, pendingConfirmations: 0, unpaid: 0 };
  assert.match(ownerNextStep(base, facts, NOW)!, /Add showtimes/);
  assert.equal(ownerNextStep(base, { ...facts, activeShowtimes: 2, eligible: 3, voted: 1 }, NOW), null);
  assert.match(ownerNextStep(base, { ...facts, activeShowtimes: 2, eligible: 3, voted: 3 }, NOW)!, /Select the showtime/);
  assert.match(ownerNextStep({ ...base, voting_closed_at: at(-1) }, { ...facts, activeShowtimes: 2 }, NOW)!, /Select the showtime/);
  const selected = { ...base, selected_showtime_id: 's1', confirmation_deadline: at(24) };
  assert.equal(ownerNextStep(selected, { ...facts, pendingConfirmations: 2 }, NOW), null);
  assert.match(ownerNextStep(selected, facts, NOW)!, /Buy the tickets/);
  assert.match(ownerNextStep({ ...selected, tickets_purchased_at: at(-1) }, { ...facts, unpaid: 2 }, NOW)!, /2 unpaid/);
  assert.equal(ownerNextStep({ ...selected, tickets_purchased_at: at(-1), ended_at: at(-100) }, facts, NOW), null);
});

// --- stats ------------------------------------------------------------------

test('summarize: average, min, max, spread, population standard deviation', () => {
  assert.equal(summarize([]), null);
  assert.deepEqual(summarize([7]), { count: 1, average: 7, min: 7, max: 7, spread: 0, stdDev: 0 });
  assert.deepEqual(summarize([2, 4, 4, 4, 5, 5, 7, 9]), { count: 8, average: 5, min: 2, max: 9, spread: 7, stdDev: 2 });
  assert.deepEqual(summarize([0, 10]), { count: 2, average: 5, min: 0, max: 10, spread: 10, stdDev: 5 });
});

test('event stats: prediction against final, biggest changes, accuracy; 0.0 counts', () => {
  const attendees = [
    { participantId: 'a', name: 'Alice A.', isGuest: false },
    { participantId: 'b', name: 'Bob B.', isGuest: false },
    { participantId: 'c', name: 'Carol C.', isGuest: false },
    { participantId: 'g', name: 'Gina', isGuest: true },
  ];
  const stats = eventStats(
    attendees,
    [{ participant_id: 'a', score: 4 }, { participant_id: 'b', score: 2.5 }, { participant_id: 'c', score: 0 }, { participant_id: 'g', score: 3 },
     { participant_id: 'ghost', score: 5 }], // not an attendee: ignored
    [{ participant_id: 'a', score: 3.25 }, { participant_id: 'b', score: 4.5 }, { participant_id: 'c', score: 0 }],
  );
  assert.equal(stats.predictions!.count, 4);
  assert.equal(stats.predictions!.average, 2.38);
  assert.equal(stats.predictions!.min, 0);
  assert.equal(stats.ratings!.average, 2.58);
  assert.equal(stats.ratings!.min, 0);
  // To the hundredth: a 4.88 against a 4.5 is +0.38, not +0.4.
  assert.deepEqual(stats.people.map((p) => p.change), [-0.75, 2, 0, null]);
  assert.equal(eventStats(attendees.slice(0, 1), [{ participant_id: 'a', score: 4.5 }], [{ participant_id: 'a', score: 4.88 }]).people[0].change, 0.38);
  const who = (list: { name: string }[]) => list.map((person) => person.name);
  assert.deepEqual(who(stats.biggestRise), ['Bob B.']);
  assert.deepEqual(who(stats.biggestDrop), ['Alice A.']);
  assert.deepEqual(who(stats.closest), ['Carol C.']);
  assert.deepEqual(who(stats.fan), ['Bob B.']);
  assert.deepEqual(who(stats.critic), ['Carol C.']);
  assert.equal(stats.predictionVsFinal, 0.42);
  // Mean miss (0.75 + 2 + 0) / 3 = 0.92 on a 5-point scale.
  assert.equal(stats.accuracy, 82);

  const empty = eventStats(attendees, [], []);
  assert.equal(empty.predictions, null);
  assert.equal(empty.accuracy, null);
  assert.deepEqual(empty.biggestRise, []);
  const perfect = eventStats(attendees.slice(0, 1), [{ participant_id: 'a', score: 3.5 }], [{ participant_id: 'a', score: 3.5 }]);
  assert.equal(perfect.accuracy, 100);
  // One rating, or everyone agreeing, has no fan and no critic.
  assert.deepEqual(perfect.fan, []);
  assert.deepEqual(perfect.critic, []);

  // A tie is shared by everyone level on the number.
  const tied = eventStats(
    attendees,
    [{ participant_id: 'a', score: 4 }, { participant_id: 'b', score: 4 }, { participant_id: 'c', score: 3 }, { participant_id: 'g', score: 5 }],
    [{ participant_id: 'a', score: 5 }, { participant_id: 'b', score: 5 }, { participant_id: 'c', score: 3 }, { participant_id: 'g', score: 3 }],
  );
  assert.deepEqual(who(tied.fan), ['Alice A.', 'Bob B.']);
  assert.deepEqual(who(tied.critic).sort(), ['Carol C.', 'Gina']);
  assert.deepEqual(who(tied.biggestRise), ['Alice A.', 'Bob B.']);
  assert.deepEqual(who(tied.biggestDrop), ['Gina']);
  assert.deepEqual(who(tied.closest), ['Carol C.']);
  assert.equal(tiedNames(tied.fan), 'Alice A. & Bob B.');
  assert.equal(tiedNames(tied.fan, true), 'Alice & Bob');
  assert.equal(tiedNames([{ name: 'A A.' }, { name: 'B B.' }, { name: 'C C.' }]), 'A A., B B. & C C.');
  assert.equal(tiedNames([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]), '4 people tied');
  assert.equal(tiedNames([]), '');
  assert.deepEqual(perfect.biggestRise, []);
  assert.deepEqual(perfect.biggestDrop, []);
});

// --- links ------------------------------------------------------------------

test('payment links carry the amount and note and nothing else', () => {
  const [app, web] = venmoLinks('@dino-w', { amountCents: 1667, note: 'Opening Night: The Matrix' });
  assert.equal(app, 'venmo://paycharge?txn=pay&recipients=dino-w&amount=16.67&note=Opening%20Night%3A%20The%20Matrix');
  assert.ok(web.startsWith('https://venmo.com/dino-w?'));
  assert.equal(appleCashLink('(415) 555-0100', { amountCents: 500, note: 'Movie' }), 'sms:4155550100&body=Movie%3A%20%245.00%20via%20Apple%20Cash');
});

test('the invite message walks someone from no app to signed in', () => {
  const text = inviteMessage('Gavin G.', 'kirbyisthebest', true);
  assert.ok(text.startsWith('Hey Gavin!'));
  // TestFlight first, then the link, then the code on a line of its own, in that order.
  const at = (piece: string) => text.indexOf(piece);
  assert.ok(at('TestFlight') > 0 && at('TestFlight') < at(INSTALL_LINK) && at(INSTALL_LINK) < at('\nkirbyisthebest\n'));
  assert.match(text, /expires in 48 hours/);
  assert.match(inviteMessage('Tad W.', 'ABCD-EFGH-JKLM-NPQR', false), /expires in 14 days/);
  assert.ok(inviteMessage('', 'x', false).startsWith('Hey there!'));
  // Android: the download link instead of TestFlight, then the same code.
  const android = inviteMessage('Tad W.', 'KMTAHCWBPRDGFNEJ', false, 'android');
  assert.ok(android.includes(ANDROID_INSTALL_LINK) && !android.includes('TestFlight'));
  assert.ok(android.indexOf(ANDROID_INSTALL_LINK) < android.indexOf('\nKMTAHCWBPRDGFNEJ\n'));
});

test('calendar entry: runs past the credits, and says where and what', () => {
  const entry = {
    eventId: 'e1', revision: 2, title: 'Opening Night: The Matrix', startsAt: '2026-10-09T00:30:00Z',
    runtimeMinutes: 136, theater: 'Cinemark', address: '1 Main St, Austin', format: 'IMAX',
  };
  // 136 minutes plus 25 of trailers and shuffling out.
  assert.equal(calendarEnd(entry).toISOString(), '2026-10-09T03:11:00.000Z');
  assert.equal(calendarEnd({ startsAt: entry.startsAt, runtimeMinutes: null }).toISOString(), '2026-10-09T03:00:00.000Z');
  assert.equal(calendarLocation(entry), 'Cinemark, 1 Main St, Austin');
  assert.equal(calendarLocation({ theater: 'Cinemark', address: null }), 'Cinemark');
  assert.equal(calendarNotes(entry), 'Format: IMAX\nOpening Night: openingnight://event/e1');
});

test('directions open the phone\'s own maps app; trailers open YouTube', () => {
  assert.equal(mapsLink('Cinemark, 1 Main St & 2nd', 'ios'), 'https://maps.apple.com/?q=Cinemark%2C%201%20Main%20St%20%26%202nd');
  assert.equal(mapsLink(' Cinemark ', 'android'), 'https://www.google.com/maps/search/?api=1&query=Cinemark');
  assert.equal(trailerLink('vKQi3bBA1y8', 'The Matrix', '1999'), 'https://www.youtube.com/watch?v=vKQi3bBA1y8');
  // No id on file (or something that is not one): search for it instead.
  assert.equal(trailerLink(null, 'The Matrix', '1999'), 'https://www.youtube.com/results?search_query=The%20Matrix%201999%20official%20trailer');
  assert.equal(trailerLink('x&list=evil', 'Up'), 'https://www.youtube.com/results?search_query=Up%20official%20trailer');
});

test('member totals: nights, average rating, accuracy, from the nights they were at', () => {
  const places = [
    { id: 'p1', event_id: 'e1', member_id: 'a', checked_in_at: 'x' },
    { id: 'p2', event_id: 'e2', member_id: 'a', checked_in_at: 'x' },
    { id: 'p3', event_id: 'e3', member_id: 'a', checked_in_at: null }, // said yes, did not come
    { id: 'p4', event_id: 'e1', member_id: null, checked_in_at: 'x' }, // a guest
    { id: 'p5', event_id: 'e1', member_id: 'b', checked_in_at: 'x' },
  ];
  const totals = memberTotals(places, [{ participant_id: 'p1', score: 4 }, { participant_id: 'p2', score: 3 }], [{ participant_id: 'p1', score: 5 }, { participant_id: 'p2', score: 3 }]);
  assert.deepEqual(totals.a, { nights: 2, averageRating: 4, accuracy: 90, rated: [{ eventId: 'e1', rating: 5 }, { eventId: 'e2', rating: 3 }] });
  // Came, but no rating visible yet.
  assert.deepEqual(totals.b, { nights: 1, averageRating: null, accuracy: null, rated: [] });
  assert.equal(Object.keys(totals).length, 2);
  assert.equal(letterboxdLink('alice_w'), 'https://letterboxd.com/alice_w/');
});

test('verdict: what a member is told about their own guess', () => {
  assert.equal(verdict(0), 'You called it.');
  assert.equal(verdict(-0.1), 'You called it.');
  assert.equal(verdict(0.3), 'Better than you expected.');
  assert.equal(verdict(1.2), 'Way better than you expected.');
  assert.equal(verdict(-0.45), 'Not quite what you hoped.');
  assert.equal(verdict(-1.5), 'Nowhere near what you hoped.');
});
