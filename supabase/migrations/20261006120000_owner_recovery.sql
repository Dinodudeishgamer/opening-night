-- Opening Night v3 — a way back in for the owner.
--
-- The app deliberately cannot reset the owner's access (reset_member_access
-- refuses, so a slip can never lock the group out of its organizer). But
-- that left no way back if Dino himself loses his phone number: nobody else
-- can issue him an invite, and making one by hand needs the invite-code HMAC
-- secret, which cannot be read back out of Supabase.
--
-- The bootstrap function already knows how to issue the owner an invite
-- through the Edge runtime (which holds that secret). It refused once any
-- claim had ever existed. It now refuses only while the owner HOLDS a live
-- claim:
--
--   no members                     creates the owner and an invite   (as before)
--   owner with no live claim       issues the owner a new invite
--   owner with a live claim        refused
--
-- This does not reopen anything. service_role's EXECUTE on this function is
-- still revoked by the close_owner_bootstrap trigger the moment the owner's
-- claim is written, and nothing grants it back. Recovery is therefore a
-- deliberate, database-administrator action, documented in
-- docs/operations.md: revoke the owner's claim and re-grant EXECUTE in the
-- SQL editor, run the bootstrap script, sign in. The new claim fires the
-- same trigger and closes it again.
create or replace function private.bootstrap_owner_invite_impl(
  p_first_name text,
  p_last_initial text,
  p_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member  uuid;
  v_invite  uuid;
  v_expires timestamptz := now() + interval '7 days';
  v_mode    text;
begin
  lock table public.members in share row exclusive mode;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invite code hash must be 64 hex characters' using errcode = '22023';
  end if;

  if not exists (select 1 from public.members) then
    insert into public.members (first_name, last_initial, role, status)
    values (btrim(p_first_name), upper(btrim(p_last_initial)), 'owner', 'active')
    returning id into v_member;
    v_mode := 'created';
  else
    select m.id into v_member from public.members m where m.role = 'owner' for update;
    if v_member is null or exists (
      select 1 from private.auth_claims c where c.member_id = v_member and c.revoked_at is null
    ) then
      return jsonb_build_object('outcome', 'already_bootstrapped');
    end if;
    -- The name can still be corrected while the owner is the only member;
    -- after that it is part of the club's history and is left alone.
    if (select count(*) from public.members) = 1 then
      update public.members m
      set first_name = btrim(p_first_name), last_initial = upper(btrim(p_last_initial))
      where m.id = v_member;
    end if;
    update private.member_invites i
    set revoked_at = now()
    where i.member_id = v_member and i.redeemed_at is null and i.revoked_at is null;
    v_mode := 'reissued';
  end if;

  insert into private.member_invites (member_id, code_hash, created_by_member_id, expires_at)
  values (v_member, p_code_hash, null, v_expires)
  returning id into v_invite;

  perform private.write_audit('owner.bootstrap_' || v_mode, 'public.members', v_member,
    jsonb_build_object('invite_id', v_invite, 'expires_at', v_expires));
  return jsonb_build_object('outcome', 'ok', 'mode', v_mode, 'member_id', v_member, 'expires_at', v_expires);
end;
$$;

-- CREATE OR REPLACE keeps the existing grants; restated so this file says
-- what they are. Whether service_role still holds EXECUTE is decided by the
-- close_owner_bootstrap trigger, not here: nothing is granted.
revoke all on function private.bootstrap_owner_invite_impl(text, text, text) from public, anon, authenticated;
