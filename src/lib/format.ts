// Small pure helpers for turning data into what people read and type. No
// React Native imports, so these run under the Node test runner.
import type { RsvpStatus, ShowtimeFormat } from './types.ts';

/** "Alice A." */
export function memberName(member: { first_name: string; last_initial: string } | null | undefined): string {
  return member ? `${member.first_name} ${member.last_initial}.` : 'Someone';
}

export const RSVP_LABEL: Record<RsvpStatus, string> = {
  going: 'Going',
  maybe: 'Maybe',
  cant_go: "Can't Go",
};

export const CONFIRMATION_LABEL = {
  attending: 'Confirmed',
  not_attending: "Can't Make It",
} as const;

export const FORMAT_LABEL: Record<ShowtimeFormat, string> = {
  standard: 'Standard',
  imax: 'IMAX',
  xd: 'XD',
  dolby: 'Dolby',
  '3d': '3D',
  other: 'Other',
};

export function formatLabel(showtime: { format: ShowtimeFormat; format_other: string | null }): string {
  return showtime.format === 'other' ? (showtime.format_other ?? 'Other') : FORMAT_LABEL[showtime.format];
}

/** 1667 -> "$16.67" */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "16.67", "16", "$1,200.5" -> cents, or null when it is not an amount. */
export function parseMoney(raw: string): number | null {
  const clean = raw.replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** The top of the scale. The club scores out of 5. */
export const MAX_SCORE = 5;

/** Scores always show two decimals: 4 -> "4.00", 4.88 -> "4.88", 0 -> "0.00". */
export function score(value: number): string {
  return value.toFixed(2);
}

/**
 * What someone typed as a score -> a number in [0, 5] with at most two
 * decimals, or null. "4", "4.5", "4.88", "5", "0" pass; "4.885", "5.01",
 * "7", "" do not. The database checks the same rule; this is so the app can
 * say so first.
 */
export function parseScore(raw: string): number | null {
  const clean = raw.trim();
  if (!/^(5(\.0{1,2})?|[0-4](\.\d{1,2})?)$/.test(clean)) return null;
  return Number(clean);
}

const isRegionalIndicator = (code: number) => code >= 0x1f1e6 && code <= 0x1f1ff;
// The blocks emoji live in. Letters, digits and punctuation are not in any of them.
const isPictograph = (code: number) =>
  (code >= 0x1f000 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf) || (code >= 0x2300 && code <= 0x23ff) || (code >= 0x2b00 && code <= 0x2bff) || (code >= 0x2190 && code <= 0x21ff);

/**
 * The first emoji in what was typed, whole: with its skin tone, and with
 * anything joined to it (a family, a flag). Null when the text does not start
 * with one. Used for choosing an avatar, where exactly one emoji is wanted.
 */
export function firstEmoji(raw: string): string | null {
  const points = Array.from(raw.trim());
  if (points.length === 0) return null;
  const code = (index: number) => points[index].codePointAt(0)!;
  if (!isPictograph(code(0))) return null;

  // A flag is exactly two regional indicators.
  if (isRegionalIndicator(code(0))) return points.length > 1 && isRegionalIndicator(code(1)) ? points[0] + points[1] : null;

  let emoji = points[0];
  let index = 1;
  while (index < points.length) {
    const next = code(index);
    // A variation selector, a skin tone, or a tag (the letters inside a flag such as Scotland's).
    if (next === 0xfe0f || (next >= 0x1f3fb && next <= 0x1f3ff) || (next >= 0xe0020 && next <= 0xe007f)) {
      emoji += points[index];
      index += 1;
    } else if (next === 0x200d && index + 1 < points.length) {
      // A joiner glues the next emoji on: a family, a profession, a couple.
      emoji += points[index] + points[index + 1];
      index += 2;
    } else {
      break;
    }
  }
  // The database allows an avatar emoji of at most 16 characters.
  return Array.from(emoji).length <= 16 ? emoji : null;
}

export function isInviteCodeComplete(raw: string): boolean {
  return /^[A-Z0-9]{12,32}$/.test(raw.replace(/[\s-]/g, '').toUpperCase());
}

// Dates and times read the American way everywhere, whatever the phone or
// browser is set to: month before day, 12-hour clock with AM/PM. The time
// zone is still the device's own.
export const DATE_LOCALE = 'en-US';

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };

/** "Fri, Oct 9 · 7:30 PM" in the phone's own time zone. */
export function dayTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(DATE_LOCALE, DAY)} · ${date.toLocaleTimeString(DATE_LOCALE, TIME)}`;
}

/** "7:30 PM". */
export function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString(DATE_LOCALE, TIME);
}

/** "Fri 7:30 PM", for a chip. */
export function weekdayTime(iso: string): string {
  return new Date(iso).toLocaleString(DATE_LOCALE, { weekday: 'short', ...TIME });
}

/** "in 3 days", "in 5 hours", "in 20 minutes", or "passed". */
export function timeUntil(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return 'passed';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${Math.round(hours / 24)} days`;
}

export function tmdbImage(path: string | null | undefined, size: 'w185' | 'w342' | 'w500' | 'w780' = 'w342'): string | null {
  return path && /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(path) ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
