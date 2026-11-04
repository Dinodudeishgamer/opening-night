-- Opening Night v3 — removing a member with no history deletes them.
--
-- "Remove" used to always keep the member row, marked removed, so that the
-- movie nights they were part of could still show their name. That is right
-- for someone who has been to a movie night. For someone who never has (a
-- name added by mistake, a test member, Apple's reviewer) there is nothing to
-- keep, and they sat in Dino's member list for ever.
--
-- Now: removing a member first does everything it did before (status, open
-- invites, logins). Then it tries to delete them outright: their logins, the
-- Auth users behind those, their invites, notifications and devices. If
-- anything about a movie night still points at them, the foreign keys refuse,
-- the attempt is undone, and they stay as a removed member exactly as before.
-- The database decides, so there is no list of "what counts as history" here
-- to fall out of date.
--
-- The body below is set_member_status_impl from member_access with that
-- attempt added at the end.
create or replace function private.set_member_status_impl(p_member_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := private.current_owner_id();
  v_member  public.members%rowtype;
  v_claims  integer := 0;
  v_invites integer := 0;
  v_users   uuid[];
  v_deleted boolean := false;
begin
  if v_owner is null then
    raise exception 'only the owner can change member status' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'deactivated', 'removed') then
    raise exception 'status is active, deactivated, or removed' using errcode = '22023';
  end if;
  select * into v_member from public.members m where m.id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = 'P0002';
  end if;
  if v_member.role = 'owner' then
    raise exception 'the owner''s status cannot change' using errcode = '42501';
  end if;
  if v_member.status = p_status then
    return;
  end if;

  update public.members m set status = p_status where m.id = p_member_id;

  if p_status in ('deactivated', 'removed') then
    update private.member_invites i
    set revoked_at = now()
    where i.member_id = p_member_id and i.redeemed_at is null and i.revoked_at is null;
    get diagnostics v_invites = row_count;
  end if;
  if p_status = 'removed' then
    update private.auth_claims c
    set revoked_at = now(), revoked_by_member_id = v_owner
    where c.member_id = p_member_id and c.revoked_at is null;
    get diagnostics v_claims = row_count;

    -- Nothing on any movie night points at them? Then they are gone entirely.
    begin
      select array_agg(c.auth_user_id) into v_users from private.auth_claims c where c.member_id = p_member_id;
      delete from private.auth_claims c where c.member_id = p_member_id;
      delete from public.members m where m.id = p_member_id;
      delete from auth.users u where u.id = any (coalesce(v_users, '{}'::uuid[]));
      v_deleted := true;
    -- ON DELETE RESTRICT reports as one or the other, depending on the Postgres version.
    exception when foreign_key_violation or restrict_violation then
      v_deleted := false;
    end;
  end if;

  if v_deleted then
    perform private.write_audit('member.deleted', 'public.members', p_member_id,
      jsonb_build_object('first_name', v_member.first_name, 'last_initial', v_member.last_initial,
                         'claims_removed', coalesce(array_length(v_users, 1), 0)));
  else
    perform private.write_audit('member.status_changed', 'public.members', p_member_id,
      jsonb_build_object('from', v_member.status, 'to', p_status,
                         'claims_revoked', v_claims, 'invites_revoked', v_invites));
  end if;
end;
$$;
