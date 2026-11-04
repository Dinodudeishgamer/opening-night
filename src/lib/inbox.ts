// What the Inbox shows. Pure, so it is unit-tested directly.
//
// The Inbox is a short log of what the app has told a member, not a to-do
// list, and it clears itself. Once a movie night is finished, everything the
// app said while it was being planned is beside the point, so it goes. What
// stays is only what is still about something:
//
//   rating notices        while the 48-hour rating window is open
//   payment notices       while this member still owes for that night
//   Dino's own messages   always
//
// And nothing older than 30 days is shown at all.
import { RATING_WINDOW_MS } from './stage.ts';

export const INBOX_DAYS = 30;

const RATING = new Set(['rating_open', 'rating_reminder']);
const PAYMENT = new Set(['payment_posted', 'payment_reminder']);

export interface InboxNight {
  /** When Dino ended the night; null while it is still to come. */
  endedAt: string | null;
  /** Whether this member (or a guest of theirs) still has an unpaid ticket for it. */
  owes: boolean;
}

export function inboxShows(
  item: { kind: string; created_at: string; event_id: string | null },
  /** The night the item is about, when it is about one that still exists. */
  night: InboxNight | undefined,
  now: Date = new Date(),
): boolean {
  if (now.getTime() - new Date(item.created_at).getTime() > INBOX_DAYS * 86_400_000) return false;
  if (!night?.endedAt) return true;
  if (item.kind === 'announcement') return true;
  if (RATING.has(item.kind)) return now.getTime() < new Date(night.endedAt).getTime() + RATING_WINDOW_MS;
  if (PAYMENT.has(item.kind)) return night.owes;
  return false;
}
