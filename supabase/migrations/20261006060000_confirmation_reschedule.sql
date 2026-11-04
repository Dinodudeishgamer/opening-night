-- Opening Night v3 — confirming the selected showtime, and rescheduling it.
--
-- RSVP asked "do you want to come?". Once Dino selects a showtime, a second,
-- separate question is asked of everyone who said Going or Maybe, and of each
-- of their guests independently: "can you make THIS showtime?"
--
--   Confirmed / Can't Make It      confirmation_status attending / not_attending
--   pending                        null, for a Going/Maybe participant of an
--                                  event that has a selected showtime
--
-- A member answers for themselves and for each of their guests, and may
-- change the answer until the confirmation deadline or until Dino buys the
-- tickets, whichever comes first. No answer by then is Not Attending. After
-- that only Dino changes it (a late cancellation is a conversation with him).
--
-- A prediction follows its author's confirmation: it stays stored when they
-- become Not Attending but is inactive until they confirm again.
--
-- Rescheduling (a different date or time, before tickets are bought) asks
-- the question again: answers go back to pending with a new deadline, the
-- previous answers are kept where only Dino can read them, voting history is
-- untouched, predictions go inactive until re-confirmed, and everyone
-- involved is notified. Correcting the theater or format of the selected
-- showtime is not a reschedule and resets nothing (update_showtime).
--
--   authenticated (member)  set_confirmation (self or own guest; Dino for
--                           anyone, audited)
--   authenticated (Dino)    reschedule_event

-- What each participant had answered before the last reschedule. Not in the
-- column grant on event_participants, so only Dino's read path returns it.
alter table public.event_participants
  add column prior_confirmation_status text,
  add constraint event_participants_prior_confirmation_check
    check (prior_confirmation_status in ('attending', 'not_attending'));

-- Whether members may still answer or change their confirmation.
create function private.confirmation_open(p_event public.events)
returns boolean language sql stable set search_path = '' as $$
  select p_event.selected_showtime_id is not null
     and p_event.tickets_purchased_at is null
     and p_event.ended_at is null
     and now() < p_event.confirmation_deadline
$$;

-- Once confirmation has closed, pending means Not Attending. Idempotent.
create function private.settle_confirmations(p_event_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.event_participants p
  set confirmation_status = 'not_attending', confirmation_updated_at = now()
  where p.event_id = p_event_id
    and p.rsvp_status in ('going', 'maybe')
    and p.confirmation_status is null;
end;
$$;

revoke all on function private.confirmation_open(public.events) from public, anon, authenticated, service_role;
revoke all on function private.settle_confirmations(uuid) from public, anon, authenticated, service_role;

create function private.set_confirmation_impl(p_participant_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_part  public.event_participants%rowtype;
  v_event public.events%rowtype;
  v_mine  boolean;
  v_owner boolean := private.current_owner_id() is not null;
begin
  if p_status is null or p_status not in ('attending', 'not_attending') then
    raise exception 'Answer Confirmed or Can''t Make It.' using errcode = '22023';
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

  if v_event.selected_showtime_id is null then
    raise exception 'There is no showtime to confirm yet.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if v_part.rsvp_status is null or v_part.rsvp_status not in ('going', 'maybe') then
    raise exception 'Only Going and Maybe confirm a showtime.' using errcode = 'P0001';
  end if;
  if not v_owner and not private.confirmation_open(v_event) then
    if v_event.tickets_purchased_at is not null then
      raise exception 'Tickets are bought. Talk to Dino if your plans changed.' using errcode = 'P0001';
    end if;
    raise exception 'The confirmation deadline has passed. Talk to Dino.' using errcode = 'P0001';
  end if;

  if v_part.confirmation_status is distinct from p_status then
    update public.event_participants p
    set confirmation_status = p_status, confirmation_updated_at = now()
    where p.id = p_participant_id;
    update public.predictions pr set is_active = (p_status = 'attending') where pr.participant_id = p_participant_id;

    if not v_mine or not private.confirmation_open(v_event) then
      perform private.write_audit('confirmation.overridden', 'public.event_participants', p_participant_id,
        jsonb_build_object('event_id', v_event.id, 'from', v_part.confirmation_status, 'to', p_status,
                           'after_tickets', v_event.tickets_purchased_at is not null));
    end if;
    perform private.participant_attendance_changed(p_participant_id);
  end if;
end;
$$;

-- A different date or time for the night. The new slot becomes a showtime
-- row of its own (or reuses an identical active one), so the old one and the
-- votes cast on it stay as they were.
create function private.reschedule_event_impl(
  p_event_id uuid, p_theater_id uuid, p_starts_at timestamptz, p_format text,
  p_format_other text, p_confirmation_deadline timestamptz
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_old   public.showtimes%rowtype;
  v_new   uuid;
  v_other text := case when p_format = 'other' then btrim(p_format_other) end;
begin
  perform private.check_showtime_fields(p_theater_id, p_starts_at, p_format, p_format_other);
  if v_event.selected_showtime_id is null then
    raise exception 'Select a showtime first.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if v_event.tickets_purchased_at is not null then
    raise exception 'Tickets are already bought for this showtime.' using errcode = 'P0001';
  end if;
  select * into v_old from public.showtimes s where s.id = v_event.selected_showtime_id;
  if p_starts_at = v_old.starts_at then
    raise exception 'Same date and time. Correct the theater or format on the showtime instead.' using errcode = 'P0001';
  end if;
  if p_starts_at <= now() then
    raise exception 'That showtime is in the past.' using errcode = '22023';
  end if;
  if p_confirmation_deadline is null or p_confirmation_deadline <= now() or p_confirmation_deadline > p_starts_at then
    raise exception 'The confirmation deadline must be between now and the showtime.' using errcode = '22023';
  end if;

  select s.id into v_new from public.showtimes s
  where s.event_id = p_event_id and s.removed_at is null and s.theater_id = p_theater_id
    and s.starts_at = p_starts_at and s.format = p_format and s.format_other is not distinct from v_other;
  if v_new is null then
    insert into public.showtimes (event_id, theater_id, starts_at, format, format_other)
    values (p_event_id, p_theater_id, p_starts_at, p_format, v_other)
    returning id into v_new;
  end if;

  update public.events e
  set selected_showtime_id = v_new, showtime_selected_at = now(),
      confirmation_deadline = p_confirmation_deadline,
      schedule_revision = e.schedule_revision + 1
  where e.id = p_event_id;

  update public.event_participants p
  set prior_confirmation_status = coalesce(p.confirmation_status, p.prior_confirmation_status),
      confirmation_status = null, confirmation_updated_at = null
  where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe');

  update public.predictions pr set is_active = false where pr.event_id = p_event_id;

  perform private.notify(x.member_id, p_event_id, 'event_rescheduled', 'Movie night moved',
                         'There is a new showtime. Confirm again whether you can make it.',
                         jsonb_build_object('event_id', p_event_id),
                         'event_rescheduled:' || p_event_id || ':' || (v_event.schedule_revision + 1))
  from (
    select distinct coalesce(p.member_id, g.host_member_id) as member_id
    from public.event_participants p
    left join public.guests g on g.id = p.guest_id
    where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe')
  ) x;

  perform private.write_audit('event.rescheduled', 'public.events', p_event_id,
    jsonb_build_object('from_showtime_id', v_old.id, 'from_starts_at', v_old.starts_at,
                       'to_showtime_id', v_new, 'to_starts_at', p_starts_at,
                       'confirmation_deadline', p_confirmation_deadline));
  return v_new;
end;
$$;

-- Dino's view of the roster: everything members see plus the bookkeeping
-- they do not (previous answers after a reschedule, who checked whom in,
-- when each answer was given).
create function private.owner_roster_impl(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_owner();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'participant_id', p.id,
      'prior_confirmation_status', p.prior_confirmation_status,
      'rsvp_updated_at', p.rsvp_updated_at,
      'confirmation_updated_at', p.confirmation_updated_at) order by p.created_at, p.id)
    from public.event_participants p where p.event_id = p_event_id), '[]'::jsonb);
end;
$$;

create function public.set_confirmation(p_participant_id uuid, p_status text)
returns void language sql security invoker set search_path = ''
as $$ select private.set_confirmation_impl(p_participant_id, p_status) $$;

create function public.reschedule_event(
  p_event_id uuid, p_theater_id uuid, p_starts_at timestamptz, p_format text,
  p_format_other text, p_confirmation_deadline timestamptz
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.reschedule_event_impl(p_event_id, p_theater_id, p_starts_at, p_format, p_format_other, p_confirmation_deadline) $$;

create function public.owner_roster(p_event_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.owner_roster_impl(p_event_id) $$;

select private.grant_rpc('set_confirmation', 'authenticated');
select private.grant_rpc('reschedule_event', 'authenticated');
select private.grant_rpc('owner_roster', 'authenticated');
