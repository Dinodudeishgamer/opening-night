// Results for one movie night: what the group predicted against what it
// rated. Pure, so it is unit-tested directly. Only people who were checked in
// count; the caller passes exactly the rows it is allowed to see.

export interface PersonResult {
  participantId: string;
  name: string;
  isGuest: boolean;
  prediction: number | null;
  rating: number | null;
  /** rating - prediction, when both exist. */
  change: number | null;
}

export interface Summary {
  count: number;
  average: number;
  min: number;
  max: number;
  /** max - min */
  spread: number;
  /** Population standard deviation. */
  stdDev: number;
}

export interface EventStats {
  people: PersonResult[];
  predictions: Summary | null;
  ratings: Summary | null;
  /** Average rating minus average prediction, over people who have both. */
  predictionVsFinal: number | null;
  // Each of the "who" stats below is a list, because people tie: everyone
  // level on the number shares it. Empty means there is nobody to name.
  /** Whoever the movie most pleasantly surprised (largest positive change). */
  biggestRise: PersonResult[];
  /** Whoever it most let down (largest negative change). */
  biggestDrop: PersonResult[];
  /**
   * How close the group's predictions were, 0-100. Mean absolute error
   * across people with both scores, on the 5-point scale: an average miss
   * of 0 is 100, an average miss of 5 is 0.
   */
  accuracy: number | null;
  /** Whoever's prediction landed closest to their own rating. */
  closest: PersonResult[];
  /** The highest rating of the night, and the lowest. Empty unless at least two people rated it differently. */
  fan: PersonResult[];
  critic: PersonResult[];
}

/** The top of the scale; the same number as MAX_SCORE in format.ts. */
const SCALE = 5;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function summarize(values: number[]): Summary | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  const average = sum / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return {
    count: values.length,
    average: round2(average),
    min,
    max,
    spread: round2(max - min),
    stdDev: round2(Math.sqrt(variance)),
  };
}

export function eventStats(
  attendees: { participantId: string; name: string; isGuest: boolean }[],
  predictions: { participant_id: string; score: number }[],
  ratings: { participant_id: string; score: number }[],
): EventStats {
  // A score of 0.0 is a real answer, so presence is checked with has(), never truthiness.
  const predicted = new Map(predictions.map((row) => [row.participant_id, Number(row.score)]));
  const rated = new Map(ratings.map((row) => [row.participant_id, Number(row.score)]));

  const people: PersonResult[] = attendees.map((person) => {
    const prediction = predicted.has(person.participantId) ? predicted.get(person.participantId)! : null;
    const rating = rated.has(person.participantId) ? rated.get(person.participantId)! : null;
    return {
      ...person,
      prediction,
      rating,
      change: prediction !== null && rating !== null ? round2(rating - prediction) : null,
    };
  });

  const both = people.filter((person) => person.change !== null);
  const rises = both.filter((person) => person.change! > 0).sort((a, b) => b.change! - a.change!);
  const drops = both.filter((person) => person.change! < 0).sort((a, b) => a.change! - b.change!);
  const byRating = people.filter((person) => person.rating !== null).sort((a, b) => b.rating! - a.rating!);
  const split = byRating.length >= 2 && byRating[0].rating !== byRating[byRating.length - 1].rating;
  // Everyone level with the leader of a sorted list.
  const level = (sorted: PersonResult[], value: (person: PersonResult) => number) =>
    sorted.length ? sorted.filter((person) => value(person) === value(sorted[0])) : [];
  const nearest = [...both].sort((a, b) => Math.abs(a.change!) - Math.abs(b.change!));
  const meanAbsError = both.length ? both.reduce((total, person) => total + Math.abs(person.change!), 0) / both.length : null;

  return {
    people,
    predictions: summarize(people.filter((p) => p.prediction !== null).map((p) => p.prediction!)),
    ratings: summarize(people.filter((p) => p.rating !== null).map((p) => p.rating!)),
    predictionVsFinal: both.length
      ? round2(both.reduce((total, person) => total + person.change!, 0) / both.length)
      : null,
    biggestRise: level(rises, (person) => person.change!),
    biggestDrop: level(drops, (person) => person.change!),
    accuracy: meanAbsError === null ? null : Math.round((1 - meanAbsError / SCALE) * 100),
    closest: level(nearest, (person) => Math.abs(person.change!)),
    fan: split ? level(byRating, (person) => person.rating!) : [],
    critic: split ? level([...byRating].reverse(), (person) => person.rating!) : [],
  };
}

/**
 * The people who share a stat, as words: "Bob B.", "Bob B. & Carol C.",
 * "Bob B., Carol C. & Dino W.", and past three, "5 people tied". `firstOnly`
 * drops the last initial, for the picture people share.
 */
export function tiedNames(people: { name: string }[], firstOnly = false): string {
  const names = people.map((person) => (firstOnly ? person.name.split(' ')[0] : person.name));
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 3) return `${names.length} people tied`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** What to tell someone about their own guess, given rating minus prediction. */
export function verdict(change: number): string {
  if (Math.abs(change) < 0.13) return 'You called it.';
  if (change >= 1) return 'Way better than you expected.';
  if (change > 0) return 'Better than you expected.';
  if (change <= -1) return 'Nowhere near what you hoped.';
  return 'Not quite what you hoped.';
}
