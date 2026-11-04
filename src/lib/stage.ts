// Where an event is in its life, derived from its milestones. There is no
// stored phase: the database keeps independent timestamps and this reads
// them, the same way the server-side rules do. Pure; no React Native.
import type { EventRow } from './types.ts';

export const RATING_WINDOW_MS = 48 * 60 * 60 * 1000;

export type Stage =
  | 'rsvp' // gathering answers; voting may already be running alongside
  | 'voting' // RSVP locked, showtime not picked yet
  | 'confirming' // showtime picked, tickets not bought
  | 'ticketed' // tickets bought, night not over
  | 'rating' // night ended, inside the 48 hours
  | 'past';

type Milestones = Pick<
  EventRow,
  'rsvp_deadline' | 'selected_showtime_id' | 'tickets_purchased_at' | 'ended_at' | 'confirmation_deadline' | 'voting_closed_at'
>;

export function isPast(event: Pick<EventRow, 'ended_at'>, now: Date = new Date()): boolean {
  return event.ended_at !== null && now.getTime() >= new Date(event.ended_at).getTime() + RATING_WINDOW_MS;
}

export function stageOf(event: Milestones, now: Date = new Date()): Stage {
  if (event.ended_at) return isPast(event, now) ? 'past' : 'rating';
  if (event.tickets_purchased_at) return 'ticketed';
  if (event.selected_showtime_id) return 'confirming';
  return rsvpOpen(event, now) ? 'rsvp' : 'voting';
}

export function rsvpOpen(event: Milestones, now: Date = new Date()): boolean {
  return !event.selected_showtime_id && !event.ended_at && now.getTime() < new Date(event.rsvp_deadline).getTime();
}

export function confirmationOpen(event: Milestones, now: Date = new Date()): boolean {
  return (
    event.selected_showtime_id !== null &&
    event.tickets_purchased_at === null &&
    event.ended_at === null &&
    event.confirmation_deadline !== null &&
    now.getTime() < new Date(event.confirmation_deadline).getTime()
  );
}

export function ratingOpen(event: Pick<EventRow, 'ended_at'>, now: Date = new Date()): boolean {
  return !isPast(event, now);
}

export const STAGE_LABEL: Record<Stage, string> = {
  rsvp: 'RSVP open',
  voting: 'Picking a showtime',
  confirming: 'Confirming',
  ticketed: 'Tickets bought',
  rating: 'Rate it',
  past: 'Past',
};

/** What Dino should do next for this event, if anything. */
export function ownerNextStep(
  event: Milestones,
  facts: { activeShowtimes: number; eligible: number; voted: number; pendingConfirmations: number; unpaid: number },
  now: Date = new Date(),
): string | null {
  switch (stageOf(event, now)) {
    case 'rsvp':
    case 'voting':
      if (facts.activeShowtimes === 0) return 'Add showtimes so people can vote.';
      if (event.voting_closed_at) return 'Voting is closed. Select the showtime.';
      if (facts.eligible > 0 && facts.voted === facts.eligible) return 'Everyone has voted. Select the showtime.';
      return null;
    case 'confirming':
      if (facts.pendingConfirmations === 0 || !confirmationOpen(event, now)) return 'Buy the tickets and enter the cost.';
      return null;
    case 'ticketed':
      return facts.unpaid > 0 ? `${facts.unpaid} unpaid. Check people in at the theater, then end the night.` : 'Check people in at the theater, then end the night.';
    case 'rating':
    case 'past':
      return facts.unpaid > 0 ? `${facts.unpaid} still unpaid.` : null;
  }
}
