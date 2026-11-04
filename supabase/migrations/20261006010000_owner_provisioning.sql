-- Opening Night v3 — owner provisioning, owner bootstrap, and "who am I".
--
-- Adds, in the same two-layer shape as member_access (public SECURITY INVOKER
-- wrapper, private SECURITY DEFINER implementation):
--
--   authenticated (Dino)   create_member_with_invite: a member and their
--                          invite in one transaction, so a failed invite
--                          never leaves a member nobody can reach.
--                          owner_member_access: who has a login, who has an
--                          open invite. No phone numbers leave the database.
--   authenticated (any)    whoami: the caller's own member row, or why they
--                          have none.
--   service_role           bootstrap_owner_invite: creates Dino's owner row
--                          and its invite, for the temporary owner-bootstrap
--                          Edge Function. See section 3 for how it closes.
--
-- The invite code is generated and hashed by the Edge Function; the database
-- still never sees a plaintext code.

-- ---------------------------------------------------------------------------
-- 1. Member and invite in one transaction
-- ---------------------------------------------------------------------------

-- Both steps are the existing implementations, each of which checks
-- current_owner_id() itself and writes its own audit row. Run from one
-- function they share a transaction: if the invite is refused, the member is
-- rolled back with it.
create function private.create_member_with_invite_impl(
  p_first_name text,
  p_last_initial text,
  p_code_hash text,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid;
  v_invite uuid;
begin
  if private.current_owner_id() is null then
    raise exception 'only the owner can create members' using errcode = '42501';
  end if;
  v_member := private.create_member_impl(p_first_name, p_last_initial, 'active');
  v_invite := private.create_member_invite_impl(v_member, p_code_hash, p_expires_at);
  return jsonb_build_object(
    'member_id', v_member,
    'invite_id', v_invite,
    'expires_at', (select i.expires_at from private.member_invites i where i.id = v_invite));
end;
$$;

-- For the owner's member list: login and invite state per member. Booleans
-- and an expiry only; the phone on a claim or invite is never returned.
create function private.owner_member_access_impl()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_owner_id() is null then
    raise exception 'only the owner can read member access' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'member_id', m.id,
      'has_login', exists (
        select 1 from private.auth_claims c where c.member_id = m.id and c.revoked_at is null),
      'invite_open', i.id is not null,
      'invite_expires_at', i.expires_at,
      'invite_started', i.phone_e164 is not null) order by m.created_at)
    from public.members m
    left join private.member_invites i
      on i.member_id = m.id and i.redeemed_at is null and i.revoked_at is null
     and (i.expires_at is null or i.expires_at > now())
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Who am I
-- ---------------------------------------------------------------------------

-- The app's first call after sign-in. Reports only on the caller.
--   ok          the caller's member row
--   no_member   signed in to Auth but not linked (or the link was revoked, or
--               the member is deactivated/removed). pending_invite says
--               whether complete_invite_claim would have something to do.
create function private.whoami_impl()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_phone  text;
begin
  select m.* into v_member from public.members m where m.id = private.current_member_id();
  if found then
    return jsonb_build_object(
      'outcome', 'ok',
      'member_id', v_member.id,
      'first_name', v_member.first_name,
      'last_initial', v_member.last_initial,
      'role', v_member.role);
  end if;
  v_phone := private.auth_user_verified_phone(auth.uid());
  return jsonb_build_object(
    'outcome', 'no_member',
    'pending_invite', v_phone is not null and exists (
      select 1 from private.member_invites i
      where i.phone_e164 = v_phone and i.redeemed_at is null and i.revoked_at is null
        and (i.expires_at is null or i.expires_at > now())));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Owner bootstrap through the same invite flow
-- ---------------------------------------------------------------------------

-- Dino gets in like everyone else: invite code, phone, SMS OTP. The only
-- special step is creating his owner row and first invite, when there is no
-- owner yet to do it. That step needs the invite-code HMAC secret, which only
-- the Edge runtime holds, so it runs in a temporary Edge Function
-- (owner-bootstrap, callable only with the project's secret key) that
-- generates the code and calls this as service_role.
--
-- It works only until the owner has signed in for the first time:
--   - no members at all       creates the owner and an invite
--   - only the owner exists,  replaces the invite (the first one expired or
--     never claimed           was lost) and may correct the name
--   - anything else           refused
-- Bootstrap invites expire after 7 days.
--
-- The surface then removes itself: when the owner's first claim is written,
-- a trigger revokes service_role's EXECUTE on both layers, in the same
-- transaction as the claim. After that no role can call it; the Edge Function
-- is deleted by the bootstrap script as soon as it has returned the code.
--
-- private.bootstrap_owner (member_access, run by hand, takes a precomputed
-- hash) is superseded by this and dropped: one bootstrap path, not two.
drop function private.bootstrap_owner(text, text, text, timestamptz);

create function private.bootstrap_owner_invite_impl(
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
  if exists (select 1 from private.auth_claims) then
    return jsonb_build_object('outcome', 'already_bootstrapped');
  end if;

  if not exists (select 1 from public.members) then
    insert into public.members (first_name, last_initial, role, status)
    values (btrim(p_first_name), upper(btrim(p_last_initial)), 'owner', 'active')
    returning id into v_member;
    v_mode := 'created';
  elsif (select count(*) from public.members) = 1
        and exists (select 1 from public.members m where m.role = 'owner') then
    select m.id into v_member from public.members m where m.role = 'owner' for update;
    update public.members m
    set first_name = btrim(p_first_name), last_initial = upper(btrim(p_last_initial))
    where m.id = v_member;
    update private.member_invites i
    set revoked_at = now()
    where i.member_id = v_member and i.redeemed_at is null and i.revoked_at is null;
    v_mode := 'reissued';
  else
    return jsonb_build_object('outcome', 'already_bootstrapped');
  end if;

  insert into private.member_invites (member_id, code_hash, created_by_member_id, expires_at)
  values (v_member, p_code_hash, null, v_expires)
  returning id into v_invite;

  perform private.write_audit('owner.bootstrap_' || v_mode, 'public.members', v_member,
    jsonb_build_object('invite_id', v_invite, 'expires_at', v_expires));
  return jsonb_build_object('outcome', 'ok', 'mode', v_mode, 'member_id', v_member, 'expires_at', v_expires);
end;
$$;

-- Closes the bootstrap for good once the owner holds a claim. SECURITY
-- DEFINER so the REVOKE runs as the functions' owner whatever inserted the
-- claim. Trigger function; nobody is granted EXECUTE.
create function private.close_owner_bootstrap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.members m where m.id = new.member_id and m.role = 'owner') then
    revoke all on function public.bootstrap_owner_invite(text, text, text) from service_role;
    revoke all on function private.bootstrap_owner_invite_impl(text, text, text) from service_role;
    perform private.write_audit('owner.bootstrap_closed', 'public.members', new.member_id);
  end if;
  return new;
end;
$$;

create trigger close_owner_bootstrap after insert on private.auth_claims
  for each row execute function private.close_owner_bootstrap();

-- ---------------------------------------------------------------------------
-- 4. Public RPCs (thin SECURITY INVOKER wrappers)
-- ---------------------------------------------------------------------------

create function public.create_member_with_invite(
  p_first_name text,
  p_last_initial text,
  p_code_hash text,
  p_expires_at timestamptz default null
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.create_member_with_invite_impl(p_first_name, p_last_initial, p_code_hash, p_expires_at) $$;

create function public.owner_member_access()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.owner_member_access_impl() $$;

create function public.whoami()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.whoami_impl() $$;

create function public.bootstrap_owner_invite(p_first_name text, p_last_initial text, p_code_hash text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.bootstrap_owner_invite_impl(p_first_name, p_last_initial, p_code_hash) $$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function private.close_owner_bootstrap() from public, anon, authenticated, service_role;

revoke all on function private.create_member_with_invite_impl(text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.owner_member_access_impl() from public, anon, authenticated, service_role;
revoke all on function private.whoami_impl() from public, anon, authenticated, service_role;
revoke all on function private.bootstrap_owner_invite_impl(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_member_with_invite(text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.owner_member_access() from public, anon, authenticated, service_role;
revoke all on function public.whoami() from public, anon, authenticated, service_role;
revoke all on function public.bootstrap_owner_invite(text, text, text) from public, anon, authenticated, service_role;

grant execute on function private.create_member_with_invite_impl(text, text, text, timestamptz) to authenticated;
grant execute on function private.owner_member_access_impl() to authenticated;
grant execute on function private.whoami_impl() to authenticated;
grant execute on function public.create_member_with_invite(text, text, text, timestamptz) to authenticated;
grant execute on function public.owner_member_access() to authenticated;
grant execute on function public.whoami() to authenticated;

grant execute on function private.bootstrap_owner_invite_impl(text, text, text) to service_role;
grant execute on function public.bootstrap_owner_invite(text, text, text) to service_role;
