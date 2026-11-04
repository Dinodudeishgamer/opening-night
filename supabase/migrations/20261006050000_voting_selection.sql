-- Opening Night v3 — showtimes, availability voting, and selecting the winner.
--
-- Voting runs alongside RSVP: as soon as Dino has posted showtimes, everyone
-- who is Going or Maybe (guests through their host) marks EVERY showtime that
-- works. Not ranked. Submitting with nothing ticked means "none work" and
-- counts as having voted.
--
-- A ballot records that a participant has answered, and under which
-- voting_revision. It is current only when
--   ballot.voting_revision = events.voting_revision and invalidated_at is null
--   - adding or editing a showtime bumps events.voting_revision: every
--     ballot is stale and everyone re-reviews
--   - removing a showtime invalidates only the ballots that had picked it
--   - someone who becomes Going/Maybe later simply has no ballot yet
--
-- Voting closes
--   - when Dino closes it (he can reopen until a showtime is selected), or
--   - automatically, only when RSVP is locked AND every eligible participant
--     holds a current ballot. Never while RSVP is still open.
--
-- Individual picks stay private: showtime_availability and showtime_ballots
-- have no grants and no policies. Members read their own picks and the
-- aggregate counts through get_voting; Dino reads the full matrix there.
--
-- Selecting a showtime is one transaction: it closes RSVP, closes voting,
-- sets the schedule and the confirmation deadline, leaves every Going/Maybe
-- participant pending confirmation, notifies them, and writes the audit row.
--
--   authenticated (Dino)    add_showtime, update_showtime, remove_showtime,
--                           close_voting, reopen_voting, select_showtime
--   authenticated (member)  submit_ballot (self or own guest; Dino for
--                           anyone, audited), get_voting

create table public.showtime_ballots (
  participant_id          uuid        primary key,
  event_id                uuid        not null,
  voting_revision         integer     not null,
  submitted_at            timestamptz not null default clock_timestamp(),
  submitted_by_member_id  uuid        references public.members (id) on delete restrict,
  invalidated_at          timestamptz,
  constraint showtime_ballots_participant_fkey
    foreign key (participant_id, event_id) references public.event_participants (id, event_id) on delete cascade,
  constraint showtime_ballots_revision_check check (voting_revision >= 1)
);

create index showtime_ballots_event_id_idx on public.showtime_ballots (event_id);

alter table public.showtime_ballots enable row level security;
revoke all on table public.showtime_ballots from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Derived state
-- ---------------------------------------------------------------------------

-- Voting is open to members while there is something to vote on and nothing
-- has closed it.
create function private.voting_open(p_event public.events)
returns boolean language sql stable set search_path = '' as $$
  select p_event.selected_showtime_id is null and p_event.voting_closed_at is null and p_event.ended_at is null
     and exists (select 1 from public.showtimes s where s.event_id = p_event.id and s.removed_at is null)
$$;

-- Eligible voters with no current ballot.
create function private.voters_outstanding(p_event_id uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::integer
  from public.event_participants p
  join public.events e on e.id = p.event_id
  left join public.showtime_ballots b
    on b.participant_id = p.id and b.voting_revision = e.voting_revision and b.invalidated_at is null
  where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe') and b.participant_id is null
$$;

-- The automatic close. Runs after every RSVP, guest, and ballot change and
-- from the scheduled tick (which is how a passing RSVP deadline is noticed).
-- After Dino reopens voting it waits for at least one new ballot, so a reopen
-- is not undone before anyone has had the chance to change their answer.
create or replace function private.event_changed(p_event_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_event public.events%rowtype;
begin
  select * into v_event from public.events e where e.id = p_event_id for update;
  if not found or not private.voting_open(v_event) then
    return;
  end if;
  if now() < v_event.rsvp_deadline then
    return;
  end if;
  if not exists (
    select 1 from public.event_participants p
    where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe')
  ) or private.voters_outstanding(p_event_id) > 0 then
    return;
  end if;
  if v_event.voting_reopened_at is not null and not exists (
    select 1 from public.showtime_ballots b
    where b.event_id = p_event_id and b.submitted_at > v_event.voting_reopened_at
  ) then
    return;
  end if;

  update public.events e set voting_closed_at = now() where e.id = p_event_id;
  perform private.write_audit('voting.closed_automatically', 'public.events', p_event_id);
  perform private.notify(m.id, p_event_id, 'voting_complete', 'Everyone has voted',
                         'Voting is closed. Pick the showtime.', jsonb_build_object('event_id', p_event_id),
                         'voting_complete:' || p_event_id || ':' || v_event.voting_revision)
  from public.members m where m.role = 'owner';
end;
$$;

revoke all on function private.voting_open(public.events) from public, anon, authenticated, service_role;
revoke all on function private.voters_outstanding(uuid) from public, anon, authenticated, service_role;
revoke all on function private.event_changed(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Showtimes (Dino)
-- ---------------------------------------------------------------------------

create function private.check_showtime_fields(p_theater_id uuid, p_starts_at timestamptz, p_format text, p_format_other text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from public.theaters t where t.id = p_theater_id) then
    raise exception 'Pick a theater.' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'A showtime needs a date and time.' using errcode = '22023';
  end if;
  if p_format is null or p_format not in ('standard', 'imax', 'xd', 'dolby', '3d', 'other') then
    raise exception 'Format is Standard, IMAX, XD, Dolby, 3D, or Other.' using errcode = '22023';
  end if;
  if p_format = 'other' and coalesce(btrim(p_format_other), '') = '' then
    raise exception 'Say what the other format is.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.check_showtime_fields(uuid, timestamptz, text, text) from public, anon, authenticated, service_role;

-- Showtimes are added while voting is open. After a selection the slate is
-- history; a new time goes through reschedule_event instead.
create function private.add_showtime_impl(
  p_event_id uuid, p_theater_id uuid, p_starts_at timestamptz, p_format text default 'standard', p_format_other text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_id    uuid;
  v_first boolean;
begin
  perform private.check_showtime_fields(p_theater_id, p_starts_at, p_format, p_format_other);
  if v_event.selected_showtime_id is not null then
    raise exception 'A showtime is already selected. Reschedule instead.' using errcode = 'P0001';
  end if;
  if v_event.voting_closed_at is not null then
    raise exception 'Voting is closed. Reopen it to change the showtimes.' using errcode = 'P0001';
  end if;
  if p_starts_at <= now() then
    raise exception 'That showtime is in the past.' using errcode = '22023';
  end if;
  v_first := not exists (select 1 from public.showtimes s where s.event_id = p_event_id);

  insert into public.showtimes (event_id, theater_id, starts_at, format, format_other)
  values (p_event_id, p_theater_id, p_starts_at, p_format, case when p_format = 'other' then btrim(p_format_other) end)
  returning id into v_id;
  -- The very first showtime opens voting under revision 1; every later
  -- change to the slate makes earlier ballots stale.
  if not v_first then
    update public.events e set voting_revision = e.voting_revision + 1 where e.id = p_event_id;
  end if;
  return v_id;
end;
$$;

-- Before a selection: edits the slot and makes every ballot stale. After a
-- selection: only the selected showtime can be corrected, and only its
-- theater or format. That does not reset confirmations. A different time is a
-- reschedule.
create function private.update_showtime_impl(
  p_showtime_id uuid, p_theater_id uuid, p_starts_at timestamptz, p_format text, p_format_other text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner    uuid := private.require_owner();
  v_showtime public.showtimes%rowtype;
  v_event    public.events%rowtype;
begin
  select * into v_showtime from public.showtimes s where s.id = p_showtime_id;
  if not found or v_showtime.removed_at is not null then
    raise exception 'That showtime no longer exists.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_showtime.event_id);
  perform private.check_showtime_fields(p_theater_id, p_starts_at, p_format, p_format_other);
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;

  if v_event.selected_showtime_id is not null then
    if v_event.selected_showtime_id <> p_showtime_id then
      raise exception 'Only the selected showtime can be corrected now.' using errcode = 'P0001';
    end if;
    if p_starts_at <> v_showtime.starts_at then
      raise exception 'Changing the date or time is a reschedule.' using errcode = 'P0001';
    end if;
    update public.events e set schedule_revision = e.schedule_revision + 1 where e.id = v_event.id;
    perform private.write_audit('showtime.corrected', 'public.showtimes', p_showtime_id,
      jsonb_build_object('event_id', v_event.id));
  else
    if v_event.voting_closed_at is not null then
      raise exception 'Voting is closed. Reopen it to change the showtimes.' using errcode = 'P0001';
    end if;
    update public.events e set voting_revision = e.voting_revision + 1 where e.id = v_event.id;
  end if;

  update public.showtimes s
  set theater_id = p_theater_id, starts_at = p_starts_at, format = p_format,
      format_other = case when p_format = 'other' then btrim(p_format_other) end,
      revision = s.revision + 1
  where s.id = p_showtime_id;
end;
$$;

-- Soft removal. Only the people who had picked this showtime are asked to
-- vote again; everyone else's ballot stands.
create function private.remove_showtime_impl(p_showtime_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner    uuid := private.require_owner();
  v_showtime public.showtimes%rowtype;
  v_event    public.events%rowtype;
begin
  select * into v_showtime from public.showtimes s where s.id = p_showtime_id;
  if not found or v_showtime.removed_at is not null then
    raise exception 'That showtime no longer exists.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_showtime.event_id);
  if v_event.selected_showtime_id is not null then
    raise exception 'A showtime is already selected.' using errcode = 'P0001';
  end if;
  if v_event.voting_closed_at is not null then
    raise exception 'Voting is closed. Reopen it to change the showtimes.' using errcode = 'P0001';
  end if;

  update public.showtimes s set removed_at = now(), removed_by_member_id = v_owner where s.id = p_showtime_id;
  update public.showtime_ballots b
  set invalidated_at = now()
  where b.event_id = v_event.id and b.invalidated_at is null
    and exists (select 1 from public.showtime_availability a
                where a.showtime_id = p_showtime_id and a.participant_id = b.participant_id and a.is_available);
  perform private.event_changed(v_event.id);
end;
$$;

create function private.close_voting_impl(p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
begin
  if v_event.selected_showtime_id is not null or v_event.voting_closed_at is not null then
    return;
  end if;
  update public.events e set voting_closed_at = now() where e.id = p_event_id;
  perform private.write_audit('voting.closed', 'public.events', p_event_id,
    jsonb_build_object('outstanding', private.voters_outstanding(p_event_id)));
end;
$$;

create function private.reopen_voting_impl(p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
begin
  if v_event.selected_showtime_id is not null then
    raise exception 'A showtime is already selected.' using errcode = 'P0001';
  end if;
  if v_event.voting_closed_at is null then
    return;
  end if;
  update public.events e set voting_closed_at = null, voting_reopened_at = clock_timestamp() where e.id = p_event_id;
  perform private.write_audit('voting.reopened', 'public.events', p_event_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Ballots
-- ---------------------------------------------------------------------------

-- Replaces the participant's whole answer: the listed showtimes work, every
-- other active one does not. An empty list is a valid answer.
--   the participant's own member, or the host of a guest: while voting is open
--   Dino, for anyone: until a showtime is selected, audited
create function private.submit_ballot_impl(p_participant_id uuid, p_showtime_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_member();
  v_part   public.event_participants%rowtype;
  v_event  public.events%rowtype;
  v_ids    uuid[] := coalesce(p_showtime_ids, '{}');
  v_mine   boolean;
begin
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found then
    raise exception 'That person is not on this event.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_part.event_id);
  v_mine := v_part.member_id is not distinct from v_me or exists (
    select 1 from public.guests g where g.id = v_part.guest_id and g.host_member_id = v_me);

  if not v_mine then
    perform private.require_owner();
  end if;
  if v_part.rsvp_status is null or v_part.rsvp_status not in ('going', 'maybe') then
    raise exception 'Only Going and Maybe vote on showtimes.' using errcode = 'P0001';
  end if;
  if v_event.selected_showtime_id is not null then
    raise exception 'The showtime has been selected.' using errcode = 'P0001';
  end if;
  if private.current_owner_id() is null and not private.voting_open(v_event) then
    raise exception 'Voting is closed.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(v_ids) as x(id)
    where not exists (select 1 from public.showtimes s
                      where s.id = x.id and s.event_id = v_event.id and s.removed_at is null)
  ) then
    raise exception 'The showtimes changed. Review them and vote again.' using errcode = 'P0001';
  end if;

  insert into public.showtime_availability as a
    (event_id, showtime_id, participant_id, is_available, voting_revision, showtime_revision)
  select v_event.id, s.id, p_participant_id, s.id = any (v_ids), v_event.voting_revision, s.revision
  from public.showtimes s
  where s.event_id = v_event.id and s.removed_at is null
  on conflict (showtime_id, participant_id) do update
    set is_available = excluded.is_available, voting_revision = excluded.voting_revision,
        showtime_revision = excluded.showtime_revision;

  insert into public.showtime_ballots as b (participant_id, event_id, voting_revision, submitted_at, submitted_by_member_id, invalidated_at)
  values (p_participant_id, v_event.id, v_event.voting_revision, clock_timestamp(), v_me, null)
  on conflict (participant_id) do update
    set voting_revision = excluded.voting_revision, submitted_at = excluded.submitted_at,
        submitted_by_member_id = excluded.submitted_by_member_id, invalidated_at = null;

  if not v_mine then
    perform private.write_audit('ballot.entered_by_owner', 'public.showtime_ballots', p_participant_id,
      jsonb_build_object('event_id', v_event.id, 'showtime_ids', to_jsonb(v_ids)));
  end if;
  perform private.event_changed(v_event.id);
end;
$$;

-- Everything the event page needs about voting, shaped by who is asking:
--   counts   per active showtime, how many current ballots of eligible
--            participants say it works. Aggregates only.
--   mine     the caller's own participant and their guests: whether each has
--            a current ballot, and what it says.
--   matrix   Dino only: the same, for everyone.
create function private.get_voting_impl(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_owner boolean := private.current_owner_id() is not null;
  v_event public.events%rowtype;
  v_rows  jsonb;
begin
  select * into v_event from public.events e where e.id = p_event_id;
  if not found then
    raise exception 'That event no longer exists.' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'participant_id', p.id,
           'member_id', p.member_id,
           'guest_id', p.guest_id,
           'is_mine', p.member_id is not distinct from v_me or g.host_member_id is not distinct from v_me,
           'current', b.participant_id is not null,
           'showtime_ids', case when b.participant_id is null then '[]'::jsonb else coalesce((
               select jsonb_agg(a.showtime_id)
               from public.showtime_availability a
               join public.showtimes s on s.id = a.showtime_id and s.removed_at is null
               where a.participant_id = p.id and a.is_available), '[]'::jsonb) end)
         order by p.created_at, p.id), '[]'::jsonb)
    into v_rows
  from public.event_participants p
  left join public.guests g on g.id = p.guest_id
  left join public.showtime_ballots b
    on b.participant_id = p.id and b.voting_revision = v_event.voting_revision and b.invalidated_at is null
  where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe');

  return jsonb_build_object(
    'voting_revision', v_event.voting_revision,
    'open', private.voting_open(v_event),
    'closed_at', v_event.voting_closed_at,
    'eligible', jsonb_array_length(v_rows),
    'voted', (select count(*) from jsonb_array_elements(v_rows) r where (r ->> 'current')::boolean),
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'showtime_id', s.id,
               'available', (select count(*) from jsonb_array_elements(v_rows) r
                             where (r ->> 'current')::boolean and r -> 'showtime_ids' @> to_jsonb(s.id)))
             order by s.starts_at, s.id)
      from public.showtimes s where s.event_id = p_event_id and s.removed_at is null), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(r - 'is_mine') from jsonb_array_elements(v_rows) r where (r ->> 'is_mine')::boolean), '[]'::jsonb),
    'matrix', case when v_owner then (select coalesce(jsonb_agg(r - 'is_mine'), '[]'::jsonb) from jsonb_array_elements(v_rows) r) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Selecting the showtime
-- ---------------------------------------------------------------------------

-- Dino picks the winner (ties are his to break; nothing here looks at the
-- counts). One transaction:
--   - RSVP closes now if it was still open, and everyone unanswered becomes
--     Can't Go
--   - voting closes
--   - the event gets its schedule: selected_showtime_id, schedule_revision 1
--   - the confirmation deadline is set
--   - every Going/Maybe participant is pending confirmation (their
--     confirmation_status is cleared)
--   - they are notified (hosts for their guests)
--   - audited
create function private.select_showtime_impl(p_event_id uuid, p_showtime_id uuid, p_confirmation_deadline timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner    uuid := private.require_owner();
  v_event    public.events%rowtype := private.lock_event(p_event_id);
  v_showtime public.showtimes%rowtype;
begin
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if v_event.selected_showtime_id is not null then
    raise exception 'A showtime is already selected. Reschedule instead.' using errcode = 'P0001';
  end if;
  select * into v_showtime from public.showtimes s
  where s.id = p_showtime_id and s.event_id = p_event_id and s.removed_at is null;
  if not found then
    raise exception 'That showtime is not on this event.' using errcode = 'P0002';
  end if;
  if p_confirmation_deadline is null or p_confirmation_deadline <= now() or p_confirmation_deadline > v_showtime.starts_at then
    raise exception 'The confirmation deadline must be between now and the showtime.' using errcode = '22023';
  end if;

  update public.events e
  set rsvp_deadline = least(e.rsvp_deadline, now()),
      voting_closed_at = coalesce(e.voting_closed_at, now()),
      selected_showtime_id = p_showtime_id,
      showtime_selected_at = now(),
      confirmation_deadline = p_confirmation_deadline,
      schedule_revision = e.schedule_revision + 1
  where e.id = p_event_id;

  perform private.settle_rsvp(p_event_id);

  update public.event_participants p
  set confirmation_status = null, confirmation_updated_at = null
  where p.event_id = p_event_id and p.confirmation_status is not null;

  perform private.notify(x.member_id, p_event_id, 'showtime_selected', 'Showtime picked',
                         'Confirm whether you can make it.',
                         jsonb_build_object('event_id', p_event_id),
                         'showtime_selected:' || p_event_id || ':' || (v_event.schedule_revision + 1))
  from (
    select distinct coalesce(p.member_id, g.host_member_id) as member_id
    from public.event_participants p
    left join public.guests g on g.id = p.guest_id
    where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe')
  ) x;

  perform private.write_audit('showtime.selected', 'public.events', p_event_id,
    jsonb_build_object('showtime_id', p_showtime_id, 'starts_at', v_showtime.starts_at,
                       'confirmation_deadline', p_confirmation_deadline,
                       'rsvp_closed_early', v_event.rsvp_deadline > now(),
                       'voters_outstanding', private.voters_outstanding(p_event_id)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Public RPCs and grants
-- ---------------------------------------------------------------------------

create function public.add_showtime(p_event_id uuid, p_theater_id uuid, p_starts_at timestamptz, p_format text default 'standard', p_format_other text default null)
returns uuid language sql security invoker set search_path = ''
as $$ select private.add_showtime_impl(p_event_id, p_theater_id, p_starts_at, p_format, p_format_other) $$;

create function public.update_showtime(p_showtime_id uuid, p_theater_id uuid, p_starts_at timestamptz, p_format text, p_format_other text default null)
returns void language sql security invoker set search_path = ''
as $$ select private.update_showtime_impl(p_showtime_id, p_theater_id, p_starts_at, p_format, p_format_other) $$;

create function public.remove_showtime(p_showtime_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.remove_showtime_impl(p_showtime_id) $$;

create function public.close_voting(p_event_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.close_voting_impl(p_event_id) $$;

create function public.reopen_voting(p_event_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.reopen_voting_impl(p_event_id) $$;

create function public.submit_ballot(p_participant_id uuid, p_showtime_ids uuid[])
returns void language sql security invoker set search_path = ''
as $$ select private.submit_ballot_impl(p_participant_id, p_showtime_ids) $$;

create function public.get_voting(p_event_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_voting_impl(p_event_id) $$;

create function public.select_showtime(p_event_id uuid, p_showtime_id uuid, p_confirmation_deadline timestamptz)
returns void language sql security invoker set search_path = ''
as $$ select private.select_showtime_impl(p_event_id, p_showtime_id, p_confirmation_deadline) $$;

select private.grant_rpc('add_showtime', 'authenticated');
select private.grant_rpc('update_showtime', 'authenticated');
select private.grant_rpc('remove_showtime', 'authenticated');
select private.grant_rpc('close_voting', 'authenticated');
select private.grant_rpc('reopen_voting', 'authenticated');
select private.grant_rpc('submit_ballot', 'authenticated');
select private.grant_rpc('get_voting', 'authenticated');
select private.grant_rpc('select_showtime', 'authenticated');
