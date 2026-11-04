-- Opening Night v3 — RSVP and guests.
--
--   Going / Maybe / Can't Go          rsvp_status going / maybe / cant_go
--
-- Before the deadline a member changes their own answer freely. RSVP closes
-- at events.rsvp_deadline, or earlier when Dino selects a showtime (which
-- pulls the deadline in to that moment). After that members cannot edit, an
-- unanswered member counts as Can't Go, and only Dino adds or overrides.
--
-- Guests are named people a member brings to one event. The host adds,
-- renames, and removes them until RSVP closes. A member with a guest cannot
-- switch to Can't Go until the guest is removed, and Dino's overrides are
-- held to the same rule, so a guest is never left without a host who is
-- coming.
--
--   authenticated (member)  set_rsvp, add_guest, update_guest, remove_guest
--                           for themselves; the same functions accept another
--                           member only from Dino, at any time, audited.

-- Whether members may still edit their own RSVP and guests.
create function private.rsvp_open(p_event public.events)
returns boolean language sql stable set search_path = '' as $$
  select p_event.selected_showtime_id is null and p_event.ended_at is null and now() < p_event.rsvp_deadline
$$;

-- Once RSVP has closed, everyone active who never answered is Can't Go. This
-- writes that down so rosters and history say so explicitly. Idempotent.
create function private.settle_rsvp(p_event_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.event_participants as p (event_id, member_id, rsvp_status, rsvp_updated_at)
  select p_event_id, m.id, 'cant_go', now()
  from public.members m
  where m.status = 'active'
  on conflict (event_id, member_id) do update
    set rsvp_status = 'cant_go', rsvp_updated_at = now()
    where p.rsvp_status is null;
end;
$$;

revoke all on function private.rsvp_open(public.events) from public, anon, authenticated, service_role;
revoke all on function private.settle_rsvp(uuid) from public, anon, authenticated, service_role;

-- p_member_id null means the caller. Anyone else is Dino overriding.
create function private.set_rsvp_impl(p_event_id uuid, p_status text, p_member_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me     uuid := private.require_member();
  v_target uuid := coalesce(p_member_id, v_me);
  v_event  public.events%rowtype := private.lock_event(p_event_id);
  v_old    text;
begin
  if p_status is null or p_status not in ('going', 'maybe', 'cant_go') then
    raise exception 'RSVP is Going, Maybe, or Can''t Go.' using errcode = '22023';
  end if;
  if v_target <> v_me then
    perform private.require_owner();
    if not exists (select 1 from public.members m where m.id = v_target and m.status = 'active') then
      raise exception 'That member is not active.' using errcode = '22023';
    end if;
  end if;
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  -- Dino may answer late for anyone, himself included. Members may not.
  if private.current_owner_id() is null and not private.rsvp_open(v_event) then
    raise exception 'RSVP is closed. Ask Dino if your plans changed.' using errcode = 'P0001';
  end if;
  if p_status = 'cant_go' and exists (
    select 1 from public.guests g where g.event_id = p_event_id and g.host_member_id = v_target
  ) then
    raise exception 'Remove the guest first: a guest needs a host who is coming.' using errcode = 'P0001';
  end if;

  select p.rsvp_status into v_old
  from public.event_participants p where p.event_id = p_event_id and p.member_id = v_target;

  insert into public.event_participants as p (event_id, member_id, rsvp_status, rsvp_updated_at)
  values (p_event_id, v_target, p_status, now())
  on conflict (event_id, member_id) do update
    set rsvp_status = excluded.rsvp_status, rsvp_updated_at = excluded.rsvp_updated_at;

  if v_target <> v_me or not private.rsvp_open(v_event) then
    perform private.write_audit('rsvp.overridden', 'public.event_participants', null,
      jsonb_build_object('event_id', p_event_id, 'member_id', v_target, 'from', v_old, 'to', p_status));
  end if;
  perform private.event_changed(p_event_id);
end;
$$;

-- p_host_member_id null means the caller hosts. A guest starts as Going or
-- Maybe; a host who is not coming cannot bring one.
create function private.add_guest_impl(
  p_event_id uuid, p_name text, p_status text default 'going', p_host_member_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_host  uuid := coalesce(p_host_member_id, v_me);
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_owner boolean := private.current_owner_id() is not null;
  v_guest uuid;
begin
  if v_host <> v_me then
    perform private.require_owner();
  end if;
  if p_status is null or p_status not in ('going', 'maybe') then
    raise exception 'A guest is Going or Maybe.' using errcode = '22023';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'A guest needs a name.' using errcode = '22023';
  end if;
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if not v_owner and not private.rsvp_open(v_event) then
    raise exception 'RSVP is closed. Ask Dino to add a guest.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.event_participants p
    where p.event_id = p_event_id and p.member_id = v_host and p.rsvp_status in ('going', 'maybe')
  ) then
    raise exception 'RSVP Going or Maybe before bringing a guest.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.guests g where g.event_id = p_event_id and g.host_member_id = v_host) >= 6 then
    raise exception 'That is a lot of guests. Talk to Dino.' using errcode = 'P0001';
  end if;

  insert into public.guests (display_name, host_member_id, event_id)
  values (btrim(p_name), v_host, p_event_id)
  returning id into v_guest;
  insert into public.event_participants (event_id, guest_id, rsvp_status, rsvp_updated_at)
  values (p_event_id, v_guest, p_status, now());

  if v_host <> v_me or not private.rsvp_open(v_event) then
    perform private.write_audit('guest.added_by_owner', 'public.guests', v_guest,
      jsonb_build_object('event_id', p_event_id, 'host_member_id', v_host));
  end if;
  perform private.event_changed(p_event_id);
  return v_guest;
end;
$$;

-- Loads a guest and checks the caller may change it: its host while RSVP is
-- open, or Dino at any time before the event ends. Returns the guest row.
create function private.guest_for_edit(p_guest_id uuid)
returns public.guests language plpgsql set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_guest public.guests%rowtype;
  v_event public.events%rowtype;
begin
  select * into v_guest from public.guests g where g.id = p_guest_id;
  if not found then
    raise exception 'That guest no longer exists.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_guest.event_id);
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if private.current_owner_id() is not null then
    return v_guest;
  end if;
  if v_guest.host_member_id <> v_me then
    raise exception 'Only the host can change a guest.' using errcode = '42501';
  end if;
  if not private.rsvp_open(v_event) then
    raise exception 'RSVP is closed. Ask Dino to change a guest.' using errcode = 'P0001';
  end if;
  return v_guest;
end;
$$;

revoke all on function private.guest_for_edit(uuid) from public, anon, authenticated, service_role;

create function private.update_guest_impl(p_guest_id uuid, p_name text, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_guest public.guests%rowtype := private.guest_for_edit(p_guest_id);
begin
  if p_status is null or p_status not in ('going', 'maybe') then
    raise exception 'A guest is Going or Maybe. Remove them if they cannot come.' using errcode = '22023';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'A guest needs a name.' using errcode = '22023';
  end if;
  update public.guests g set display_name = btrim(p_name) where g.id = p_guest_id;
  update public.event_participants p
  set rsvp_status = p_status, rsvp_updated_at = now()
  where p.guest_id = p_guest_id and p.rsvp_status is distinct from p_status;
  perform private.event_changed(v_guest.event_id);
end;
$$;

-- Removes the guest and everything recorded for them at this event (picks,
-- prediction, charge). Dino removing a guest who already has a charge is
-- audited with the amount.
create function private.remove_guest_impl(p_guest_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_guest public.guests%rowtype := private.guest_for_edit(p_guest_id);
  v_me    uuid := private.current_member_id();
begin
  if v_guest.host_member_id <> v_me then
    perform private.write_audit('guest.removed_by_owner', 'public.guests', p_guest_id,
      jsonb_build_object('event_id', v_guest.event_id, 'host_member_id', v_guest.host_member_id,
        'charge_cents', (select c.amount_cents from public.charges c
                         join public.event_participants p on p.id = c.participant_id where p.guest_id = p_guest_id)));
  end if;
  delete from public.event_participants p where p.guest_id = p_guest_id;
  delete from public.guests g where g.id = p_guest_id;
  perform private.event_changed(v_guest.event_id);
end;
$$;

create function public.set_rsvp(p_event_id uuid, p_status text, p_member_id uuid default null)
returns void language sql security invoker set search_path = ''
as $$ select private.set_rsvp_impl(p_event_id, p_status, p_member_id) $$;

create function public.add_guest(p_event_id uuid, p_name text, p_status text default 'going', p_host_member_id uuid default null)
returns uuid language sql security invoker set search_path = ''
as $$ select private.add_guest_impl(p_event_id, p_name, p_status, p_host_member_id) $$;

create function public.update_guest(p_guest_id uuid, p_name text, p_status text)
returns void language sql security invoker set search_path = ''
as $$ select private.update_guest_impl(p_guest_id, p_name, p_status) $$;

create function public.remove_guest(p_guest_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.remove_guest_impl(p_guest_id) $$;

select private.grant_rpc('set_rsvp', 'authenticated');
select private.grant_rpc('add_guest', 'authenticated');
select private.grant_rpc('update_guest', 'authenticated');
select private.grant_rpc('remove_guest', 'authenticated');
