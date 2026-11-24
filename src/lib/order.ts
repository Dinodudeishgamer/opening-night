// The order of Coming Soon: soonest first. Pure, so it is unit-tested directly.

/**
 * When a night happens, as far as anyone knows yet: its picked showtime, or
 * for one still being planned the first of its showtime options that has not
 * passed. Null when it has no showtimes at all.
 */
export function happensAt(picked: string | undefined, options: string[], now: Date = new Date()): string | null {
  if (picked) return picked;
  const upcoming = options.filter((at) => new Date(at).getTime() >= now.getTime()).sort();
  return upcoming[0] ?? [...options].sort()[0] ?? null;
}

/** Soonest first; nights with no date yet go last, by whose RSVP closes first. */
export function soonestFirst<T extends { rsvp_deadline: string }>(events: T[], when: (event: T) => string | null): T[] {
  return [...events].sort((a, b) => {
    const left = when(a);
    const right = when(b);
    if (left && right) return left.localeCompare(right) || a.rsvp_deadline.localeCompare(b.rsvp_deadline);
    if (left) return -1;
    if (right) return 1;
    return a.rsvp_deadline.localeCompare(b.rsvp_deadline);
  });
}
