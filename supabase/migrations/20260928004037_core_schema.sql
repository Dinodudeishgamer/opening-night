-- Opening Night v3 — core data model.
--
-- Creates the application tables, their integrity constraints, RLS, the
-- identity helpers the policies are keyed on, and read-only access for active
-- members. The ONLY member write path is marking their own notifications
-- read. Member names, roles, and status; RSVPs; availability; predictions;
-- ratings; check-in; charges; and media all get their write paths (RPCs or
-- narrow policies) in the workflow migrations that own those rules. No seed
-- data, Storage buckets, Auth hooks, or workflow automation here.
--
-- Conventions:
--   - Application data is keyed on members.id, never on auth.users.id. The
--     only link between the two is private.auth_claims.
--   - Bounded states are text + CHECK, not Postgres enums.
--   - Workflow milestones are independent nullable timestamps, not a phase
--     enum. An event's stage is derived from which milestones are set.
--   - Rows that belong to one event carry event_id and use composite foreign
--     keys, so a participant, showtime, and pick can never straddle events.
--   - Scores are numeric(3,1) in [0.0, 10.0]. Money is integer cents.
--   - Deleting an event is deliberate and total: everything the app shows
--     about it (showtimes, participants, picks, scores, charges, media rows,
--     notifications) cascades away with it. Only private.audit_log, which
--     has no foreign keys, outlives it.
--   - Phone numbers, invite codes, push tokens, delivery state, rate limits,
--     and the audit log live in private, which API roles cannot read.

-- ---------------------------------------------------------------------------
-- 0. updated_at maintenance
-- ---------------------------------------------------------------------------

-- Plain trigger function (not SECURITY DEFINER). Nobody is granted EXECUTE:
-- Postgres checks that only when a trigger is created, not when it fires.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Members and identity
-- ---------------------------------------------------------------------------

create table public.members (
  id                 uuid        primary key default gen_random_uuid(),
  first_name         text        not null,
  last_initial       text        not null,
  role               text        not null default 'member',
  -- active: can sign in. deactivated: access paused, expected back.
  -- removed: left the group; the row stays so history keeps its author.
  status             text        not null default 'active',
  status_changed_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint members_first_name_check
    check (first_name = btrim(first_name) and char_length(first_name) between 1 and 40),
  constraint members_last_initial_check
    check (char_length(last_initial) = 1 and last_initial = upper(last_initial)),
  constraint members_role_check
    check (role in ('member', 'owner')),
  constraint members_status_check
    check (status in ('active', 'deactivated', 'removed')),
  constraint members_status_changed_at_check
    check (status = 'active' or status_changed_at is not null)
);

-- The group has exactly one organizer; every stage transition is theirs.
create unique index members_single_owner on public.members (role) where role = 'owner';

-- An invite lets one member claim an account. Dino creates it WITHOUT a
-- phone number; the lifecycle is:
--
--   1. Dino creates the invite            phone_e164 null
--   2. member enters the invite code
--   3. member supplies their phone        phone_e164 set (pending, may be
--                                         corrected until redeemed)
--   4. SMS OTP verifies that phone
--   5. claim is written                   redeemed_at set; an auth_claims
--                                         row now binds that phone to the
--                                         member
--
-- The bound phone lives on the claim (private.auth_claims). It is what the
-- member signs back in with on a new device. A signed-in member can later
-- move it to a new number via Supabase Auth's phone_change OTP; once that
-- verifies, a server-side workflow syncs the verified Auth phone onto the
-- claim. The invite plays no part in a phone change.
--
-- The code itself is never stored: code_hash is an HMAC-SHA-256 (hex)
-- computed server-side with a secret the database does not hold, so a leaked
-- row cannot be brute-forced back to a short code.
create table private.member_invites (
  id                    uuid        primary key default gen_random_uuid(),
  member_id             uuid        not null references public.members (id) on delete cascade,
  code_hash             text        not null,
  -- Null until the member supplies it (step 3). Never entered by Dino.
  phone_e164            text,
  created_by_member_id  uuid        references public.members (id) on delete set null,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz,
  redeemed_at           timestamptz,
  revoked_at            timestamptz,
  constraint member_invites_code_hash_check
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint member_invites_phone_check
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint member_invites_redeemed_phone_check
    check (redeemed_at is null or phone_e164 is not null),
  constraint member_invites_closed_once_check
    check (redeemed_at is null or revoked_at is null),
  constraint member_invites_code_hash_key unique (code_hash)
);

-- At most one open invite per member.
create unique index member_invites_one_open_per_member
  on private.member_invites (member_id)
  where redeemed_at is null and revoked_at is null;

-- A supplied phone can be pending on only one open invite at a time. Open
-- invites with no phone yet are unconstrained.
create unique index member_invites_one_open_per_phone
  on private.member_invites (phone_e164)
  where phone_e164 is not null and redeemed_at is null and revoked_at is null;

-- Links a Supabase Auth user (phone-verified via OTP) to the member they
-- redeemed an invite for, and binds that phone to the member. Revoking a
-- claim cuts access immediately: current_member_id() only honours unrevoked
-- claims for active members.
create table private.auth_claims (
  auth_user_id          uuid        primary key references auth.users (id) on delete cascade,
  member_id             uuid        not null references public.members (id) on delete restrict,
  invite_id             uuid        references private.member_invites (id) on delete set null,
  phone_e164            text        not null,
  claimed_at            timestamptz not null default now(),
  revoked_at            timestamptz,
  revoked_by_member_id  uuid        references public.members (id) on delete set null,
  constraint auth_claims_phone_check
    check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint auth_claims_revoked_by_check
    check (revoked_by_member_id is null or revoked_at is not null)
);

-- One live login per member; revoked claims stay as history.
create unique index auth_claims_one_active_per_member
  on private.auth_claims (member_id)
  where revoked_at is null;

-- And one member per live phone number.
create unique index auth_claims_one_active_per_phone
  on private.auth_claims (phone_e164)
  where revoked_at is null;

-- Guards a claim's history.
--   Every claim: auth_user_id, member_id, and claimed_at never change;
--     linking a different member or login is a new claim.
--   Active claim (revoked_at null): phone_e164 may change, to follow the
--     verified Supabase Auth phone after a phone_change OTP. Only a later
--     narrow SECURITY DEFINER sync function writes it; authenticated has no
--     access to this table.
--   Revoked claim: frozen. phone_e164 and revoked_at can no longer change,
--     and invite_id / revoked_by_member_id can only be cleared to null, which
--     is what their ON DELETE SET NULL keys do.
-- Plain trigger function; nobody is granted EXECUTE.
create function private.auth_claims_guard_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.auth_user_id is distinct from old.auth_user_id
     or new.member_id is distinct from old.member_id
     or new.claimed_at is distinct from old.claimed_at then
    raise exception 'auth_claims auth_user_id, member_id, and claimed_at are immutable; link a new claim instead'
      using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or new.phone_e164 is distinct from old.phone_e164
          or (new.invite_id is distinct from old.invite_id and new.invite_id is not null)
          or (new.revoked_by_member_id is distinct from old.revoked_by_member_id
              and new.revoked_by_member_id is not null)) then
    raise exception 'revoked auth_claims are frozen; only an active claim''s phone may change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.auth_claims_guard_binding() from public, anon, authenticated, service_role;

create trigger guard_binding before update on private.auth_claims
  for each row execute function private.auth_claims_guard_binding();

-- Throttling for the unauthenticated steps of sign-in. subject_hash is a
-- server-side hash of the throttled key (phone, IP, invite), never the raw
-- value.
create table private.rate_limits (
  scope              text        not null,
  subject_hash       text        not null,
  window_started_at  timestamptz not null,
  attempt_count      integer     not null default 0,
  locked_until       timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (scope, subject_hash, window_started_at),
  constraint rate_limits_scope_check
    check (scope in ('invite_redeem', 'otp_request', 'otp_verify')),
  constraint rate_limits_attempt_count_check
    check (attempt_count >= 0)
);

-- ---------------------------------------------------------------------------
-- 2. Movies, theaters, events
-- ---------------------------------------------------------------------------

create table public.movies (
  id               uuid        primary key default gen_random_uuid(),
  tmdb_id          integer,
  title            text        not null,
  release_date     date,
  runtime_minutes  integer,
  overview         text,
  poster_path      text,
  backdrop_path    text,
  metadata         jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint movies_title_check
    check (title = btrim(title) and title <> ''),
  constraint movies_tmdb_id_check
    check (tmdb_id > 0),
  constraint movies_runtime_check
    check (runtime_minutes > 0),
  constraint movies_metadata_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint movies_tmdb_id_key unique (tmdb_id)
);

create table public.theaters (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  address     text,
  time_zone   text        not null default 'America/Chicago',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint theaters_name_check
    check (name = btrim(name) and name <> ''),
  constraint theaters_time_zone_check
    check (time_zone <> '')
);

-- There is no starts_at: an event's date and time are the selected
-- showtime's. Milestones are independent; each is set by Dino.
create table public.events (
  id                     uuid        primary key default gen_random_uuid(),
  movie_id               uuid        not null references public.movies (id) on delete restrict,
  -- Every event has one; there is no draft state without it.
  rsvp_deadline          timestamptz not null,
  -- Bumped when the showtime slate is revised in a way that invalidates
  -- earlier picks; picks recorded under an older revision are stale.
  voting_revision        integer     not null default 1,
  selected_showtime_id   uuid,
  showtime_selected_at   timestamptz,
  confirmation_deadline  timestamptz,
  tickets_purchased_at   timestamptz,
  ended_at               timestamptz,
  ended_by_member_id     uuid        references public.members (id) on delete restrict,
  created_by_member_id   uuid        references public.members (id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint events_voting_revision_check
    check (voting_revision >= 1),
  constraint events_showtime_selected_check
    check ((selected_showtime_id is null) = (showtime_selected_at is null)),
  constraint events_tickets_need_showtime_check
    check (tickets_purchased_at is null or selected_showtime_id is not null),
  constraint events_ended_by_check
    check (ended_by_member_id is null or ended_at is not null)
);

create index events_movie_id_idx on public.events (movie_id);

-- ---------------------------------------------------------------------------
-- 3. Showtimes
-- ---------------------------------------------------------------------------

create table public.showtimes (
  id                    uuid        primary key default gen_random_uuid(),
  event_id              uuid        not null references public.events (id) on delete cascade,
  theater_id            uuid        not null references public.theaters (id) on delete restrict,
  starts_at             timestamptz not null,
  format                text        not null default 'standard',
  format_other          text,
  -- Bumped when this showtime's theater, time, or format is edited; a pick
  -- recorded against an older revision is stale.
  revision              integer     not null default 1,
  -- Soft removal. Dino removes a showtime by setting these; it drops out of
  -- active voting but the row stays, so picks made against it remain
  -- auditable. Showtimes are never hard-deleted except with their event.
  removed_at            timestamptz,
  removed_by_member_id  uuid        references public.members (id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint showtimes_format_check
    check (format in ('standard', 'imax', 'xd', 'dolby', '3d', 'other')),
  constraint showtimes_format_other_check
    check ((format = 'other') = (format_other is not null)
           and (format_other is null or (format_other = btrim(format_other) and format_other <> ''))),
  constraint showtimes_revision_check
    check (revision >= 1),
  constraint showtimes_removed_by_check
    check ((removed_at is null) = (removed_by_member_id is null)),
  constraint showtimes_id_event_key unique (id, event_id)
);

-- No duplicate slot among an event's active showtimes. Removed rows are
-- excluded, so Dino can remove a slot and add it back.
create unique index showtimes_active_slot_key
  on public.showtimes (event_id, theater_id, starts_at, format, format_other)
  nulls not distinct
  where removed_at is null;

create index showtimes_event_starts_idx on public.showtimes (event_id, starts_at);
create index showtimes_theater_id_idx on public.showtimes (theater_id);

-- The selected showtime must belong to the same event.
alter table public.events
  add constraint events_selected_showtime_fkey
  foreign key (selected_showtime_id, id) references public.showtimes (id, event_id);

create index events_selected_showtime_idx on public.events (selected_showtime_id)
  where selected_showtime_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Guests and participants
-- ---------------------------------------------------------------------------

-- A guest is a person without an account, brought by a host member. Guests
-- are never linked or matched to members automatically.
create table public.guests (
  id              uuid        primary key default gen_random_uuid(),
  display_name    text        not null,
  host_member_id  uuid        not null references public.members (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint guests_display_name_check
    check (display_name = btrim(display_name) and char_length(display_name) between 1 and 60)
);

create index guests_host_member_id_idx on public.guests (host_member_id);

-- One row per person per event, member or guest. Every per-person workflow
-- (availability, prediction, rating, charge) hangs off this row, so guests
-- get the same independent state as members without a parallel workflow.
create table public.event_participants (
  id                        uuid        primary key default gen_random_uuid(),
  event_id                  uuid        not null references public.events (id) on delete cascade,
  member_id                 uuid        references public.members (id) on delete restrict,
  guest_id                  uuid        references public.guests (id) on delete restrict,
  -- going / maybe / cant_go. Null = not answered yet.
  rsvp_status               text,
  rsvp_updated_at           timestamptz,
  -- "Can I make the selected showtime?" Null = not answered.
  confirmation_status       text,
  confirmation_updated_at   timestamptz,
  checked_in_at             timestamptz,
  checked_in_by_member_id   uuid        references public.members (id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint event_participants_one_identity_check
    check (num_nonnulls(member_id, guest_id) = 1),
  constraint event_participants_rsvp_status_check
    check (rsvp_status in ('going', 'maybe', 'cant_go')),
  constraint event_participants_confirmation_status_check
    check (confirmation_status in ('attending', 'not_attending')),
  constraint event_participants_checked_in_by_check
    check ((checked_in_at is null) = (checked_in_by_member_id is null)),
  constraint event_participants_id_event_key unique (id, event_id),
  constraint event_participants_event_member_key unique (event_id, member_id),
  constraint event_participants_event_guest_key unique (event_id, guest_id)
);

create index event_participants_member_id_idx on public.event_participants (member_id)
  where member_id is not null;
create index event_participants_guest_id_idx on public.event_participants (guest_id)
  where guest_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Showtime availability
-- ---------------------------------------------------------------------------

-- One answer per participant per showtime. Voting eligibility is NOT stored:
-- it is computed from the participant's current rsvp_status, so a pick from
-- someone who has since switched to cant_go simply stops counting. Picks are
-- stale when voting_revision < events.voting_revision or showtime_revision <
-- showtimes.revision, and do not count when the showtime is removed.
--
-- Individual picks are private to Dino. Members get no access to this table
-- at all (no grant, no policy); their own picks and the aggregate counts
-- come through narrow read paths in the voting workflow migration.
--
-- The showtime key does not cascade: a showtime that has picks cannot be
-- hard-deleted on its own (soft-remove it instead). It is DEFERRABLE
-- INITIALLY DEFERRED so that deleting the whole event still works: the
-- check runs at commit, after the event's cascade has also removed these
-- rows through the participant key. (Checked immediately, it fires before
-- that cascade and blocks Delete Event.)
create table public.showtime_availability (
  event_id           uuid        not null,
  showtime_id        uuid        not null,
  participant_id     uuid        not null,
  is_available       boolean     not null,
  voting_revision    integer     not null,
  showtime_revision  integer     not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (showtime_id, participant_id),
  constraint showtime_availability_showtime_fkey
    foreign key (showtime_id, event_id) references public.showtimes (id, event_id)
    deferrable initially deferred,
  constraint showtime_availability_participant_fkey
    foreign key (participant_id, event_id) references public.event_participants (id, event_id) on delete cascade,
  constraint showtime_availability_revisions_check
    check (voting_revision >= 1 and showtime_revision >= 1)
);

create index showtime_availability_participant_idx on public.showtime_availability (participant_id);
create index showtime_availability_event_id_idx on public.showtime_availability (event_id);

-- ---------------------------------------------------------------------------
-- 6. Predictions and ratings
-- ---------------------------------------------------------------------------

-- A prediction survives its author becoming not-attending; is_active marks
-- whether it still counts. Historical stats additionally filter on the
-- participant's check-in. Other people's scores are never readable through
-- these tables; reveal goes through a later, rule-enforcing read path.
--
-- Precision: numeric(3,1) ROUNDS its input on cast (7.25 -> 7.3, 9.96 ->
-- 10.0) before any CHECK sees it, so the CHECK below cannot reject extra
-- decimals. The write functions that come later must validate the RAW input
-- first: in [0, 10] and already exact at one decimal place, i.e.
-- raw = round(raw, 1) on the uncast value (7, 7.0, 7.5 pass; 7.25 fails).
-- Reject otherwise, and only then cast and store. There is no direct table
-- write path for members.
create table public.predictions (
  participant_id  uuid          primary key,
  event_id        uuid          not null,
  score           numeric(3, 1) not null,
  is_active       boolean       not null default true,
  submitted_at    timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  constraint predictions_participant_fkey
    foreign key (participant_id, event_id) references public.event_participants (id, event_id) on delete cascade,
  constraint predictions_score_check
    check (score between 0.0 and 10.0)
);

create index predictions_event_id_idx on public.predictions (event_id);

create table public.ratings (
  participant_id  uuid          primary key,
  event_id        uuid          not null,
  score           numeric(3, 1) not null,
  submitted_at    timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  constraint ratings_participant_fkey
    foreign key (participant_id, event_id) references public.event_participants (id, event_id) on delete cascade,
  constraint ratings_score_check
    check (score between 0.0 and 10.0)
);

create index ratings_event_id_idx on public.ratings (event_id);

comment on column public.predictions.score is
  '0.0-10.0. numeric(3,1) rounds on cast: writers must reject raw input that '
  'is not already exact at one decimal place before storing.';
comment on column public.ratings.score is
  '0.0-10.0. numeric(3,1) rounds on cast: writers must reject raw input that '
  'is not already exact at one decimal place before storing.';

-- ---------------------------------------------------------------------------
-- 7. Charges
-- ---------------------------------------------------------------------------

-- One charge per participant, guests included. Charges cascade with their
-- participant, and so with their event: Delete Event removes payment history
-- from the app along with everything else. Nothing but the owner-only
-- delete workflow will ever delete participants or events.
create table public.charges (
  id                        uuid        primary key default gen_random_uuid(),
  event_id                  uuid        not null,
  participant_id            uuid        not null,
  amount_cents              integer     not null,
  status                    text        not null default 'unpaid',
  paid_at                   timestamptz,
  marked_paid_by_member_id  uuid        references public.members (id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint charges_participant_fkey
    foreign key (participant_id, event_id) references public.event_participants (id, event_id) on delete cascade,
  constraint charges_amount_check
    check (amount_cents >= 0),
  constraint charges_status_check
    check (status in ('unpaid', 'paid')),
  constraint charges_paid_at_check
    check ((status = 'paid') = (paid_at is not null)),
  constraint charges_marked_paid_by_check
    check (marked_paid_by_member_id is null or status = 'paid'),
  constraint charges_participant_key unique (participant_id)
);

create index charges_event_id_idx on public.charges (event_id);

-- ---------------------------------------------------------------------------
-- 8. Event media
-- ---------------------------------------------------------------------------

-- Metadata only; the files will live in a private Storage bucket created by
-- a later migration. Video rows are allowed but nothing processes them.
create table public.event_media (
  id                   uuid        primary key default gen_random_uuid(),
  event_id             uuid        not null references public.events (id) on delete cascade,
  uploader_member_id   uuid        not null references public.members (id) on delete restrict,
  media_type           text        not null,
  storage_path         text        not null,
  mime_type            text        not null,
  byte_size            bigint,
  width                integer,
  height               integer,
  duration_seconds     numeric(8, 2),
  caption              text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint event_media_type_check
    check (media_type in ('photo', 'video')),
  constraint event_media_mime_check
    check ((media_type = 'photo' and mime_type like 'image/%')
        or (media_type = 'video' and mime_type like 'video/%')),
  constraint event_media_storage_path_check
    check (storage_path <> '' and storage_path !~ '^/'),
  constraint event_media_byte_size_check
    check (byte_size > 0),
  constraint event_media_dimensions_check
    check (width > 0 and height > 0),
  constraint event_media_duration_nonnegative_check
    check (duration_seconds >= 0),
  constraint event_media_duration_check
    check (duration_seconds is null or media_type = 'video'),
  constraint event_media_caption_check
    check (char_length(caption) <= 500),
  constraint event_media_storage_path_key unique (storage_path)
);

create index event_media_event_created_idx on public.event_media (event_id, created_at);
create index event_media_uploader_idx on public.event_media (uploader_member_id);

-- ---------------------------------------------------------------------------
-- 9. App settings
-- ---------------------------------------------------------------------------

-- Single row (id is always true). Holds where members send money; payment
-- destinations do not live on member rows. No row is inserted here.
create table public.app_settings (
  id                    boolean     primary key default true,
  venmo_username        text,
  apple_cash_recipient  text,
  payment_note          text,
  updated_by_member_id  uuid        references public.members (id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint app_settings_singleton_check
    check (id),
  constraint app_settings_venmo_check
    check (venmo_username ~ '^[A-Za-z0-9_-]{1,30}$'),
  constraint app_settings_apple_cash_check
    check (apple_cash_recipient <> ''),
  constraint app_settings_payment_note_check
    check (char_length(payment_note) <= 280)
);

-- ---------------------------------------------------------------------------
-- 10. Notifications
-- ---------------------------------------------------------------------------

-- The in-app inbox. Rows are written only server-side; members can read
-- their own and mark them read.
create table public.notifications (
  id                   uuid        primary key default gen_random_uuid(),
  recipient_member_id  uuid        not null references public.members (id) on delete cascade,
  event_id             uuid        references public.events (id) on delete cascade,
  kind                 text        not null,
  title                text        not null,
  body                 text,
  data                 jsonb       not null default '{}'::jsonb,
  dedupe_key           text,
  created_at           timestamptz not null default now(),
  read_at              timestamptz,
  constraint notifications_kind_check
    check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint notifications_title_check
    check (title <> ''),
  constraint notifications_data_check
    check (jsonb_typeof(data) = 'object'),
  constraint notifications_dedupe_key unique (recipient_member_id, dedupe_key)
);

create index notifications_recipient_created_idx
  on public.notifications (recipient_member_id, created_at desc);
create index notifications_event_id_idx on public.notifications (event_id)
  where event_id is not null;

-- Push tokens. Never readable by API roles.
create table private.push_devices (
  id               uuid        primary key default gen_random_uuid(),
  member_id        uuid        not null references public.members (id) on delete cascade,
  push_token       text        not null,
  platform         text        not null,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  disabled_at      timestamptz,
  disabled_reason  text,
  constraint push_devices_platform_check
    check (platform in ('ios', 'android')),
  constraint push_devices_token_check
    check (push_token <> ''),
  constraint push_devices_disabled_reason_check
    check (disabled_reason is null or disabled_at is not null),
  constraint push_devices_token_key unique (push_token)
);

create index push_devices_member_id_idx on private.push_devices (member_id);

-- One delivery attempt record per notification per device.
create table private.notification_deliveries (
  id                  uuid        primary key default gen_random_uuid(),
  notification_id     uuid        not null references public.notifications (id) on delete cascade,
  push_device_id      uuid        not null references private.push_devices (id) on delete cascade,
  status              text        not null default 'queued',
  attempt_count       integer     not null default 0,
  provider_ticket_id  text,
  last_error          text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  updated_at          timestamptz not null default now(),
  constraint notification_deliveries_status_check
    check (status in ('queued', 'sent', 'failed', 'skipped')),
  constraint notification_deliveries_attempt_count_check
    check (attempt_count >= 0),
  constraint notification_deliveries_sent_at_check
    check ((status = 'sent') = (sent_at is not null)),
  constraint notification_deliveries_device_key unique (notification_id, push_device_id)
);

create index notification_deliveries_device_idx on private.notification_deliveries (push_device_id);
create index notification_deliveries_queued_idx on private.notification_deliveries (created_at)
  where status = 'queued';

-- Server-side policy per notification kind: whether it pushes, and caps.
create table private.notification_policy (
  kind                    text        primary key,
  send_push               boolean     not null default true,
  max_per_member_per_day  integer,
  updated_at              timestamptz not null default now(),
  constraint notification_policy_kind_check
    check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint notification_policy_cap_check
    check (max_per_member_per_day > 0)
);

-- Append-only record of privileged actions. No foreign keys, so history
-- survives the rows it describes.
create table private.audit_log (
  id                 bigint      generated always as identity primary key,
  occurred_at        timestamptz not null default now(),
  actor_member_id    uuid,
  actor_auth_user_id uuid,
  action             text        not null,
  target_table       text,
  target_id          text,
  details            jsonb       not null default '{}'::jsonb,
  constraint audit_log_action_check
    check (action <> ''),
  constraint audit_log_details_check
    check (jsonb_typeof(details) = 'object')
);

create index audit_log_occurred_at_idx on private.audit_log (occurred_at);

-- ---------------------------------------------------------------------------
-- 11. updated_at triggers
-- ---------------------------------------------------------------------------

create trigger set_updated_at before update on public.members
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.movies
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.theaters
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.events
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.showtimes
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.guests
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.event_participants
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.showtime_availability
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.predictions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.ratings
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.charges
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.event_media
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.app_settings
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.rate_limits
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.notification_deliveries
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on private.notification_policy
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 12. Identity helpers for RLS
-- ---------------------------------------------------------------------------

-- The caller's member id, or null if they have no live claim or their member
-- row is not active. SECURITY DEFINER because it must read
-- private.auth_claims, which the caller cannot. It returns only the caller's
-- own id and takes no arguments, so it cannot be used to probe other rows.
create function private.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.member_id
  from private.auth_claims c
  join public.members m on m.id = c.member_id
  where c.auth_user_id = auth.uid()
    and c.revoked_at is null
    and m.status = 'active'
$$;

-- The caller's member id if they are the active owner, otherwise null.
create function private.current_owner_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.members m
  where m.id = private.current_member_id()
    and m.role = 'owner'
$$;

-- Whether the caller has answered the RSVP for this event (any answer,
-- cant_go included). Gates seeing other people's RSVPs. SECURITY DEFINER
-- because the event_participants policy that calls it would otherwise
-- recurse into itself. It only ever reports on the caller's own row.
create function private.current_member_has_rsvped(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.event_participants p
    where p.event_id = p_event_id
      and p.member_id = private.current_member_id()
      and p.rsvp_status is not null
  )
$$;

revoke all on function private.current_member_id() from public, anon, authenticated, service_role;
revoke all on function private.current_owner_id() from public, anon, authenticated, service_role;
revoke all on function private.current_member_has_rsvped(uuid) from public, anon, authenticated, service_role;

-- RLS policies run as the caller, so authenticated needs USAGE on private
-- and EXECUTE on exactly these helpers. This grants nothing on private
-- tables, and private is not exposed through the Data API.
grant usage on schema private to authenticated;
grant execute on function private.current_member_id() to authenticated;
grant execute on function private.current_owner_id() to authenticated;
grant execute on function private.current_member_has_rsvped(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. Row level security
-- ---------------------------------------------------------------------------

alter table public.members               enable row level security;
alter table public.movies                enable row level security;
alter table public.theaters              enable row level security;
alter table public.events                enable row level security;
alter table public.showtimes             enable row level security;
alter table public.guests                enable row level security;
alter table public.event_participants    enable row level security;
alter table public.showtime_availability enable row level security;
alter table public.predictions           enable row level security;
alter table public.ratings               enable row level security;
alter table public.charges               enable row level security;
alter table public.event_media           enable row level security;
alter table public.app_settings          enable row level security;
alter table public.notifications         enable row level security;

-- Private tables: RLS on with no policies, as defence in depth behind the
-- missing grants.
alter table private.member_invites          enable row level security;
alter table private.auth_claims             enable row level security;
alter table private.rate_limits             enable row level security;
alter table private.push_devices            enable row level security;
alter table private.notification_deliveries enable row level security;
alter table private.notification_policy     enable row level security;
alter table private.audit_log               enable row level security;

-- ---------------------------------------------------------------------------
-- 14. Grants
-- ---------------------------------------------------------------------------

-- Start from nothing on every table this migration creates, whatever the
-- platform defaults are, then add back exactly what members need.
revoke all on table
  public.members, public.movies, public.theaters, public.events,
  public.showtimes, public.guests, public.event_participants,
  public.showtime_availability, public.predictions, public.ratings,
  public.charges, public.event_media, public.app_settings,
  public.notifications
from public, anon, authenticated, service_role;

revoke all on table
  private.member_invites, private.auth_claims, private.rate_limits,
  private.push_devices, private.notification_deliveries,
  private.notification_policy, private.audit_log
from public, anon, authenticated, service_role;

revoke all on sequence private.audit_log_id_seq
from public, anon, authenticated, service_role;

-- Read access for signed-in members. Rows are still filtered by RLS.
-- Deliberately absent:
--   event_participants     column-scoped below
--   showtime_availability  individual picks are Dino-only; no member access
grant select on table
  public.members, public.movies, public.theaters, public.events,
  public.showtimes, public.guests, public.predictions, public.ratings,
  public.charges, public.event_media, public.app_settings,
  public.notifications
to authenticated;

-- The roster. RLS decides which rows (see its policy); this decides which
-- columns: who, and their answers. Change timestamps and check-in
-- bookkeeping stay server-side. A security_invoker view would add nothing
-- here: it can only show columns and rows the caller could already read raw.
grant select (id, event_id, member_id, guest_id, rsvp_status, confirmation_status, checked_in_at)
  on table public.event_participants to authenticated;

-- The only member write path in this migration: marking your own
-- notifications read. Members have NO write access to public.members; names,
-- roles, and status are Dino's, via a later workflow migration.
grant update (read_at) on table public.notifications to authenticated;

-- ---------------------------------------------------------------------------
-- 15. Policies
-- ---------------------------------------------------------------------------

-- Shared reference and event data: any active member.
create policy "active members read members" on public.members
  for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "active members read movies" on public.movies
  for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "active members read theaters" on public.theaters
  for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "active members read events" on public.events
  for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "active members read showtimes" on public.showtimes
  for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "active members read guests" on public.guests
  for select to authenticated
  using ((select private.current_member_id()) is not null);

-- RSVP privacy. A participant row is visible to:
--   - Dino: every row, every state.
--   - its own member.
--   - the host of a guest row, whatever the guest answered (the host
--     answers for them).
--   - any other active member only if the row is going or maybe AND the
--     viewer has answered this event's RSVP themselves. cant_go and
--     unanswered rows are never visible to ordinary members.
-- Other tables' policies that join event_participants inherit this.
create policy "read participants per rsvp privacy" on public.event_participants
  for select to authenticated
  using (
    (select private.current_owner_id()) is not null
    or member_id = (select private.current_member_id())
    or exists (
      select 1
      from public.guests g
      where g.id = event_participants.guest_id
        and g.host_member_id = (select private.current_member_id())
    )
    or (
      rsvp_status in ('going', 'maybe')
      and private.current_member_has_rsvped(event_id)
    )
  );

-- public.showtime_availability: RLS on, no policies, no grants. Nothing for
-- members to read here; see the table comment.

create policy "active members read media" on public.event_media
  for select to authenticated
  using ((select private.current_member_id()) is not null);

create policy "active members read app settings" on public.app_settings
  for select to authenticated
  using ((select private.current_member_id()) is not null);

-- Scores: only your own rows and your guests'. The owner gets no exception:
-- Dino predicts too, so an owner read here would break blinding for him.
-- Reveal after the event goes through a later, rule-enforcing read path.
create policy "read own or hosted predictions" on public.predictions
  for select to authenticated
  using (
    exists (
      select 1
      from public.event_participants p
      left join public.guests g on g.id = p.guest_id
      where p.id = predictions.participant_id
        and (p.member_id = (select private.current_member_id())
             or g.host_member_id = (select private.current_member_id()))
    )
  );

create policy "read own or hosted ratings" on public.ratings
  for select to authenticated
  using (
    exists (
      select 1
      from public.event_participants p
      left join public.guests g on g.id = p.guest_id
      where p.id = ratings.participant_id
        and (p.member_id = (select private.current_member_id())
             or g.host_member_id = (select private.current_member_id()))
    )
  );

-- Money: your own rows and your guests', or the owner, who reconciles
-- payments.
create policy "read own or hosted charges" on public.charges
  for select to authenticated
  using (
    (select private.current_owner_id()) is not null
    or exists (
      select 1
      from public.event_participants p
      left join public.guests g on g.id = p.guest_id
      where p.id = charges.participant_id
        and (p.member_id = (select private.current_member_id())
             or g.host_member_id = (select private.current_member_id()))
    )
  );

create policy "read own notifications" on public.notifications
  for select to authenticated
  using (recipient_member_id = (select private.current_member_id()));

create policy "mark own notifications read" on public.notifications
  for update to authenticated
  using (recipient_member_id = (select private.current_member_id()))
  with check (recipient_member_id = (select private.current_member_id()));
