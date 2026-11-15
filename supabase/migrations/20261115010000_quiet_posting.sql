-- Posting quietly, and tidy guest names.
--
-- 1. Dino can post a movie night without telling anyone, add its showtimes,
--    and then press "Tell everyone", so the first thing members see is a
--    night they can answer in full. create_event gains p_notify (default
--    true, so older app versions behave as before); announce_event sends the
--    "New movie night" alert for a quiet one. Until it is announced, the
--    planner sends no reminders for it, and the RSVP reminders count from the
--    announcement, not the posting.
--
-- 2. A guest is "Daniel S.", not "Daniel Smith": first name and last
--    initial, the same as everyone else in the app, so the same guest reads
--    the same on every night. A trigger tidies every name on the way in.

alter table public.events add column announced_at timestamptz;
update public.events set announced_at = created_at where announced_at is null;

-- ---------------------------------------------------------------------------
-- 1. Quiet posting
-- ---------------------------------------------------------------------------

drop function public.create_event(jsonb, timestamptz, text, text, text, text, text);

create or replace function private.announce_new_event(p_event_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_title text;
begin
  select coalesce(e.title_override, mv.title) into v_title
  from public.events e join public.movies mv on mv.id = e.movie_id where e.id = p_event_id;
  update public.events e set announced_at = now() where e.id = p_event_id;
  perform private.notify(m.id, p_event_id, 'event_created', 'New movie night: ' || v_title,
                         'Are you in? RSVP in the app.', jsonb_build_object('event_id', p_event_id), 'event_created:' || p_event_id)
  from public.members m
  where m.status = 'active'
    and m.id is distinct from (select e.created_by_member_id from public.events e where e.id = p_event_id);
end;
$$;

revoke all on function private.announce_new_event(uuid) from public, anon, authenticated, service_role;

drop function private.create_event_impl(jsonb, timestamptz, text, text, text, text, text);

create function private.create_event_impl(
  p_movie jsonb,
  p_rsvp_deadline timestamptz,
  p_poster_path text default null,
  p_backdrop_path text default null,
  p_title_override text default null,
  p_description_override text default null,
  p_owner_note text default null,
  p_notify boolean default true
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_tmdb  integer := nullif(p_movie ->> 'tmdb_id', '')::integer;
  v_title text := btrim(coalesce(p_movie ->> 'title', ''));
  v_movie uuid;
  v_event uuid;
begin
  if p_movie is null or jsonb_typeof(p_movie) <> 'object' or v_tmdb is null or v_title = '' then
    raise exception 'Pick a movie first.' using errcode = '22023';
  end if;
  if p_rsvp_deadline is null or p_rsvp_deadline <= now() then
    raise exception 'The RSVP deadline must be in the future.' using errcode = '22023';
  end if;

  insert into public.movies as mv (tmdb_id, title, release_date, runtime_minutes, overview, poster_path, backdrop_path, metadata)
  values (v_tmdb, v_title,
          nullif(p_movie ->> 'release_date', '')::date,
          nullif(p_movie ->> 'runtime_minutes', '')::integer,
          nullif(p_movie ->> 'overview', ''),
          private.clean_tmdb_path(p_movie ->> 'poster_path'),
          private.clean_tmdb_path(p_movie ->> 'backdrop_path'),
          coalesce(p_movie -> 'metadata', '{}'::jsonb))
  on conflict (tmdb_id) do update
    set title = excluded.title, release_date = excluded.release_date,
        runtime_minutes = coalesce(excluded.runtime_minutes, mv.runtime_minutes),
        overview = excluded.overview, poster_path = excluded.poster_path,
        backdrop_path = excluded.backdrop_path, metadata = excluded.metadata
  returning mv.id into v_movie;

  insert into public.events (movie_id, rsvp_deadline, created_by_member_id, poster_path, backdrop_path,
                             title_override, description_override, owner_note)
  values (v_movie, p_rsvp_deadline, v_owner,
          private.clean_tmdb_path(p_poster_path), private.clean_tmdb_path(p_backdrop_path),
          nullif(btrim(p_title_override), ''), nullif(btrim(p_description_override), ''),
          nullif(btrim(p_owner_note), ''))
  returning id into v_event;

  if coalesce(p_notify, true) then
    perform private.announce_new_event(v_event);
  end if;

  perform private.write_audit('event.created', 'public.events', v_event, jsonb_build_object('title', v_title));
  return v_event;
end;
$$;

create function public.create_event(
  p_movie jsonb, p_rsvp_deadline timestamptz, p_poster_path text default null, p_backdrop_path text default null,
  p_title_override text default null, p_description_override text default null, p_owner_note text default null,
  p_notify boolean default true
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_event_impl(p_movie, p_rsvp_deadline, p_poster_path, p_backdrop_path,
                                        p_title_override, p_description_override, p_owner_note, p_notify) $$;

select private.grant_rpc('create_event', 'authenticated');

-- Tells everyone about a night that was posted quietly. Once only.
create function private.announce_event_impl(p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
begin
  if v_event.announced_at is not null then
    raise exception 'Everyone has already been told about this night.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null then
    raise exception 'This movie night has ended.' using errcode = 'P0001';
  end if;
  perform private.announce_new_event(p_event_id);
  perform private.write_audit('event.announced', 'public.events', p_event_id, '{}'::jsonb);
end;
$$;

create function public.announce_event(p_event_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.announce_event_impl(p_event_id) $$;

select private.grant_rpc('announce_event', 'authenticated');

-- The planner from launch_ready, holding back quiet nights.
create or replace function private.plan_notifications()
returns void language plpgsql set search_path = '' as $$
declare
  a record;
  v_title text;
  -- The club's own clock, for telling today from tomorrow.
  v_zone  text := 'America/Chicago';
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
-- 2. Guest names: first name and last initial
-- ---------------------------------------------------------------------------

-- "daniel smith" -> "Daniel S.", "Daniel S" -> "Daniel S.", "Zola" -> "Zola".
create function private.tidy_guest_name(p_name text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v_words text[] := regexp_split_to_array(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), ' ');
  v_first text := v_words[1];
  v_last  text := v_words[array_length(v_words, 1)];
begin
  if v_first is null or v_first = '' then
    return btrim(coalesce(p_name, ''));
  end if;
  v_first := upper(left(v_first, 1)) || substr(v_first, 2);
  if array_length(v_words, 1) = 1 then
    return v_first;
  end if;
  return v_first || ' ' || upper(left(v_last, 1)) || '.';
end;
$$;

revoke all on function private.tidy_guest_name(text) from public, anon, authenticated, service_role;

create function private.tidy_guest_row()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.display_name := private.tidy_guest_name(new.display_name);
  return new;
end;
$$;

revoke all on function private.tidy_guest_row() from public, anon, authenticated, service_role;

create trigger tidy_name before insert or update of display_name on public.guests
  for each row execute function private.tidy_guest_row();

update public.guests set display_name = display_name
where display_name is distinct from private.tidy_guest_name(display_name);
