import type { EventRow } from '@/lib/types';

/** What a movie night is called: Dino's own title for it, or the movie's. */
export function eventTitle(event: EventRow): string {
  return event.title_override ?? event.movie.title;
}
