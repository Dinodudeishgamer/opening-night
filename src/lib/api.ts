// Everything the app asks of the backend, in one place.
//
// Reads are plain selects: RLS decides which rows come back. Every write is
// an RPC or an Edge Function; the app holds no table write privilege at all,
// so there is nothing here that could bypass a rule by accident.
import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/supabase';
import type {
  AppSettings, Charge, EventBundle, EventPhoto, EventRow, Guest, InboxItem, Me, Member, Participant, PendingAction,
  Score, Showtime, Theater, TmdbDetails, TmdbSummary, Voting,
} from '@/lib/types';

/** An error whose message is safe and meant to be shown as it is. */
export class ApiError extends Error {
  readonly code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

// The RPCs raise their refusals with these codes and a sentence written for
// the person reading it. Anything else is a fault, and its text stays out of
// the UI.
const SPEAKABLE = new Set(['P0001', 'P0002', '22023', '42501']);

function toApiError(error: { code?: string; message?: string } | null | undefined): ApiError {
  const code = error?.code ?? 'error';
  if (SPEAKABLE.has(code) && error?.message && !/permission denied|violates|relation|function/i.test(error.message)) {
    return new ApiError(error.message, code);
  }
  if (code === '42501') return new ApiError('You do not have access to do that.', code);
  if (code === '23505') return new ApiError('That already exists.', code);
  if (code === '23514') return new ApiError('That value is not allowed.', code);
  return new ApiError('Something went wrong. Check your connection and try again.', code);
}

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Check your connection and try again.';
}

async function rpc<T = void>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toApiError(error);
  return data as T;
}

function rows<T>(result: { data: unknown; error: { code?: string; message?: string } | null }): T[] {
  if (result.error) throw toApiError(result.error);
  return (result.data ?? []) as T[];
}

/**
 * Calls an Edge Function and returns its status and JSON body without
 * throwing on 4xx: the functions answer refusals with an `outcome`.
 *   session: false  pre-auth endpoints, identified by the publishable key alone
 *   session: true   signed-in endpoints, with the caller's access token
 */
export async function callFunction(
  name: string,
  body: Record<string, unknown>,
  options: { session: boolean },
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY };
  if (options.session) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new ApiError('You are signed out. Sign in again.', 'signed_out');
    headers.authorization = `Bearer ${data.session.access_token}`;
  }
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Could not reach Opening Night. Check your connection.', 'network');
  }
  let parsed: Record<string, any> = {};
  try {
    parsed = await response.json();
  } catch {
    // A non-JSON answer is treated as a server fault below.
  }
  return { status: response.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** One thing Dino sent to everyone, as he sees it in Manage. */
export interface Announcement {
  batch: string;
  title: string;
  body: string | null;
  sent_at: string;
  expires_at: string | null;
  recipients: number;
  /** How many members have opened their Inbox since. */
  seen: number;
}

export type WhoAmI = ({ outcome: 'ok' } & Me) | { outcome: 'no_member'; pending_invite: boolean };

export const whoami = () => rpc<WhoAmI>('whoami');
export const completeInviteClaim = () => rpc<{ outcome: string; mode?: string }>('complete_invite_claim');

const MEMBER_COLUMNS = 'id, first_name, last_initial, role, status, avatar_kind, avatar_emoji, avatar_path, letterboxd';

export async function listMembers(): Promise<Member[]> {
  return rows<Member>(await supabase.from('members').select(MEMBER_COLUMNS).order('first_name'));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_COLUMNS =
  'id, movie_id, rsvp_deadline, voting_revision, selected_showtime_id, showtime_selected_at, confirmation_deadline, ' +
  'tickets_purchased_at, ended_at, created_at, poster_path, backdrop_path, title_override, description_override, ' +
  'owner_note, voting_closed_at, schedule_revision, total_cost_cents, movie:movies(*)';
const PARTICIPANT_COLUMNS = 'id, event_id, member_id, guest_id, rsvp_status, confirmation_status, checked_in_at';

export async function listEvents(): Promise<EventRow[]> {
  return rows<EventRow>(await supabase.from('events').select(EVENT_COLUMNS).order('created_at', { ascending: false }));
}

/** The selected showtime of each event that has one, keyed by event id. */
export async function listSelectedShowtimes(events: EventRow[]): Promise<Record<string, Showtime>> {
  const ids = events.map((event) => event.selected_showtime_id).filter((id): id is string => id !== null);
  if (ids.length === 0) return {};
  const list = rows<Showtime>(await supabase.from('showtimes').select('*, theater:theaters(*)').in('id', ids));
  return Object.fromEntries(list.map((showtime) => [showtime.event_id, showtime]));
}

/** Who is on each of these events, as far as the caller may see, keyed by event id. */
export async function listParticipants(eventIds: string[]): Promise<Record<string, Participant[]>> {
  if (eventIds.length === 0) return {};
  const list = rows<Participant>(await supabase.from('event_participants').select(PARTICIPANT_COLUMNS).in('event_id', eventIds));
  const byEvent: Record<string, Participant[]> = {};
  for (const row of list) (byEvent[row.event_id] ??= []).push(row);
  return byEvent;
}

const numeric = (list: Score[]): Score[] => list.map((row) => ({ ...row, score: Number(row.score) }));

export async function loadEvent(eventId: string): Promise<EventBundle | null> {
  const [event, showtimes, participants, charges, predictions, ratings, photos, voting] = await Promise.all([
    supabase.from('events').select(EVENT_COLUMNS).eq('id', eventId).maybeSingle(),
    supabase.from('showtimes').select('*, theater:theaters(*)').eq('event_id', eventId).order('starts_at'),
    supabase.from('event_participants').select(PARTICIPANT_COLUMNS).eq('event_id', eventId),
    supabase.from('charges').select('id, event_id, participant_id, amount_cents, status, paid_at').eq('event_id', eventId),
    supabase.from('predictions').select('participant_id, event_id, score, is_active').eq('event_id', eventId),
    supabase.from('ratings').select('participant_id, event_id, score').eq('event_id', eventId),
    supabase.from('event_media').select('id, event_id, uploader_member_id, storage_path, width, height, created_at')
      .eq('event_id', eventId).eq('media_type', 'photo').order('created_at'),
    supabase.rpc('get_voting', { p_event_id: eventId }),
  ]);
  if (event.error) throw toApiError(event.error);
  if (!event.data) return null;
  // A deleted event makes get_voting raise; the event query above already returned null for that.
  if (voting.error) throw toApiError(voting.error);

  const people = rows<Participant>(participants);
  const guestIds = people.map((p) => p.guest_id).filter((id): id is string => id !== null);
  const guests = guestIds.length
    ? rows<Guest>(await supabase.from('guests').select('id, display_name, host_member_id').in('id', guestIds))
    : [];

  return {
    event: event.data as unknown as EventRow,
    showtimes: rows<Showtime>(showtimes),
    participants: people,
    guests,
    charges: rows<Charge>(charges),
    predictions: numeric(rows<Score>(predictions)),
    ratings: numeric(rows<Score>(ratings)),
    photos: rows<EventPhoto>(photos),
    voting: voting.data as Voting,
  };
}

/** The signed-in member's own history: the nights they were checked in at, and their own scores. */
export async function myScores(memberId: string): Promise<{ nights: number; ratings: Score[]; predictions: Score[] }> {
  const mine = rows<{ id: string; checked_in_at: string | null }>(
    await supabase.from('event_participants').select('id, checked_in_at').eq('member_id', memberId),
  );
  const ids = mine.map((row) => row.id);
  if (ids.length === 0) return { nights: 0, ratings: [], predictions: [] };
  const [ratings, predictions] = await Promise.all([
    supabase.from('ratings').select('participant_id, event_id, score').in('participant_id', ids),
    supabase.from('predictions').select('participant_id, event_id, score, is_active').in('participant_id', ids),
  ]);
  return {
    nights: mine.filter((row) => row.checked_in_at).length,
    ratings: numeric(rows<Score>(ratings)),
    predictions: numeric(rows<Score>(predictions)).filter((row) => row.is_active !== false),
  };
}

/**
 * Everything the Club page adds up: every finished night, who was checked in
 * at each, and the guesses and ratings the caller may see. Once a night is
 * over its attendees and guesses are open to the whole club; ratings open
 * 48 hours after it ends.
 */
export async function loadClub(): Promise<{ events: EventRow[]; participants: Participant[]; predictions: Score[]; ratings: Score[] }> {
  const events = (await listEvents()).filter((event) => event.ended_at);
  const ids = events.map((event) => event.id);
  if (ids.length === 0) return { events, participants: [], predictions: [], ratings: [] };
  const [participants, predictions, ratings] = await Promise.all([
    supabase.from('event_participants').select(PARTICIPANT_COLUMNS).in('event_id', ids).not('checked_in_at', 'is', null),
    supabase.from('predictions').select('participant_id, event_id, score, is_active').in('event_id', ids).eq('is_active', true),
    supabase.from('ratings').select('participant_id, event_id, score').in('event_id', ids),
  ]);
  return {
    events,
    participants: rows<Participant>(participants),
    predictions: numeric(rows<Score>(predictions)),
    ratings: numeric(rows<Score>(ratings)),
  };
}

/** Ratings the caller may see, for the Past list's averages. */
export async function listVisibleRatings(): Promise<Score[]> {
  return numeric(rows<Score>(await supabase.from('ratings').select('participant_id, event_id, score')));
}

export async function listTheaters(): Promise<Theater[]> {
  return rows<Theater>(await supabase.from('theaters').select('id, name, address, time_zone').order('name'));
}

export async function getSettings(): Promise<AppSettings | null> {
  const result = await supabase.from('app_settings').select('venmo_username, apple_cash_recipient, payment_note').maybeSingle();
  if (result.error) throw toApiError(result.error);
  return result.data as AppSettings | null;
}

export const getPendingActions = () => rpc<PendingAction[]>('get_pending_actions');

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export async function listInbox(): Promise<InboxItem[]> {
  return rows<InboxItem>(
    await supabase.from('notifications').select('id, event_id, kind, title, body, created_at, read_at')
      .order('created_at', { ascending: false }).limit(100),
  );
}

export async function markInboxRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids);
  if (error) throw toApiError(error);
}

// ---------------------------------------------------------------------------
// Member actions
// ---------------------------------------------------------------------------

export const actions = {
  setRsvp: (eventId: string, status: string, memberId?: string) =>
    rpc('set_rsvp', { p_event_id: eventId, p_status: status, p_member_id: memberId ?? null }),
  addGuest: (eventId: string, name: string, status = 'going', hostMemberId?: string) =>
    rpc<string>('add_guest', { p_event_id: eventId, p_name: name, p_status: status, p_host_member_id: hostMemberId ?? null }),
  updateGuest: (guestId: string, name: string, status: string) =>
    rpc('update_guest', { p_guest_id: guestId, p_name: name, p_status: status }),
  removeGuest: (guestId: string) => rpc('remove_guest', { p_guest_id: guestId }),
  submitBallot: (participantId: string, showtimeIds: string[]) =>
    rpc('submit_ballot', { p_participant_id: participantId, p_showtime_ids: showtimeIds }),
  setConfirmation: (participantId: string, status: string) =>
    rpc('set_confirmation', { p_participant_id: participantId, p_status: status }),
  submitPrediction: (participantId: string, score: number) =>
    rpc('submit_prediction', { p_participant_id: participantId, p_score: score }),
  submitRating: (eventId: string, score: number) => rpc('submit_rating', { p_event_id: eventId, p_score: score }),
  /** A guest's rating, entered by their host. */
  submitGuestRating: (participantId: string, score: number) => rpc('submit_guest_rating', { p_participant_id: participantId, p_score: score }),
  setMyAvatar: (kind: string, emoji?: string | null, path?: string | null) =>
    rpc('set_my_avatar', { p_kind: kind, p_emoji: emoji ?? null, p_path: path ?? null }),
  registerPhoto: (eventId: string, path: string, width: number, height: number, bytes: number) =>
    rpc<string>('register_event_photo', { p_event_id: eventId, p_storage_path: path, p_width: width, p_height: height, p_byte_size: bytes }),
  deletePhoto: (mediaId: string) => rpc<string>('delete_event_photo', { p_media_id: mediaId }),
  registerPushDevice: (token: string, platform: string) => rpc('register_push_device', { p_push_token: token, p_platform: platform }),
  unregisterPushDevice: (token: string) => rpc('unregister_push_device', { p_push_token: token }),
  /** Deletes the caller's account: outright if they were never on a movie night, otherwise made anonymous. */
  /** Links (or, with an empty name, unlinks) the caller's Letterboxd. Returns the username kept. */
  setMyLetterboxd: (username: string) => rpc<string | null>('set_my_letterboxd', { p_username: username }),
  deleteMyAccount: () => rpc<'deleted' | 'anonymized'>('delete_my_account'),
};

// ---------------------------------------------------------------------------
// Dino's actions. The database refuses every one of these for anyone else.
// ---------------------------------------------------------------------------

export interface ShowtimeInput {
  theaterId: string;
  startsAt: string;
  format: string;
  formatOther: string | null;
}

export const owner = {
  /** How many phones a club-wide notification reaches, and who has not signed in to see one. */
  reach: () => rpc<{ phones: number; not_signed_in: string[] }>('owner_reach'),
  memberAccess: () =>
    rpc<{ member_id: string; has_login: boolean; invite_open: boolean; invite_expires_at: string | null; invite_started: boolean }[]>('owner_member_access'),
  renameMember: (memberId: string, firstName: string, lastInitial: string) =>
    rpc('rename_member', { p_member_id: memberId, p_first_name: firstName, p_last_initial: lastInitial }),
  setMemberStatus: (memberId: string, status: string) => rpc('set_member_status', { p_member_id: memberId, p_status: status }),
  resetMemberAccess: (memberId: string) => rpc('reset_member_access', { p_member_id: memberId }),
  revokeInvite: (memberId: string) => rpc<boolean>('revoke_member_invite', { p_member_id: memberId }),

  saveTheater: (theaterId: string | null, name: string, address: string) =>
    rpc<string>('save_theater', { p_theater_id: theaterId, p_name: name, p_address: address }),

  createEvent: (input: {
    movie: Record<string, unknown>; rsvpDeadline: string; posterPath: string | null; backdropPath: string | null;
    titleOverride: string; descriptionOverride: string; ownerNote: string;
  }) =>
    rpc<string>('create_event', {
      p_movie: input.movie, p_rsvp_deadline: input.rsvpDeadline, p_poster_path: input.posterPath,
      p_backdrop_path: input.backdropPath, p_title_override: input.titleOverride,
      p_description_override: input.descriptionOverride, p_owner_note: input.ownerNote,
    }),
  updateEvent: (eventId: string, patch: Record<string, unknown>) => rpc('update_event', { p_event_id: eventId, p_patch: patch }),
  deleteEvent: (eventId: string) => rpc<string[]>('delete_event', { p_event_id: eventId }),

  addShowtime: (eventId: string, s: ShowtimeInput) =>
    rpc<string>('add_showtime', { p_event_id: eventId, p_theater_id: s.theaterId, p_starts_at: s.startsAt, p_format: s.format, p_format_other: s.formatOther }),
  updateShowtime: (showtimeId: string, s: ShowtimeInput) =>
    rpc('update_showtime', { p_showtime_id: showtimeId, p_theater_id: s.theaterId, p_starts_at: s.startsAt, p_format: s.format, p_format_other: s.formatOther }),
  removeShowtime: (showtimeId: string) => rpc('remove_showtime', { p_showtime_id: showtimeId }),
  closeVoting: (eventId: string) => rpc('close_voting', { p_event_id: eventId }),
  reopenVoting: (eventId: string) => rpc('reopen_voting', { p_event_id: eventId }),
  selectShowtime: (eventId: string, showtimeId: string, confirmationDeadline: string) =>
    rpc('select_showtime', { p_event_id: eventId, p_showtime_id: showtimeId, p_confirmation_deadline: confirmationDeadline }),
  reschedule: (eventId: string, s: ShowtimeInput, confirmationDeadline: string) =>
    rpc<string>('reschedule_event', {
      p_event_id: eventId, p_theater_id: s.theaterId, p_starts_at: s.startsAt, p_format: s.format,
      p_format_other: s.formatOther, p_confirmation_deadline: confirmationDeadline,
    }),
  roster: (eventId: string) =>
    rpc<{ participant_id: string; prior_confirmation_status: string | null; has_prediction: boolean }[]>('owner_roster', { p_event_id: eventId }),

  recordTickets: (eventId: string, totalCents: number) =>
    rpc('record_ticket_purchase', { p_event_id: eventId, p_total_cost_cents: totalCents }),
  updateTicketCost: (eventId: string, totalCents: number) =>
    rpc('update_ticket_cost', { p_event_id: eventId, p_total_cost_cents: totalCents }),
  setChargeAmount: (chargeId: string, cents: number) => rpc('set_charge_amount', { p_charge_id: chargeId, p_amount_cents: cents }),
  setChargePaid: (chargeId: string, paid: boolean) => rpc('set_charge_paid', { p_charge_id: chargeId, p_paid: paid }),
  deleteCharge: (chargeId: string) => rpc('delete_charge', { p_charge_id: chargeId }),

  checkIn: (participantId: string, prediction: number | null) =>
    rpc('check_in', { p_participant_id: participantId, p_prediction: prediction }),
  undoCheckIn: (participantId: string) => rpc('undo_check_in', { p_participant_id: participantId }),
  /** The guest's place on their movie night becomes this member's own, with everything recorded on it. */
  promoteGuest: (guestId: string, memberId: string) => rpc<string>('promote_guest', { p_guest_id: guestId, p_member_id: memberId }),
  addWalkIn: (eventId: string, who: { memberId?: string; guestName?: string; hostMemberId?: string }, prediction: number | null) =>
    rpc<string>('add_walk_in', {
      p_event_id: eventId, p_member_id: who.memberId ?? null, p_guest_name: who.guestName ?? null,
      p_host_member_id: who.hostMemberId ?? null, p_prediction: prediction,
    }),
  endEvent: (eventId: string) => rpc('end_event', { p_event_id: eventId }),
  reopenEvent: (eventId: string) => rpc('reopen_event', { p_event_id: eventId }),
  setPrediction: (participantId: string, score: number) => rpc('owner_set_prediction', { p_participant_id: participantId, p_score: score }),
  setRating: (participantId: string, score: number) => rpc('owner_set_rating', { p_participant_id: participantId, p_score: score }),
  /** `expiresAt` null means it stays until Dino removes it (or 30 days pass). */
  sendNotification: (title: string, body: string, eventId: string | null, expiresAt: string | null = null) =>
    rpc<number>('send_notification', { p_title: title, p_body: body, p_event_id: eventId, p_member_ids: null, p_expires_at: expiresAt }),
  listAnnouncements: () => rpc<Announcement[]>('list_announcements'),
  removeAnnouncement: (batch: string) => rpc<number>('remove_announcement', { p_batch: batch }),
};

/**
 * Creates a member, or a new invite for one. Returns the code to hand over,
 * once. `custom_code` is a code Dino chose himself; left out or empty, the
 * server makes a random one.
 */
export async function issueInvite(
  input: ({ action: 'create_member'; first_name: string; last_initial: string } | { action: 'create_invite'; member_id: string }) & {
    custom_code?: string;
  },
): Promise<{ inviteCode: string; memberId: string }> {
  const { status, body } = await callFunction('owner-members', input, { session: true });
  if (status === 200 && body.outcome === 'ok') return { inviteCode: body.invite_code, memberId: body.member_id };
  if (body.outcome === 'invalid_code') {
    throw new ApiError('A custom code needs 12 to 32 letters and numbers. Spaces and dashes do not count.', 'invalid_code');
  }
  if (body.outcome === 'code_taken') throw new ApiError('That code has been used before. Pick a different one.', 'code_taken');
  if (status === 403) throw new ApiError('Only the organizer can do that.', 'forbidden');
  if (status === 400) throw new ApiError('Check the name: a first name and one last initial.', 'invalid_request');
  if (status === 404) throw new ApiError('That member no longer exists.', 'not_found');
  throw new ApiError('Could not create the invite. Try again.', 'server_error');
}

async function tmdb<T>(body: Record<string, unknown>): Promise<T> {
  const { status, body: answer } = await callFunction('tmdb', body, { session: true });
  if (status === 200 && answer.outcome === 'ok') return answer as T;
  if (status === 503) throw new ApiError('Movie search is not set up yet: the TMDB key is missing on the server.', 'not_configured');
  if (status === 403) throw new ApiError('Only the organizer can search for movies.', 'forbidden');
  if (status === 404) throw new ApiError('TMDB does not have that movie.', 'not_found');
  throw new ApiError('Movie search is unavailable right now.', 'server_error');
}

export const searchMovies = async (query: string) => (await tmdb<{ results: TmdbSummary[] }>({ action: 'search', query })).results;
export const movieDetails = (tmdbId: number) => tmdb<TmdbDetails>({ action: 'details', tmdb_id: tmdbId });
