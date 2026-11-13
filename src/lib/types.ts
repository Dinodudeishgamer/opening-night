// Shapes of what the app reads from the database. Kept to what a signed-in
// member can actually select: see the column grants in supabase/migrations.

export type RsvpStatus = 'going' | 'maybe' | 'cant_go';
export type ConfirmationStatus = 'attending' | 'not_attending';
export type ShowtimeFormat = 'standard' | 'imax' | 'xd' | 'dolby' | '3d' | 'other';
export type AvatarKind = 'initials' | 'emoji' | 'photo';

export interface Member {
  id: string;
  first_name: string;
  last_initial: string;
  role: 'owner' | 'member';
  status: 'active' | 'deactivated' | 'removed';
  avatar_kind: AvatarKind;
  avatar_emoji: string | null;
  avatar_path: string | null;
  /** Their Letterboxd username, if they linked it. */
  letterboxd: string | null;
}

export interface Movie {
  id: string;
  tmdb_id: number | null;
  title: string;
  release_date: string | null;
  runtime_minutes: number | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  metadata: { tagline?: string | null; genres?: string[]; trailer_key?: string | null };
}

export interface EventRow {
  id: string;
  movie_id: string;
  rsvp_deadline: string;
  voting_revision: number;
  selected_showtime_id: string | null;
  showtime_selected_at: string | null;
  confirmation_deadline: string | null;
  tickets_purchased_at: string | null;
  ended_at: string | null;
  created_at: string;
  poster_path: string | null;
  backdrop_path: string | null;
  title_override: string | null;
  description_override: string | null;
  owner_note: string | null;
  voting_closed_at: string | null;
  schedule_revision: number;
  total_cost_cents: number | null;
  movie: Movie;
}

export interface Theater {
  id: string;
  name: string;
  address: string | null;
  time_zone: string;
}

export interface Showtime {
  id: string;
  event_id: string;
  theater_id: string;
  starts_at: string;
  format: ShowtimeFormat;
  format_other: string | null;
  removed_at: string | null;
  theater: Theater;
}

export interface Participant {
  id: string;
  event_id: string;
  member_id: string | null;
  guest_id: string | null;
  rsvp_status: RsvpStatus | null;
  confirmation_status: ConfirmationStatus | null;
  checked_in_at: string | null;
}

export interface Guest {
  id: string;
  display_name: string;
  host_member_id: string;
}

export interface Charge {
  id: string;
  event_id: string;
  participant_id: string;
  amount_cents: number;
  status: 'unpaid' | 'paid';
  paid_at: string | null;
}

export interface Score {
  participant_id: string;
  event_id: string;
  score: number;
  is_active?: boolean;
}

export interface EventPhoto {
  id: string;
  event_id: string;
  uploader_member_id: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface AppSettings {
  venmo_username: string | null;
  apple_cash_recipient: string | null;
  payment_note: string | null;
}

export interface InboxItem {
  id: string;
  event_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
}

export type PendingKind = 'rsvp' | 'vote' | 'confirm' | 'pay' | 'predict' | 'rate';

export interface PendingAction {
  event_id: string;
  participant_id: string | null;
  kind: PendingKind;
  due_at: string | null;
}

export interface VotingRow {
  participant_id: string;
  member_id: string | null;
  guest_id: string | null;
  current: boolean;
  showtime_ids: string[];
}

export interface Voting {
  voting_revision: number;
  open: boolean;
  closed_at: string | null;
  eligible: number;
  voted: number;
  counts: { showtime_id: string; available: number }[];
  mine: VotingRow[];
  /** Dino only. */
  matrix: VotingRow[] | null;
}

export interface Me {
  member_id: string;
  first_name: string;
  last_initial: string;
  role: 'owner' | 'member';
}

/** Everything the event page shows, loaded together. */
export interface EventBundle {
  event: EventRow;
  showtimes: Showtime[];
  participants: Participant[];
  guests: Guest[];
  charges: Charge[];
  predictions: Score[];
  ratings: Score[];
  photos: EventPhoto[];
  voting: Voting;
}

export interface TmdbSummary {
  tmdb_id: number;
  title: string;
  release_date: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
}

export interface TmdbDetails {
  movie: TmdbSummary & { runtime_minutes: number | null; metadata: Record<string, unknown> };
  posters: string[];
  backdrops: string[];
}
