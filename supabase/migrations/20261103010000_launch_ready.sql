-- Opening Night v3 — ready for the App Store.
--
-- 1. No "RSVP for X: the deadline is coming up" on the heels of "New movie
--    night: X". A night posted with a deadline under two days away sent
--    both, five minutes apart. The near and gentle RSVP reminders now wait
--    until 12 hours after the member was told about the night, the same
--    grace "Confirm your spot" has after "Showtime picked". The last call,
--    6 hours before the deadline, is never held back.
--
-- 2. owner_reach: after posting a night, Dino is told how many phones it
--    went to and who has not signed in yet, so would not have seen it.
--
-- 3. delete_my_account: Apple requires that anyone with an account can
--    delete it from inside the app. A member who was never on a movie night
--    is deleted outright, like removing them. One who was is cut off and
--    made anonymous: their name becomes "Former member", their picture,
--    devices, inbox and invites are deleted, and their logins are revoked.
--    Their scores stay on the nights they were at, so the group's history
--    still adds up. The organizer cannot delete his own account this way.

-- ---------------------------------------------------------------------------
-- 1. The planner
-- ---------------------------------------------------------------------------

-- The body below is the planner from no_quiet_hours with the RSVP grace
-- added; everything else is as it was.
create or replace function private.plan_notifications()
returns void language plpgsql set search_path = '' as $$
declare
  a record;
  v_title text;
  -- The club's own clock, for telling today from tomorrow.
  v_zone  text := 'America/Chicago';
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
-- 2. Who a new night reached
-- ---------------------------------------------------------------------------

create function private.owner_reach_impl()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_owner();
  return jsonb_build_object(
    'phones', (select count(distinct d.member_id) from private.push_devices d
               join public.members m on m.id = d.member_id
               where d.disabled_at is null and m.status = 'active' and m.role <> 'owner'),
    'not_signed_in', coalesce((
      select jsonb_agg(m.first_name || ' ' || m.last_initial || '.' order by m.first_name)
      from public.members m
      where m.status = 'active' and m.role <> 'owner'
        and not exists (select 1 from private.auth_claims c where c.member_id = m.id and c.revoked_at is null)
    ), '[]'::jsonb));
end;
$$;

create function public.owner_reach()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.owner_reach_impl() $$;

select private.grant_rpc('owner_reach', 'authenticated');

-- ---------------------------------------------------------------------------
-- 3. Deleting your own account
-- ---------------------------------------------------------------------------

create function private.delete_my_account_impl()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid := private.require_member();
  v_member  public.members%rowtype;
  v_users   uuid[];
  v_deleted boolean := false;
begin
  select * into v_member from public.members m where m.id = v_me for update;
  if v_member.role = 'owner' then
    raise exception 'The organizer cannot delete his account from the app.' using errcode = 'P0001';
  end if;

  delete from private.push_devices d where d.member_id = v_me;
  delete from public.notifications n where n.recipient_member_id = v_me;
  update private.member_invites i set revoked_at = now()
  where i.member_id = v_me and i.redeemed_at is null and i.revoked_at is null;

  -- Never on a movie night: nothing to keep, so nothing is kept.
  begin
    select array_agg(c.auth_user_id) into v_users from private.auth_claims c where c.member_id = v_me;
    delete from private.auth_claims c where c.member_id = v_me;
    delete from public.members m where m.id = v_me;
    delete from auth.users u where u.id = any (coalesce(v_users, '{}'::uuid[]));
    v_deleted := true;
  exception when foreign_key_violation or restrict_violation then
    v_deleted := false;
  end;

  if not v_deleted then
    update private.auth_claims c set revoked_at = now(), revoked_by_member_id = v_me
    where c.member_id = v_me and c.revoked_at is null;
    update public.members m
    set first_name = 'Former member', last_initial = 'X', avatar_kind = 'initials',
        avatar_emoji = null, avatar_path = null, status = 'removed'
    where m.id = v_me;
  end if;

  -- The log keeps that it happened, not who it was.
  perform private.write_audit('member.deleted_own_account', 'public.members', v_me,
    jsonb_build_object('outcome', case when v_deleted then 'deleted' else 'anonymized' end));
  return case when v_deleted then 'deleted' else 'anonymized' end;
end;
$$;

create function public.delete_my_account()
returns text language sql security invoker set search_path = ''
as $$ select private.delete_my_account_impl() $$;

select private.grant_rpc('delete_my_account', 'authenticated');
