-- Opening Night v3 — ask people less, and never in the middle of the night.
--
-- 1. Picking a showtime no longer asks a question people already answered.
--    Someone who RSVPed Going and ticked that very showtime on their current
--    ballot has said, twice, that they will be there: they are confirmed the
--    moment Dino picks it, and told so. They can still change the answer
--    until the deadline, exactly as before. Maybe, and anyone who did not
--    tick that time (or did not vote), is asked as before. A reschedule
--    still asks everyone: nobody voted on the new time.
--
-- 2. Reminders keep quiet hours. The planner is the only thing that sends a
--    notification on its own clock, and it now does nothing between 9 PM and
--    9 AM club time; what it would have sent goes out at the first tick
--    after 9. Things Dino does himself (posting a night, picking a showtime,
--    an announcement) still arrive when he does them.
--
-- 3. The day-before reminder says "today" when quiet hours held it past
--    midnight.

-- ---------------------------------------------------------------------------
-- 1. Quiet hours
-- ---------------------------------------------------------------------------

-- One row. Reminders are held from `starts` until `ends`, read on the clock
-- of `time_zone`. The same time for both means no quiet hours at all.
create table private.quiet_hours (
  id         boolean primary key default true,
  time_zone  text    not null default 'America/Chicago',
  starts     time    not null default '21:00',
  ends       time    not null default '09:00',
  constraint quiet_hours_one_row check (id),
  constraint quiet_hours_time_zone_check check (time_zone <> '')
);

alter table private.quiet_hours enable row level security;
revoke all on table private.quiet_hours from public, anon, authenticated, service_role;

insert into private.quiet_hours default values;

create function private.in_quiet_hours()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((
    select case
             when q.starts = q.ends then false
             when q.starts < q.ends then t.local >= q.starts and t.local < q.ends
             else t.local >= q.starts or t.local < q.ends
           end
    from private.quiet_hours q,
         lateral (select (now() at time zone q.time_zone)::time as local) t
  ), false)
$$;

revoke all on function private.in_quiet_hours() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The planner
-- ---------------------------------------------------------------------------

-- The body below is the planner from remove_sms with two changes: it returns
-- at once during quiet hours, and the day-before reminder names the right
-- day. Everything else is as it was.
create or replace function private.plan_notifications()
returns void language plpgsql set search_path = '' as $$
declare
  a record;
  v_title text;
  v_zone  text := coalesce((select q.time_zone from private.quiet_hours q), 'America/Chicago');
begin
  if private.in_quiet_hours() then
    return;
  end if;

  for a in
    select pa.*, e.rsvp_deadline, e.confirmation_deadline, e.created_at as event_created_at, e.ended_at,
           e.voting_revision, e.schedule_revision,
           coalesce(e.title_override, mv.title) as title
    from private.pending_actions() pa
    join public.events e on e.id = pa.event_id
    join public.movies mv on mv.id = e.movie_id
  loop
    v_title := a.title;
    if a.kind = 'rsvp' then
      if a.rsvp_deadline - now() <= interval '6 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'Last call: ' || v_title,
          'RSVP closes soon. Going, Maybe, or Can''t Go?', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':final');
      elsif a.rsvp_deadline - now() <= interval '48 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'RSVP for ' || v_title,
          'The deadline is coming up.', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':near');
      elsif now() - a.event_created_at >= interval '24 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'Are you in for ' || v_title || '?',
          'Let Dino know either way.', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':gentle');
      end if;

    elsif a.kind = 'vote' then
      if now() - (select max(s.updated_at) from public.showtimes s where s.event_id = a.event_id) >= interval '12 hours' then
        perform private.notify(a.member_id, a.event_id, 'vote_reminder', 'Which showtimes work?',
          'Mark every time you can make for ' || v_title || '.', jsonb_build_object('event_id', a.event_id),
          'vote:' || a.event_id || ':' || a.voting_revision || ':' || to_char(now(), 'YYYY-MM-DD'));
      end if;

    elsif a.kind = 'confirm' then
      if a.confirmation_deadline - now() <= interval '6 hours' then
        perform private.notify(a.member_id, a.event_id, 'confirm_reminder', 'Last call to confirm',
          'Can you make the showtime for ' || v_title || '?', jsonb_build_object('event_id', a.event_id),
          'confirm:' || a.event_id || ':' || a.schedule_revision || ':final');
      elsif not exists (
        select 1 from public.notifications n
        where n.recipient_member_id = a.member_id and n.event_id = a.event_id
          and n.kind in ('showtime_selected', 'event_rescheduled')
          and n.created_at > now() - interval '12 hours'
      ) then
        perform private.notify(a.member_id, a.event_id, 'confirm_reminder', 'Confirm your spot',
          'Can you make the showtime for ' || v_title || '?', jsonb_build_object('event_id', a.event_id),
          'confirm:' || a.event_id || ':' || a.schedule_revision || ':' || to_char(now(), 'YYYY-MM-DD'));
      end if;

    elsif a.kind = 'rate' then
      if now() - a.ended_at >= interval '24 hours' then
        perform private.notify(a.member_id, a.event_id, 'rating_reminder', 'Rate ' || v_title,
          'Ratings lock 48 hours after the movie.', jsonb_build_object('event_id', a.event_id),
          'rating_reminder:' || a.event_id);
      end if;
    end if;
  end loop;

  -- Payments: per charge, keyed on its own age.
  for a in
    select c.id as charge_id, c.event_id, c.created_at, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title
    from public.charges c
    join public.event_participants p on p.id = c.participant_id
    left join public.guests g on g.id = p.guest_id
    join public.events e on e.id = c.event_id
    join public.movies mv on mv.id = e.movie_id
    where c.status = 'unpaid' and now() - c.created_at >= interval '2 days'
  loop
    perform private.notify(a.member_id, a.event_id, 'payment_reminder', 'Movie night payment',
      'You still owe Dino for ' || a.title || '. Open the app to pay.', jsonb_build_object('event_id', a.event_id),
      'pay:' || a.charge_id || ':' || floor(extract(epoch from now() - a.created_at) / 259200)::integer);
  end loop;

  -- The day before: everyone still coming.
  for a in
    select e.id as event_id, e.schedule_revision, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title,
           (s.starts_at at time zone v_zone)::date = (now() at time zone v_zone)::date as is_today
    from public.events e
    join public.showtimes s on s.id = e.selected_showtime_id
    join public.movies mv on mv.id = e.movie_id
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
         and p.confirmation_status is distinct from 'not_attending'
    left join public.guests g on g.id = p.guest_id
    where e.ended_at is null and s.starts_at > now() and s.starts_at - now() <= interval '24 hours'
  loop
    perform private.notify(a.member_id, a.event_id, 'event_reminder',
      a.title || case when a.is_today then ' is today' else ' is tomorrow' end,
      'Check the showtime and theater in the app.', jsonb_build_object('event_id', a.event_id),
      'event_reminder:' || a.event_id || ':' || a.schedule_revision);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Selecting a showtime
-- ---------------------------------------------------------------------------

-- The body below is select_showtime_impl from voting_selection with the
-- automatic confirmation added, and the notification saying which of the two
-- things happened to the person reading it.
create or replace function private.select_showtime_impl(p_event_id uuid, p_showtime_id uuid, p_confirmation_deadline timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner    uuid := private.require_owner();
  v_event    public.events%rowtype := private.lock_event(p_event_id);
  v_showtime public.showtimes%rowtype;
  v_auto     integer;
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

  -- Going, with a current ballot that ticks this showtime: already answered.
  update public.event_participants p
  set confirmation_status = 'attending', confirmation_updated_at = now()
  where p.event_id = p_event_id and p.rsvp_status = 'going'
    and exists (select 1 from public.showtime_ballots b
                where b.participant_id = p.id and b.voting_revision = v_event.voting_revision
                  and b.invalidated_at is null)
    and exists (select 1 from public.showtime_availability a
                where a.participant_id = p.id and a.showtime_id = p_showtime_id and a.is_available);
  get diagnostics v_auto = row_count;

  -- One notification per member, for themselves and their guests together:
  -- a question if any of those places still needs an answer, otherwise the news.
  perform private.notify(x.member_id, p_event_id, 'showtime_selected',
                         case when x.asked then 'Showtime picked' else 'Showtime picked: you''re in' end,
                         case when x.asked then 'Confirm whether you can make it.'
                              else 'It is a time you said works, so you are confirmed. Change it in the app if something came up.' end,
                         jsonb_build_object('event_id', p_event_id),
                         'showtime_selected:' || p_event_id || ':' || (v_event.schedule_revision + 1))
  from (
    select coalesce(p.member_id, g.host_member_id) as member_id,
           bool_or(p.confirmation_status is null) as asked
    from public.event_participants p
    left join public.guests g on g.id = p.guest_id
    where p.event_id = p_event_id and p.rsvp_status in ('going', 'maybe')
    group by 1
  ) x;

  perform private.write_audit('showtime.selected', 'public.events', p_event_id,
    jsonb_build_object('showtime_id', p_showtime_id, 'starts_at', v_showtime.starts_at,
                       'confirmation_deadline', p_confirmation_deadline,
                       'rsvp_closed_early', v_event.rsvp_deadline > now(),
                       'voters_outstanding', private.voters_outstanding(p_event_id),
                       'confirmed_from_ballots', v_auto));
end;
$$;
