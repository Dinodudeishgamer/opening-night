// Showday and seats. Pure, so it is unit-tested directly.

/** How long after the showtime the showday card stays up (the movie, then home). */
export const SHOWDAY_AFTER_MS = 4 * 3_600_000;

/** Whether today, on this phone's calendar, is the day of this showtime and it is not long over. */
export function isShowday(startsAt: string, now: Date = new Date()): boolean {
  const start = new Date(startsAt);
  const sameDay = start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth() && start.getDate() === now.getDate();
  return sameDay && now.getTime() < start.getTime() + SHOWDAY_AFTER_MS;
}

/** A seat as the ticket says it, tidied the way the server does: " f 12 " is "F12". Empty is no seat. */
export function tidySeat(raw: string): string | null {
  const seat = raw.replace(/\s+/g, '').toUpperCase();
  return seat === '' ? null : seat;
}

/**
 * In seat order as you look at the screen: row by row (C before D), and within
 * a row from left to right. At our theater the numbers run high to low from
 * the left (C11 on the far left, C7 on the far right), so the larger number
 * comes first. People without a seat last, in the order given.
 */
export function bySeat<T>(items: T[], seatOf: (item: T) => string | null | undefined): T[] {
  const seated = items.filter((item) => seatOf(item));
  const unseated = items.filter((item) => !seatOf(item));
  seated.sort((a, b) => compareSeats(seatOf(a)!, seatOf(b)!));
  return [...seated, ...unseated];
}

function compareSeats(a: string, b: string): number {
  const left = /^([A-Z]+)(\d+)$/.exec(a);
  const right = /^([A-Z]+)(\d+)$/.exec(b);
  if (left && right) return left[1].localeCompare(right[1]) || Number(right[2]) - Number(left[2]);
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}
