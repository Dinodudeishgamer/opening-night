-- Opening Night v3 — avatars, app settings, theaters, and the event itself.
--
-- Same two layers as before: public.<name> is a SECURITY INVOKER wrapper that
-- only calls private.<name>_impl, which is SECURITY DEFINER, does its own
-- authorization, and is the only write path. Members still hold no direct
-- write privilege on any table.
--
--   authenticated (member)  set_my_avatar
--   authenticated (Dino)    save_app_settings, save_theater, create_event,
--                           update_event, delete_event
--
-- Also here, for every later workflow migration: the shared helpers
-- (require_owner, require_member, lock_event, valid_score, notify,
-- event_changed, participant_attendance_changed, grant_rpc).

-- ---------------------------------------------------------------------------
-- 1. Shared helpers (no grants; called only from implementations)
-- ---------------------------------------------------------------------------

create function private.require_owner()
returns uuid language plpgsql stable set search_path = '' as $$
declare v_owner uuid := private.current_owner_id();
begin
  if v_owner is null then
    raise exception 'Only the organizer can do that.' using errcode = '42501';
  end if;
  return v_owner;
end;
$$;

create function private.require_member()
returns uuid language plpgsql stable set search_path = '' as $$
declare v_member uuid := private.current_member_id();
begin
  if v_member is null then
    raise exception 'You are not signed in as a member.' using errcode = '42501';
  end if;
  return v_member;
end;
$$;

-- Loads and locks the event row. Every workflow operation on an event starts
-- here, so two operations on the same event never interleave.
create function private.lock_event(p_event_id uuid)
returns public.events language plpgsql set search_path = '' as $$
declare v_event public.events%rowtype;
begin
  select * into v_event from public.events e where e.id = p_event_id for update;
  if not found then
    raise exception 'That event no longer exists.' using errcode = 'P0002';
  end if;
  return v_event;
end;
$$;

-- A score as the user typed it: 0.0-10.0 and already exact at one decimal.
-- numeric(3,1) would silently round 7.25 to 7.3, so this runs on the raw
-- value before any cast (see the comment on predictions.score).
create function private.valid_score(p_score numeric)
returns boolean language sql immutable set search_path = '' as $$
  select p_score is not null and p_score >= 0 and p_score <= 10 and p_score = round(p_score, 1)
$$;

-- Writes one inbox notification for an active member. A dedupe_key makes the
-- write idempotent per recipient: the same reminder is never stored twice.
-- Push delivery is queued from the inbox row by the notifications migration.
create function private.notify(
  p_member_id uuid, p_event_id uuid, p_kind text, p_title text, p_body text,
  p_data jsonb default '{}'::jsonb, p_dedupe_key text default null
)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.notifications (recipient_member_id, event_id, kind, title, body, data, dedupe_key)
  select m.id, p_event_id, p_kind, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key
  from public.members m
  where m.id = p_member_id and m.status = 'active'
  on conflict (recipient_member_id, dedupe_key) do nothing;
end;
$$;

-- Called after anything that can move an event's derived state (an RSVP, a
-- ballot, a deadline passing). The voting migration replaces the body with
-- the automatic close; until then there is nothing to derive.
create function private.event_changed(p_event_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  null;
end;
$$;

-- Called after a participant's attendance changes (confirmation, check-in).
-- The payments migration replaces the body to keep charges in step.
create function private.participant_attendance_changed(p_participant_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  null;
end;
$$;

-- Migration utility: sets the grants of an RPC pair in one place. Revokes
-- everything on public.<name> and private.<name>_impl from every API role,
-- then grants EXECUTE on both to exactly one role. Only migrations call it.
create function private.grant_rpc(p_name text, p_role text)
returns void language plpgsql set search_path = '' as $$
declare
  r record;
  v_count integer := 0;
begin
  if p_role not in ('authenticated', 'service_role') then
    raise exception 'grant_rpc: unexpected role %', p_role;
  end if;
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname = p_name)
       or (n.nspname = 'private' and p.proname = p_name || '_impl')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
    execute format('grant execute on function %s to %I', r.sig, p_role);
    v_count := v_count + 1;
  end loop;
  if v_count <> 2 then
    raise exception 'grant_rpc: expected one wrapper and one implementation for %, found %', p_name, v_count;
  end if;
end;
$$;

revoke all on function private.require_owner() from public, anon, authenticated, service_role;
revoke all on function private.require_member() from public, anon, authenticated, service_role;
revoke all on function private.lock_event(uuid) from public, anon, authenticated, service_role;
revoke all on function private.valid_score(numeric) from public, anon, authenticated, service_role;
revoke all on function private.notify(uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.event_changed(uuid) from public, anon, authenticated, service_role;
revoke all on function private.participant_attendance_changed(uuid) from public, anon, authenticated, service_role;
revoke all on function private.grant_rpc(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Avatars
-- ---------------------------------------------------------------------------

-- initials (the default, derived from the name Dino set), an emoji, or an
-- uploaded photo in the private avatars bucket. Members choose their own
-- avatar; they still cannot touch their name.
alter table public.members
  add column avatar_kind  text not null default 'initials',
  add column avatar_emoji text,
  add column avatar_path  text,
  add constraint members_avatar_check check (
    (avatar_kind = 'initials' and avatar_emoji is null and avatar_path is null)
    or (avatar_kind = 'emoji' and avatar_emoji is not null and char_length(avatar_emoji) between 1 and 16 and avatar_path is null)
    or (avatar_kind = 'photo' and avatar_path is not null and avatar_emoji is null));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg'])
on conflict (id) do nothing;

-- Objects live at <member id>/<file>.jpg. Any active member can view; a
-- member writes only inside their own folder.
create policy "members read avatars" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (select private.current_member_id()) is not null);
create policy "members upload own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select private.current_member_id())::text);
create policy "members replace own avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select private.current_member_id())::text)
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select private.current_member_id())::text);
create policy "members delete own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select private.current_member_id())::text);

create function private.set_my_avatar_impl(p_kind text, p_emoji text default null, p_path text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_member();
begin
  if p_kind is null or p_kind not in ('initials', 'emoji', 'photo') then
    raise exception 'Avatar must be initials, an emoji, or a photo.' using errcode = '22023';
  end if;
  if p_kind = 'photo' and (p_path is null or p_path !~ ('^' || v_me::text || '/[A-Za-z0-9_-]{1,64}\.jpg$')) then
    raise exception 'That photo is not in your avatar folder.' using errcode = '22023';
  end if;
  if p_kind = 'emoji' and (p_emoji is null or btrim(p_emoji) = '') then
    raise exception 'Pick an emoji.' using errcode = '22023';
  end if;
  update public.members m
  set avatar_kind = p_kind,
      avatar_emoji = case when p_kind = 'emoji' then btrim(p_emoji) end,
      avatar_path = case when p_kind = 'photo' then p_path end
  where m.id = v_me;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. App settings: where members send money
-- ---------------------------------------------------------------------------

create function private.save_app_settings_impl(
  p_venmo_username text, p_apple_cash_recipient text, p_payment_note text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := private.require_owner();
begin
  insert into public.app_settings as s (id, venmo_username, apple_cash_recipient, payment_note, updated_by_member_id)
  values (true, nullif(btrim(p_venmo_username), ''), nullif(btrim(p_apple_cash_recipient), ''),
          nullif(btrim(p_payment_note), ''), v_owner)
  on conflict (id) do update
    set venmo_username = excluded.venmo_username,
        apple_cash_recipient = excluded.apple_cash_recipient,
        payment_note = excluded.payment_note,
        updated_by_member_id = excluded.updated_by_member_id;
  perform private.write_audit('settings.saved', 'public.app_settings', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Theaters
-- ---------------------------------------------------------------------------

create function private.save_theater_impl(
  p_theater_id uuid, p_name text, p_address text default null, p_time_zone text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_id    uuid;
begin
  if p_time_zone is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_time_zone) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  if p_theater_id is null then
    insert into public.theaters (name, address, time_zone)
    values (btrim(p_name), nullif(btrim(p_address), ''), coalesce(p_time_zone, 'America/Chicago'))
    returning id into v_id;
  else
    update public.theaters t
    set name = btrim(p_name), address = nullif(btrim(p_address), ''),
        time_zone = coalesce(p_time_zone, t.time_zone)
    where t.id = p_theater_id
    returning t.id into v_id;
    if v_id is null then
      raise exception 'That theater no longer exists.' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Events
-- ---------------------------------------------------------------------------

-- What Dino chooses or writes for one event. The movie row keeps what TMDB
-- said; these override it for this event only.
--   poster_path / backdrop_path   the TMDB images he picked
--   title_override / description_override
--   owner_note                    "Dino's Note", shown separately
-- And the workflow state the later migrations use:
--   voting_closed_at     set when voting closes (by Dino or automatically)
--   voting_reopened_at   set when Dino reopens it; see the voting migration
--   schedule_revision    0 until a showtime is selected, then +1 on every
--                        change to the selected showtime; calendar entries
--                        and reminders are keyed on it
--   total_cost_cents     what Dino paid for the tickets
alter table public.events
  add column poster_path          text,
  add column backdrop_path        text,
  add column title_override       text,
  add column description_override text,
  add column owner_note           text,
  add column voting_closed_at     timestamptz,
  add column voting_reopened_at   timestamptz,
  add column schedule_revision    integer not null default 0,
  add column total_cost_cents     integer,
  add constraint events_title_override_check
    check (title_override is null or (title_override = btrim(title_override) and char_length(title_override) between 1 and 200)),
  add constraint events_description_override_check check (char_length(description_override) <= 4000),
  add constraint events_owner_note_check check (char_length(owner_note) <= 2000),
  add constraint events_schedule_revision_check check (schedule_revision >= 0),
  add constraint events_total_cost_check check (total_cost_cents >= 0),
  add constraint events_cost_needs_purchase_check
    check (total_cost_cents is null or tickets_purchased_at is not null);

-- TMDB paths look like "/abc123.jpg". Anything else is refused so a stored
-- path can only ever be appended to the TMDB image host.
create function private.clean_tmdb_path(p_path text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if p_path is null or btrim(p_path) = '' then
    return null;
  end if;
  if p_path !~ '^/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$' then
    raise exception 'That is not a TMDB image path.' using errcode = '22023';
  end if;
  return p_path;
end;
$$;

revoke all on function private.clean_tmdb_path(text) from public, anon, authenticated, service_role;

-- p_movie is what the TMDB proxy returned for the movie Dino picked:
--   { tmdb_id, title, release_date, runtime_minutes, overview, poster_path,
--     backdrop_path, metadata }
-- The movie row is created or refreshed by tmdb_id. No date or time is set
-- here: an event has none until a showtime is selected.
create function private.create_event_impl(
  p_movie jsonb,
  p_rsvp_deadline timestamptz,
  p_poster_path text default null,
  p_backdrop_path text default null,
  p_title_override text default null,
  p_description_override text default null,
  p_owner_note text default null
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

  perform private.notify(m.id, v_event, 'event_created', 'New movie night: ' || coalesce(nullif(btrim(p_title_override), ''), v_title),
                         'Are you in? RSVP in the app.', jsonb_build_object('event_id', v_event), 'event_created:' || v_event)
  from public.members m where m.status = 'active' and m.id <> v_owner;

  perform private.write_audit('event.created', 'public.events', v_event, jsonb_build_object('title', v_title));
  return v_event;
end;
$$;

-- p_patch holds only the fields to change; a key present with null clears
-- it. Allowed keys: rsvp_deadline, poster_path, backdrop_path,
-- title_override, description_override, owner_note. The RSVP deadline can
-- move only while no showtime is selected (selection closes RSVP for good).
create function private.update_event_impl(p_event_id uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_key   text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Nothing to change.' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('rsvp_deadline', 'poster_path', 'backdrop_path', 'title_override', 'description_override', 'owner_note') then
      raise exception 'Cannot change %.', v_key using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'rsvp_deadline' then
    if v_event.selected_showtime_id is not null then
      raise exception 'RSVP closed when the showtime was selected.' using errcode = 'P0001';
    end if;
    if nullif(p_patch ->> 'rsvp_deadline', '') is null then
      raise exception 'Every event needs an RSVP deadline.' using errcode = '22023';
    end if;
    update public.events e set rsvp_deadline = (p_patch ->> 'rsvp_deadline')::timestamptz where e.id = p_event_id;
  end if;

  update public.events e
  set poster_path = case when p_patch ? 'poster_path' then private.clean_tmdb_path(p_patch ->> 'poster_path') else e.poster_path end,
      backdrop_path = case when p_patch ? 'backdrop_path' then private.clean_tmdb_path(p_patch ->> 'backdrop_path') else e.backdrop_path end,
      title_override = case when p_patch ? 'title_override' then nullif(btrim(p_patch ->> 'title_override'), '') else e.title_override end,
      description_override = case when p_patch ? 'description_override' then nullif(btrim(p_patch ->> 'description_override'), '') else e.description_override end,
      owner_note = case when p_patch ? 'owner_note' then nullif(btrim(p_patch ->> 'owner_note'), '') else e.owner_note end
  where e.id = p_event_id;

  perform private.write_audit('event.updated', 'public.events', p_event_id,
    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));
  perform private.event_changed(p_event_id);
end;
$$;

-- The movie night will not happen: the event and everything that hangs off
-- it (showtimes, participants, guests, picks, scores, charges, media rows,
-- notifications) goes. Only the audit entry remains. Storage objects are
-- removed by the app before it calls this; the returned paths are what was
-- still registered, so the caller can finish the job.
create function private.delete_event_impl(p_event_id uuid)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_paths text[];
begin
  select coalesce(array_agg(em.storage_path), '{}') into v_paths
  from public.event_media em where em.event_id = p_event_id;
  delete from public.events e where e.id = p_event_id;
  perform private.write_audit('event.deleted', 'public.events', p_event_id,
    jsonb_build_object('movie_id', v_event.movie_id, 'had_tickets', v_event.tickets_purchased_at is not null));
  return v_paths;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Public RPCs and grants
-- ---------------------------------------------------------------------------

create function public.set_my_avatar(p_kind text, p_emoji text default null, p_path text default null)
returns void language sql security invoker set search_path = ''
as $$ select private.set_my_avatar_impl(p_kind, p_emoji, p_path) $$;

create function public.save_app_settings(p_venmo_username text, p_apple_cash_recipient text, p_payment_note text)
returns void language sql security invoker set search_path = ''
as $$ select private.save_app_settings_impl(p_venmo_username, p_apple_cash_recipient, p_payment_note) $$;

create function public.save_theater(p_theater_id uuid, p_name text, p_address text default null, p_time_zone text default null)
returns uuid language sql security invoker set search_path = ''
as $$ select private.save_theater_impl(p_theater_id, p_name, p_address, p_time_zone) $$;

create function public.create_event(
  p_movie jsonb, p_rsvp_deadline timestamptz, p_poster_path text default null, p_backdrop_path text default null,
  p_title_override text default null, p_description_override text default null, p_owner_note text default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_event_impl(p_movie, p_rsvp_deadline, p_poster_path, p_backdrop_path,
                                        p_title_override, p_description_override, p_owner_note) $$;

create function public.update_event(p_event_id uuid, p_patch jsonb)
returns void language sql security invoker set search_path = ''
as $$ select private.update_event_impl(p_event_id, p_patch) $$;

create function public.delete_event(p_event_id uuid)
returns text[] language sql security invoker set search_path = ''
as $$ select private.delete_event_impl(p_event_id) $$;

select private.grant_rpc('set_my_avatar', 'authenticated');
select private.grant_rpc('save_app_settings', 'authenticated');
select private.grant_rpc('save_theater', 'authenticated');
select private.grant_rpc('create_event', 'authenticated');
select private.grant_rpc('update_event', 'authenticated');
select private.grant_rpc('delete_event', 'authenticated');
