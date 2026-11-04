-- Opening Night v3 — no "Confirm your spot" on the heels of "Showtime picked".
--
-- Selecting (or moving) a showtime already tells everyone to confirm. The
-- planner's daily confirm reminder had no delay, so the next tick, at most
-- five minutes later, sent a second notification saying the same thing.
--
-- The daily reminder now waits until 12 hours after the member was last told
-- about the showtime, the same grace the vote reminder gives after showtimes
-- change. The final reminder, 6 hours before the deadline, is not held back:
-- a short deadline still gets its last call.
--
-- Everything else in the planner is unchanged; the body below is the one
-- from the notifications migration with that one condition added.
create or replace function private.plan_notifications()
returns void language plpgsql set search_path = '' as $$
declare
  a record;
  v_title text;
begin
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
    if now() - a.created_at >= interval '10 days' then
      insert into private.sms_outbox (member_id, event_id, kind, body, dedupe_key)
      select m.id, a.event_id, 'payment_escalation',
             'Opening Night: your share for ' || left(a.title, 60) || ' is still unpaid. Please settle up with Dino.',
             'pay_sms:' || a.charge_id
      from public.members m where m.id = a.member_id and m.status = 'active'
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;

  -- A charge that got paid (or deleted) takes its unsent SMS with it.
  update private.sms_outbox s set status = 'cancelled'
  where s.status = 'queued' and s.kind = 'payment_escalation'
    and not exists (select 1 from public.charges c
                    where 'pay_sms:' || c.id = s.dedupe_key and c.status = 'unpaid');

  -- The day before: everyone still coming.
  for a in
    select e.id as event_id, e.schedule_revision, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title
    from public.events e
    join public.showtimes s on s.id = e.selected_showtime_id
    join public.movies mv on mv.id = e.movie_id
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
         and p.confirmation_status is distinct from 'not_attending'
    left join public.guests g on g.id = p.guest_id
    where e.ended_at is null and s.starts_at > now() and s.starts_at - now() <= interval '24 hours'
  loop
    perform private.notify(a.member_id, a.event_id, 'event_reminder', a.title || ' is tomorrow',
      'Check the showtime and theater in the app.', jsonb_build_object('event_id', a.event_id),
      'event_reminder:' || a.event_id || ':' || a.schedule_revision);
  end loop;
end;
$$;
