-- Get there early. Every showtime now comes with a "be there by" time, 20
-- minutes before it starts (traffic, snacks, previews, settling into seats):
--   * the day-before reminder says when it starts and when to be there;
--   * a new reminder, an hour before that, says it is time to head out.
-- The app shows the same "Be there by" time on the ticket (ARRIVE_EARLY_MINUTES).

insert into private.notification_policy (kind, send_push, max_per_member_per_day, priority)
values ('arrival_reminder', true, null, 'default')
on conflict (kind) do nothing;

create or replace function private.plan_notifications()
returns void language plpgsql set search_path = '' as $$
declare
  a record;
  v_title text;
  -- The club's own clock, for telling today from tomorrow.
  v_zone  text := 'America/Chicago';
  -- Be in our seats this long before the showtime: traffic, snacks, previews.
  v_early interval := interval '20 minutes';
begin
  for a in
    select pa.*, e.rsvp_deadline, e.confirmation_deadline, coalesce(e.announced_at, e.created_at) as event_created_at, e.ended_at,
           e.voting_revision, e.schedule_revision,
           coalesce(e.title_override, mv.title) as title
    from private.pending_actions() pa
    join public.events e on e.id = pa.event_id
    join public.movies mv on mv.id = e.movie_id
    -- A night posted quietly asks nothing of anyone until Dino tells everyone.
    where e.announced_at is not null
  loop
    v_title := a.title;
    if a.kind = 'rsvp' then
      if a.rsvp_deadline - now() <= interval '6 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'Last call: ' || v_title,
          'RSVP closes soon. Going, Maybe, or Can''t Go?', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':final');
      elsif exists (
        select 1 from public.notifications n
        where n.recipient_member_id = a.member_id and n.event_id = a.event_id
          and n.kind = 'event_created' and n.created_at > now() - interval '12 hours'
      ) then
        -- Just told about the night: the reminder would only repeat it.
        null;
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

  -- The day before: everyone still coming, with when to be there.
  for a in
    select e.id as event_id, e.schedule_revision, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title, t.name as theater,
           to_char(s.starts_at at time zone v_zone, 'FMHH12:MI AM') as starts,
           to_char((s.starts_at - v_early) at time zone v_zone, 'FMHH12:MI AM') as arrive,
           (s.starts_at at time zone v_zone)::date = (now() at time zone v_zone)::date as is_today
    from public.events e
    join public.showtimes s on s.id = e.selected_showtime_id
    join public.theaters t on t.id = s.theater_id
    join public.movies mv on mv.id = e.movie_id
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
         and p.confirmation_status is distinct from 'not_attending'
    left join public.guests g on g.id = p.guest_id
    where e.ended_at is null and s.starts_at > now() and s.starts_at - now() <= interval '24 hours'
  loop
    perform private.notify(a.member_id, a.event_id, 'event_reminder',
      a.title || case when a.is_today then ' is today' else ' is tomorrow' end,
      'Starts ' || a.starts || ' at ' || a.theater || '. Be there by ' || a.arrive || ' to get seats and catch the previews.',
      jsonb_build_object('event_id', a.event_id),
      'event_reminder:' || a.event_id || ':' || a.schedule_revision);
  end loop;

  -- An hour before it is time to be there: head out. Same people as the day-before reminder.
  for a in
    select e.id as event_id, e.schedule_revision, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title, t.name as theater,
           to_char((s.starts_at - v_early) at time zone v_zone, 'FMHH12:MI AM') as arrive
    from public.events e
    join public.showtimes s on s.id = e.selected_showtime_id
    join public.theaters t on t.id = s.theater_id
    join public.movies mv on mv.id = e.movie_id
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
         and p.confirmation_status is distinct from 'not_attending'
    left join public.guests g on g.id = p.guest_id
    where e.ended_at is null and s.starts_at - v_early > now() and s.starts_at - v_early - now() <= interval '1 hour'
  loop
    perform private.notify(a.member_id, a.event_id, 'arrival_reminder', 'Time to head out soon',
      'Be at ' || a.theater || ' by ' || a.arrive || ' for ' || a.title || '.', jsonb_build_object('event_id', a.event_id),
      'arrival:' || a.event_id || ':' || a.schedule_revision);
  end loop;
end;
$$;
