// Builders for the links the app hands to other apps: paying Dino, the
// calendar entry's text, directions to the theater, the film's trailer. Pure
// string work, no React Native, so it is unit-tested directly.

const APP_SCHEME = 'openingnight';

/** The app's own link to an event, written into the calendar entry so a tap there opens the night. */
function eventLink(eventId: string): string {
  return `${APP_SCHEME}://event/${eventId}`;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** Where a new member installs the app. TestFlight for now; the App Store address goes here when there is one. */
export const INSTALL_LINK = 'https://testflight.apple.com/join/VrWFmrGv';

/**
 * The message Dino sends with an invite code: the four steps from "you do
 * not have the app" to "you are in", in order, and short enough to be read.
 * `name` is "Gavin G."; only the first name is used.
 */
export function inviteMessage(name: string, code: string, custom: boolean): string {
  const first = name.trim().split(/\s+/)[0] || 'there';
  return [
    `Hey ${first}! You're invited to Opening Night, our movie club app. It takes 2 minutes. In order:`,
    '',
    '1. Install the free TestFlight app from the App Store (it is by Apple).',
    `2. Tap this link, then Accept and Install: ${INSTALL_LINK}`,
    '3. Open Opening Night and enter your invite code:',
    '',
    code,
    '',
    '4. Say yes to notifications so you hear about movie nights.',
    '',
    `The code works once and expires in ${custom ? '48 hours' : '14 days'}. iPhone only for now. Stuck? Text me.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

interface PayRequest {
  amountCents: number;
  note: string;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * Venmo, with recipient, amount and note prefilled. The first URL opens the
 * app; the second is the web fallback for a phone without it.
 */
export function venmoLinks(username: string, request: PayRequest): string[] {
  const recipient = encodeURIComponent(username.replace(/^@/, ''));
  const query = `txn=pay&recipients=${recipient}&amount=${dollars(request.amountCents)}&note=${encodeURIComponent(request.note)}`;
  return [`venmo://paycharge?${query}`, `https://venmo.com/${recipient}?${query}`];
}

/**
 * Apple Cash has no link of its own: a payment starts in Messages. This
 * opens a message to Dino's number with the amount in the draft; the member
 * taps Apple Cash above the keyboard. iOS only.
 */
export function appleCashLink(recipient: string, request: PayRequest): string {
  const number = recipient.replace(/[^\d+]/g, '');
  const body = `${request.note}: $${dollars(request.amountCents)} via Apple Cash`;
  return `sms:${number}&body=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEntry {
  eventId: string;
  /** Bumped on every schedule change. */
  revision: number;
  title: string;
  startsAt: string;
  runtimeMinutes: number | null;
  theater: string | null;
  address: string | null;
  format: string | null;
}

/** Trailers included, when TMDB has no runtime. */
const FALLBACK_RUNTIME_MINUTES = 150;
/** Trailers and getting out of the building. */
const PADDING_MINUTES = 25;

export function calendarEnd(entry: Pick<CalendarEntry, 'startsAt' | 'runtimeMinutes'>): Date {
  const minutes = (entry.runtimeMinutes ?? FALLBACK_RUNTIME_MINUTES - PADDING_MINUTES) + PADDING_MINUTES;
  return new Date(new Date(entry.startsAt).getTime() + minutes * 60_000);
}

export function calendarNotes(entry: CalendarEntry): string {
  return [entry.format ? `Format: ${entry.format}` : null, `Opening Night: ${eventLink(entry.eventId)}`]
    .filter(Boolean)
    .join('\n');
}

export function calendarLocation(entry: Pick<CalendarEntry, 'theater' | 'address'>): string {
  return [entry.theater, entry.address].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Directions and trailers
// ---------------------------------------------------------------------------

/**
 * The theater in the phone's maps app, ready for directions. Apple Maps on
 * an iPhone; Google Maps everywhere else.
 */
export function mapsLink(place: string, platform: string): string {
  const query = encodeURIComponent(place.trim());
  return platform === 'ios' ? `https://maps.apple.com/?q=${query}` : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/**
 * The film's trailer on YouTube. `key` is the video id TMDB gave when the
 * night was made; for a night made before the app kept one, a search for
 * the trailer is the next best thing.
 */
export function trailerLink(key: string | null | undefined, title: string, year?: string | null): string {
  if (key && /^[A-Za-z0-9_-]{6,20}$/.test(key)) return `https://www.youtube.com/watch?v=${key}`;
  const search = [title.trim(), year, 'official trailer'].filter(Boolean).join(' ');
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(search)}`;
}
