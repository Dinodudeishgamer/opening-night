-- Opening Night v3 — Dino's announcements can expire, and he can take them back.
--
-- An announcement ("Doors at 7") is one notification row per member, all
-- sharing the dedupe key 'announcement:<batch>'. Until now it sat in every
-- Inbox for 30 days whatever it said. Two changes:
--
--   expiry    send_notification takes an optional p_expires_at. Past that
--             moment the row is simply not readable by its recipient: the
--             read policy says so, so it leaves the Inbox and the unread
--             count without anything having to run. Null means "until Dino
--             removes it" (and the Inbox still drops anything after 30 days).
--   removal   remove_announcement deletes the whole batch, for everyone.
--             A push that already reached a lock screen cannot be recalled;
--             this clears it from every Inbox.
--
-- list_announcements gives Dino what he has sent lately, with how many
-- members have opened their Inbox since, so he can see whether it landed.
--
-- expires_at is a column on every notification, but only announcements set
-- it. The app's own reminders tidy themselves by other rules (lib/inbox.ts).

alter table public.notifications
  add column expires_at timestamptz;

-- Same rule as before, plus: not past its expiry.
drop policy "read own notifications" on public.notifications;
create policy "read own notifications" on public.notifications
  for select to authenticated
  using (
    recipient_member_id = (select private.current_member_id())
    and (expires_at is null or expires_at > now())
  );

-- ---------------------------------------------------------------------------
-- Sending, with an optional expiry
-- ---------------------------------------------------------------------------

drop function public.send_notification(text, text, uuid, uuid[]);
drop function private.send_notification_impl(text, text, uuid, uuid[]);

create function private.send_notification_impl(
  p_title text, p_body text default null, p_event_id uuid default null, p_member_ids uuid[] default null,
  p_expires_at timestamptz default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_count integer;
  v_batch text := gen_random_uuid()::text;
begin
  if p_title is null or btrim(p_title) = '' or char_length(p_title) > 120 or char_length(coalesce(p_body, '')) > 500 then
    raise exception 'A notification needs a short title.' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'An announcement has to last at least a little while.' using errcode = '22023';
  end if;
  if p_event_id is not null and not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'That event no longer exists.' using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.members m
  where m.status = 'active' and (p_member_ids is null or m.id = any (p_member_ids));
  perform private.notify(m.id, p_event_id, 'announcement', btrim(p_title), nullif(btrim(p_body), ''),
                         case when p_event_id is null then '{}'::jsonb else jsonb_build_object('event_id', p_event_id) end,
                         'announcement:' || v_batch)
  from public.members m
  where m.status = 'active' and (p_member_ids is null or m.id = any (p_member_ids));
  if p_expires_at is not null then
    update public.notifications n set expires_at = p_expires_at
    where n.kind = 'announcement' and n.dedupe_key = 'announcement:' || v_batch;
  end if;
  perform private.write_audit('notification.sent', 'public.notifications', null,
    jsonb_build_object('recipients', v_count, 'event_id', p_event_id, 'batch', v_batch, 'expires_at', p_expires_at));
  return v_count;
end;
$$;

create function public.send_notification(
  p_title text, p_body text default null, p_event_id uuid default null, p_member_ids uuid[] default null,
  p_expires_at timestamptz default null
)
returns integer language sql security invoker set search_path = ''
as $$ select private.send_notification_impl(p_title, p_body, p_event_id, p_member_ids, p_expires_at) $$;

-- ---------------------------------------------------------------------------
-- What Dino has sent, and taking one back
-- ---------------------------------------------------------------------------

-- The last 30 days of announcements, newest first, expired ones included (so
-- Dino can see that they did expire). `seen` counts members whose copy has
-- been marked read, which happens when they open their Inbox.
create function private.list_announcements_impl()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_owner();
  return coalesce((
    select jsonb_agg(to_jsonb(a) order by a.sent_at desc)
    from (
      select substr(n.dedupe_key, length('announcement:') + 1) as batch,
             min(n.title) as title,
             min(n.body) as body,
             min(n.created_at) as sent_at,
             min(n.expires_at) as expires_at,
             count(*)::integer as recipients,
             count(n.read_at)::integer as seen
      from public.notifications n
      where n.kind = 'announcement' and n.dedupe_key like 'announcement:%'
        and n.created_at > now() - interval '30 days'
      group by n.dedupe_key
    ) a
  ), '[]'::jsonb);
end;
$$;

-- Removes one announcement from every Inbox. Reports how many copies went.
create function private.remove_announcement_impl(p_batch text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_count integer;
begin
  if p_batch is null or p_batch !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'That is not an announcement.' using errcode = '22023';
  end if;
  delete from public.notifications n
  where n.kind = 'announcement' and n.dedupe_key = 'announcement:' || p_batch;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'That announcement is already gone.' using errcode = 'P0002';
  end if;
  perform private.write_audit('notification.removed', 'public.notifications', null,
    jsonb_build_object('batch', p_batch, 'copies', v_count));
  return v_count;
end;
$$;

create function public.list_announcements()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.list_announcements_impl() $$;

create function public.remove_announcement(p_batch text)
returns integer language sql security invoker set search_path = ''
as $$ select private.remove_announcement_impl(p_batch) $$;

select private.grant_rpc('send_notification', 'authenticated');
select private.grant_rpc('list_announcements', 'authenticated');
select private.grant_rpc('remove_announcement', 'authenticated');
