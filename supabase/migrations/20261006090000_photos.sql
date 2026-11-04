-- Opening Night v3 — event photos.
--
-- Files live in the private event-photos bucket and are only ever served
-- through short-lived signed URLs. An object's path says whose it is:
--
--   <event id>/<uploader member id>/<file>.jpg
--
--   upload   a member who has been checked in to that event, into their own
--            folder, from the moment of check-in. Guests have no account and
--            so cannot upload.
--   view     every current member, including those who were not there.
--   delete   the uploader, or Dino.
--
-- public.event_media is the list the app shows. A row is added only through
-- register_event_photo, after the file is in the bucket, and removed only
-- through delete_event_photo.
--
--   authenticated (member)  register_event_photo, delete_event_photo

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-photos', 'event-photos', false, 10485760, array['image/jpeg'])
on conflict (id) do nothing;

-- Splits and checks an object name. Returns (event_id, member_id) as text,
-- or nulls when the name is not <uuid>/<uuid>/<file>.jpg.
create function private.photo_path_parts(p_name text, out event_id text, out member_id text)
language plpgsql immutable set search_path = '' as $$
declare v_match text[];
begin
  v_match := regexp_match(p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[A-Za-z0-9_-]{1,64}\.jpg$');
  if v_match is not null then
    event_id := v_match[1];
    member_id := v_match[2];
  end if;
end;
$$;

-- SECURITY DEFINER: the storage policies run as the caller, who cannot read
-- other people's participant rows. Each reports only on the caller.
create function private.can_upload_event_photo(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from private.photo_path_parts(p_name) x
    join public.event_participants p on p.event_id::text = x.event_id
    where x.member_id = private.current_member_id()::text
      and p.member_id = private.current_member_id()
      and p.checked_in_at is not null)
$$;

create function private.can_delete_event_photo(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_owner_id() is not null
      or exists (select 1 from private.photo_path_parts(p_name) x
                 where x.member_id = private.current_member_id()::text)
$$;

revoke all on function private.photo_path_parts(text) from public, anon, authenticated, service_role;
revoke all on function private.can_upload_event_photo(text) from public, anon, authenticated, service_role;
revoke all on function private.can_delete_event_photo(text) from public, anon, authenticated, service_role;
grant execute on function private.can_upload_event_photo(text) to authenticated;
grant execute on function private.can_delete_event_photo(text) to authenticated;

create policy "members view event photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'event-photos' and (select private.current_member_id()) is not null);
create policy "checked-in members upload event photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'event-photos' and private.can_upload_event_photo(name));
create policy "uploader or owner deletes event photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'event-photos' and private.can_delete_event_photo(name));

create function private.register_event_photo_impl(
  p_event_id uuid, p_storage_path text, p_width integer default null, p_height integer default null, p_byte_size bigint default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.require_member();
  v_id uuid;
begin
  if not exists (
    select 1 from private.photo_path_parts(p_storage_path) x
    where x.event_id = p_event_id::text and x.member_id = v_me::text
  ) then
    raise exception 'That photo is not in your folder for this event.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.event_participants p
    where p.event_id = p_event_id and p.member_id = v_me and p.checked_in_at is not null
  ) then
    raise exception 'Only people who were checked in can add photos.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'event-photos' and o.name = p_storage_path) then
    raise exception 'Upload the photo first.' using errcode = 'P0001';
  end if;

  insert into public.event_media (event_id, uploader_member_id, media_type, storage_path, mime_type, byte_size, width, height)
  values (p_event_id, v_me, 'photo', p_storage_path, 'image/jpeg', p_byte_size, p_width, p_height)
  returning id into v_id;
  return v_id;
end;
$$;

-- Removes the row and returns the storage path, which the caller then
-- deletes from the bucket (its delete policy allows exactly the same people).
create function private.delete_event_photo_impl(p_media_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_media public.event_media%rowtype;
begin
  select * into v_media from public.event_media em where em.id = p_media_id for update;
  if not found then
    raise exception 'That photo is already gone.' using errcode = 'P0002';
  end if;
  if v_media.uploader_member_id <> v_me then
    perform private.require_owner();
    perform private.write_audit('photo.deleted_by_owner', 'public.event_media', p_media_id,
      jsonb_build_object('event_id', v_media.event_id, 'uploader_member_id', v_media.uploader_member_id));
  end if;
  delete from public.event_media em where em.id = p_media_id;
  return v_media.storage_path;
end;
$$;

create function public.register_event_photo(
  p_event_id uuid, p_storage_path text, p_width integer default null, p_height integer default null, p_byte_size bigint default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.register_event_photo_impl(p_event_id, p_storage_path, p_width, p_height, p_byte_size) $$;

create function public.delete_event_photo(p_media_id uuid)
returns text language sql security invoker set search_path = ''
as $$ select private.delete_event_photo_impl(p_media_id) $$;

select private.grant_rpc('register_event_photo', 'authenticated');
select private.grant_rpc('delete_event_photo', 'authenticated');
