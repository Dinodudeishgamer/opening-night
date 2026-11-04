-- Opening Night v3 — predictions, check-in, ending the night, ratings, Past.
--
-- Predictions   0.0-10.0, one decimal. Only a confirmed participant predicts
--               (a guest's is entered by the host). Submitting locks it:
--               members cannot edit or delete. Nobody sees anyone else's
--               until they have submitted their own; from then on the
--               group's predictions are visible to them. Dino uses the same
--               screens and the same blinding; his correction function is
--               separate and audited.
-- Check-in      Dino only, at the theater. Checking someone in may record
--               their missing prediction in the same transaction. Walk-ins
--               are added and checked in by Dino in one step. Check-in is
--               what unlocks rating and photos.
-- Ending        Dino ends the night by hand (end_event). 48 hours later it is
--               Past; nothing has to run for that, it is derived from
--               ended_at.
-- Ratings       0.0-10.0, one decimal, only for checked-in members. A member
--               may rate and re-rate until 48 hours after the event ended.
--               During that window nobody sees others' ratings until they
--               have submitted their own. Once the event is Past, every
--               current member sees the results.
--
-- Historical results count only people who were checked in: a prediction
-- from someone who did not attend stays stored (inactive) but is not shown.
-- Removed members keep their place in history under the name they had.
--
--   authenticated (member)  submit_prediction (self or own guest),
--                           submit_rating
--   authenticated (Dino)    check_in, undo_check_in, add_walk_in, end_event,
--                           reopen_event, owner_set_prediction,
--                           owner_set_rating, link_guest_to_member

-- For a future seat assignment feature: where this person sits. Nothing
-- writes it yet; it is here so adding seats later is a feature, not a schema
-- change. Not in the member column grant.
alter table public.event_participants
  add column seat_label text,
  add constraint event_participants_seat_label_check
    check (seat_label is null or (seat_label = btrim(seat_label) and char_length(seat_label) between 1 and 20));

-- Dino may later say "this guest was really this member". Never inferred,
-- never automatic; it only records the link.
alter table public.guests
  add column linked_member_id uuid references public.members (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 1. Who may read which scores
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because they must look at score rows the caller cannot
-- read yet. Each answers one yes/no question about the caller.

-- Predictions open up to a member once their own is in, and to everyone
-- once the night has ended.
create function private.predictions_revealed(p_event_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_member_id() is not null and (
    exists (select 1 from public.events e where e.id = p_event_id and e.ended_at is not null)
    or exists (
      select 1 from public.predictions pr
      join public.event_participants p on p.id = pr.participant_id
      where pr.event_id = p_event_id and p.member_id = private.current_member_id()))
$$;

-- Ratings open up to a member once their own is in, and to everyone once
-- the 48-hour rating window has closed.
create function private.ratings_revealed(p_event_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_member_id() is not null and (
    exists (select 1 from public.events e
            where e.id = p_event_id and e.ended_at is not null and now() >= e.ended_at + interval '48 hours')
    or exists (
      select 1 from public.ratings r
      join public.event_participants p on p.id = r.participant_id
      where r.event_id = p_event_id and p.member_id = private.current_member_id()))
$$;

-- Whether the caller was checked in to the event (gates photo upload).
create function private.current_member_checked_in(p_event_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.event_participants p
    where p.event_id = p_event_id and p.member_id = private.current_member_id() and p.checked_in_at is not null)
$$;

revoke all on function private.predictions_revealed(uuid) from public, anon, authenticated, service_role;
revoke all on function private.ratings_revealed(uuid) from public, anon, authenticated, service_role;
revoke all on function private.current_member_checked_in(uuid) from public, anon, authenticated, service_role;
grant execute on function private.predictions_revealed(uuid) to authenticated;
grant execute on function private.ratings_revealed(uuid) to authenticated;
grant execute on function private.current_member_checked_in(uuid) to authenticated;

-- Added to the existing own-or-hosted policies (policies are OR-ed). Only
-- predictions that still count are shown to others.
create policy "read revealed predictions" on public.predictions
  for select to authenticated
  using (is_active and private.predictions_revealed(event_id));

create policy "read revealed ratings" on public.ratings
  for select to authenticated
  using (private.ratings_revealed(event_id));

-- History is for every current member, including those who were not there
-- and never answered the RSVP: once a night has ended, the people who were
-- checked in are visible to all active members.
create policy "read attendees of ended events" on public.event_participants
  for select to authenticated
  using (
    checked_in_at is not null
    and (select private.current_member_id()) is not null
    and exists (select 1 from public.events e where e.id = event_participants.event_id and e.ended_at is not null)
  );

-- The same widening for guest names.
create or replace function private.current_member_can_see_roster_guest(p_guest_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.event_participants p
    where p.guest_id = p_guest_id
      and ((p.rsvp_status in ('going', 'maybe') and private.current_member_has_rsvped(p.event_id))
        or (p.checked_in_at is not null and private.current_member_id() is not null
            and exists (select 1 from public.events e where e.id = p.event_id and e.ended_at is not null)))
  )
$$;

-- ---------------------------------------------------------------------------
-- 2. Predictions
-- ---------------------------------------------------------------------------

-- Insert only. A member predicts for themselves or their guest once they are
-- confirmed; Dino may enter a missing one for anyone (that is what check-in
-- uses). An existing prediction is locked for everyone here.
create function private.submit_prediction_impl(p_participant_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_part  public.event_participants%rowtype;
  v_event public.events%rowtype;
  v_mine  boolean;
begin
  if not private.valid_score(p_score) then
    raise exception 'A prediction is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
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
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if v_part.confirmation_status is distinct from 'attending' then
    raise exception 'Only confirmed attendees predict.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.predictions pr where pr.participant_id = p_participant_id) then
    raise exception 'That prediction is locked in.' using errcode = 'P0001';
  end if;

  insert into public.predictions (participant_id, event_id, score, is_active)
  values (p_participant_id, v_event.id, p_score, true);
  if not v_mine then
    perform private.write_audit('prediction.entered_by_owner', 'public.predictions', p_participant_id,
      jsonb_build_object('event_id', v_event.id));
  end if;
end;
$$;

-- Dino's correction: creates or replaces any prediction. Always audited,
-- with the old and new values.
create function private.owner_set_prediction_impl(p_participant_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_part  public.event_participants%rowtype;
  v_old   numeric;
begin
  if not private.valid_score(p_score) then
    raise exception 'A prediction is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found then
    raise exception 'That person is not on this event.' using errcode = 'P0002';
  end if;
  select pr.score into v_old from public.predictions pr where pr.participant_id = p_participant_id;
  insert into public.predictions as pr (participant_id, event_id, score, is_active)
  values (p_participant_id, v_part.event_id, p_score, v_part.confirmation_status is not distinct from 'attending')
  on conflict (participant_id) do update set score = excluded.score;
  perform private.write_audit('prediction.corrected', 'public.predictions', p_participant_id,
    jsonb_build_object('event_id', v_part.event_id, 'from', v_old, 'to', p_score));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Check-in
-- ---------------------------------------------------------------------------

-- Being checked in means they are there, so it also settles their
-- confirmation as attending (and with it their charge, if tickets are
-- bought). p_prediction, when given, fills in a missing prediction; it never
-- replaces one.
create function private.check_in_impl(p_participant_id uuid, p_prediction numeric default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_part  public.event_participants%rowtype;
  v_event public.events%rowtype;
begin
  if p_prediction is not null and not private.valid_score(p_prediction) then
    raise exception 'A prediction is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found then
    raise exception 'That person is not on this event.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_part.event_id);
  if v_event.selected_showtime_id is null then
    raise exception 'There is no showtime to check in for yet.' using errcode = 'P0001';
  end if;

  update public.event_participants p
  set checked_in_at = coalesce(p.checked_in_at, now()),
      checked_in_by_member_id = coalesce(p.checked_in_by_member_id, v_owner),
      rsvp_status = case when p.rsvp_status in ('going', 'maybe') then p.rsvp_status else 'going' end,
      rsvp_updated_at = case when p.rsvp_status in ('going', 'maybe') then p.rsvp_updated_at else now() end,
      confirmation_status = 'attending',
      confirmation_updated_at = case when p.confirmation_status = 'attending' then p.confirmation_updated_at else now() end
  where p.id = p_participant_id;

  if p_prediction is not null and v_event.ended_at is null then
    insert into public.predictions (participant_id, event_id, score, is_active)
    values (p_participant_id, v_event.id, p_prediction, true)
    on conflict (participant_id) do nothing;
  end if;
  update public.predictions pr set is_active = true where pr.participant_id = p_participant_id;

  perform private.participant_attendance_changed(p_participant_id);
  perform private.write_audit('checkin.recorded', 'public.event_participants', p_participant_id,
    jsonb_build_object('event_id', v_event.id, 'prediction_entered', p_prediction is not null));
end;
$$;

-- A mis-tap. Clears the check-in only; confirmation, prediction, charge, and
-- any rating or photos already made are left for Dino to sort out.
create function private.undo_check_in_impl(p_participant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event uuid;
begin
  update public.event_participants p
  set checked_in_at = null, checked_in_by_member_id = null
  where p.id = p_participant_id and p.checked_in_at is not null
  returning p.event_id into v_event;
  if v_event is null then
    return;
  end if;
  perform private.write_audit('checkin.undone', 'public.event_participants', p_participant_id,
    jsonb_build_object('event_id', v_event));
end;
$$;

-- Someone who turns up without having been on the list: a member (give
-- p_member_id) or a guest (give p_guest_name and the hosting member). They
-- are added as Going, confirmed, and checked in at once, and get a charge at
-- the going rate if tickets are already bought. Returns the participant id.
create function private.add_walk_in_impl(
  p_event_id uuid, p_member_id uuid default null, p_guest_name text default null,
  p_host_member_id uuid default null, p_prediction numeric default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_guest uuid;
  v_part  uuid;
begin
  if v_event.selected_showtime_id is null then
    raise exception 'There is no showtime to check in for yet.' using errcode = 'P0001';
  end if;
  if (p_member_id is null) = (p_guest_name is null) then
    raise exception 'A walk-in is either a member or a named guest.' using errcode = '22023';
  end if;

  if p_member_id is not null then
    if not exists (select 1 from public.members m where m.id = p_member_id and m.status = 'active') then
      raise exception 'That member is not active.' using errcode = '22023';
    end if;
    insert into public.event_participants as p (event_id, member_id, rsvp_status, rsvp_updated_at)
    values (p_event_id, p_member_id, 'going', now())
    on conflict (event_id, member_id) do update set rsvp_status = 'going', rsvp_updated_at = now()
    returning p.id into v_part;
  else
    if btrim(p_guest_name) = '' then
      raise exception 'A guest needs a name.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.members m where m.id = p_host_member_id and m.status = 'active') then
      raise exception 'A guest needs a host who is a member.' using errcode = '22023';
    end if;
    insert into public.guests (display_name, host_member_id, event_id)
    values (btrim(p_guest_name), p_host_member_id, p_event_id)
    returning id into v_guest;
    insert into public.event_participants (event_id, guest_id, rsvp_status, rsvp_updated_at)
    values (p_event_id, v_guest, 'going', now())
    returning id into v_part;
  end if;

  perform private.write_audit('checkin.walk_in', 'public.event_participants', v_part,
    jsonb_build_object('event_id', p_event_id, 'guest', v_guest is not null));
  perform private.check_in_impl(v_part, p_prediction);
  return v_part;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Ending the night
-- ---------------------------------------------------------------------------

create function private.end_event_impl(p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
begin
  if v_event.selected_showtime_id is null then
    raise exception 'This event never had a showtime. Delete it instead.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null then
    return;
  end if;
  perform private.settle_confirmations(p_event_id);
  update public.events e set ended_at = now(), ended_by_member_id = v_owner where e.id = p_event_id;
  -- Predictions count only for people who were there.
  update public.predictions pr set is_active = exists (
    select 1 from public.event_participants p where p.id = pr.participant_id and p.checked_in_at is not null)
  where pr.event_id = p_event_id;

  perform private.notify(p.member_id, p_event_id, 'rating_open', 'How was it?',
                         'Rate the movie. You have 48 hours.', jsonb_build_object('event_id', p_event_id),
                         'rating_open:' || p_event_id)
  from public.event_participants p
  where p.event_id = p_event_id and p.member_id is not null and p.checked_in_at is not null;
  perform private.write_audit('event.ended', 'public.events', p_event_id);
end;
$$;

-- Ended by mistake. Allowed only while the rating window is still open.
create function private.reopen_event_impl(p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
begin
  if v_event.ended_at is null then
    return;
  end if;
  if now() >= v_event.ended_at + interval '48 hours' then
    raise exception 'This movie night is already in Past.' using errcode = 'P0001';
  end if;
  update public.events e set ended_at = null, ended_by_member_id = null where e.id = p_event_id;
  perform private.write_audit('event.reopened', 'public.events', p_event_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Ratings
-- ---------------------------------------------------------------------------

-- The caller's own rating for an event they were checked in to. Can be
-- changed until 48 hours after the event ended.
create function private.submit_rating_impl(p_event_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_part  uuid;
begin
  if not private.valid_score(p_score) then
    raise exception 'A rating is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select p.id into v_part from public.event_participants p
  where p.event_id = p_event_id and p.member_id = v_me and p.checked_in_at is not null;
  if v_part is null then
    raise exception 'Only people who were checked in can rate.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null and now() >= v_event.ended_at + interval '48 hours' then
    raise exception 'Ratings locked 48 hours after the movie.' using errcode = 'P0001';
  end if;
  insert into public.ratings as r (participant_id, event_id, score)
  values (v_part, p_event_id, p_score)
  on conflict (participant_id) do update set score = excluded.score, submitted_at = now();
end;
$$;

-- Dino's correction, at any time, for a checked-in member. Audited.
create function private.owner_set_rating_impl(p_participant_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_part  public.event_participants%rowtype;
  v_old   numeric;
begin
  if not private.valid_score(p_score) then
    raise exception 'A rating is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found or v_part.member_id is null or v_part.checked_in_at is null then
    raise exception 'Only a checked-in member has a rating.' using errcode = 'P0001';
  end if;
  select r.score into v_old from public.ratings r where r.participant_id = p_participant_id;
  insert into public.ratings as r (participant_id, event_id, score)
  values (p_participant_id, v_part.event_id, p_score)
  on conflict (participant_id) do update set score = excluded.score;
  perform private.write_audit('rating.corrected', 'public.ratings', p_participant_id,
    jsonb_build_object('event_id', v_part.event_id, 'from', v_old, 'to', p_score));
end;
$$;

create function private.link_guest_to_member_impl(p_guest_id uuid, p_member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := private.require_owner();
begin
  if p_member_id is not null and not exists (select 1 from public.members m where m.id = p_member_id) then
    raise exception 'No such member.' using errcode = 'P0002';
  end if;
  update public.guests g set linked_member_id = p_member_id where g.id = p_guest_id;
  if not found then
    raise exception 'That guest no longer exists.' using errcode = 'P0002';
  end if;
  perform private.write_audit('guest.linked', 'public.guests', p_guest_id, jsonb_build_object('member_id', p_member_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Public RPCs and grants
-- ---------------------------------------------------------------------------

create function public.submit_prediction(p_participant_id uuid, p_score numeric)
returns void language sql security invoker set search_path = ''
as $$ select private.submit_prediction_impl(p_participant_id, p_score) $$;

create function public.owner_set_prediction(p_participant_id uuid, p_score numeric)
returns void language sql security invoker set search_path = ''
as $$ select private.owner_set_prediction_impl(p_participant_id, p_score) $$;

create function public.check_in(p_participant_id uuid, p_prediction numeric default null)
returns void language sql security invoker set search_path = ''
as $$ select private.check_in_impl(p_participant_id, p_prediction) $$;

create function public.undo_check_in(p_participant_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.undo_check_in_impl(p_participant_id) $$;

create function public.add_walk_in(
  p_event_id uuid, p_member_id uuid default null, p_guest_name text default null,
  p_host_member_id uuid default null, p_prediction numeric default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.add_walk_in_impl(p_event_id, p_member_id, p_guest_name, p_host_member_id, p_prediction) $$;

create function public.end_event(p_event_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.end_event_impl(p_event_id) $$;

create function public.reopen_event(p_event_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.reopen_event_impl(p_event_id) $$;

create function public.submit_rating(p_event_id uuid, p_score numeric)
returns void language sql security invoker set search_path = ''
as $$ select private.submit_rating_impl(p_event_id, p_score) $$;

create function public.owner_set_rating(p_participant_id uuid, p_score numeric)
returns void language sql security invoker set search_path = ''
as $$ select private.owner_set_rating_impl(p_participant_id, p_score) $$;

create function public.link_guest_to_member(p_guest_id uuid, p_member_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.link_guest_to_member_impl(p_guest_id, p_member_id) $$;

select private.grant_rpc('submit_prediction', 'authenticated');
select private.grant_rpc('owner_set_prediction', 'authenticated');
select private.grant_rpc('check_in', 'authenticated');
select private.grant_rpc('undo_check_in', 'authenticated');
select private.grant_rpc('add_walk_in', 'authenticated');
select private.grant_rpc('end_event', 'authenticated');
select private.grant_rpc('reopen_event', 'authenticated');
select private.grant_rpc('submit_rating', 'authenticated');
select private.grant_rpc('owner_set_rating', 'authenticated');
select private.grant_rpc('link_guest_to_member', 'authenticated');
