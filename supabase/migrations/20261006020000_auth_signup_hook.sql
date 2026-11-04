-- Opening Night v3 — invite-only Auth: the Before User Created hook.
--
-- Supabase Auth creates a user the first time a phone number asks for an OTP.
-- Without this hook anyone holding the publishable key could do that with any
-- number. Such a user would have no Opening Night identity (no claim), but it
-- would still cost an SMS and leave an Auth user behind.
--
-- The hook lets Auth create a user only when an invite claim is in progress
-- for exactly that phone: begin_invite_claim (reached only with a valid
-- invite code, through the invite-claim-begin Edge Function) has recorded the
-- number on an open, unexpired invite of an active member. Everything else is
-- refused: other phones, email sign-ups, anonymous users.
--
-- Members who already have an Auth user never reach this hook again: signing
-- back in creates nothing.
--
-- Following Supabase's guidance for Postgres hooks, the function is NOT
-- SECURITY DEFINER. It runs as supabase_auth_admin, which is given exactly
-- the read access the check needs and nothing else. It lives in private, so
-- it is not reachable through the Data API.
--
-- Enabling it is Auth configuration, not SQL:
--   [auth.hook.before_user_created]
--   enabled = true
--   uri = "pg-functions://postgres/private/hook_before_user_created"

create function private.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_phone text := coalesce(event -> 'user' ->> 'phone', '');
  v_refuse constant jsonb := jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Opening Night is invite-only. Start with your invite code.'));
begin
  if v_phone = ''
     or coalesce(event -> 'user' ->> 'email', '') <> ''
     or coalesce(event -> 'user' ->> 'is_anonymous', 'false') = 'true' then
    return v_refuse;
  end if;
  if v_phone not like '+%' then
    v_phone := '+' || v_phone;
  end if;

  if exists (
    select 1
    from private.member_invites i
    join public.members m on m.id = i.member_id
    where i.phone_e164 = v_phone
      and i.redeemed_at is null and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now())
      and m.status = 'active'
  ) then
    return '{}'::jsonb;
  end if;
  return v_refuse;
end;
$$;

revoke all on function private.hook_before_user_created(jsonb) from public, anon, authenticated, service_role;

-- supabase_auth_admin: reach the function, and read only the columns the
-- check uses. Both tables have RLS on, so each also needs a policy for it.
grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_before_user_created(jsonb) to supabase_auth_admin;

grant select (member_id, phone_e164, expires_at, redeemed_at, revoked_at)
  on table private.member_invites to supabase_auth_admin;
grant select (id, status) on table public.members to supabase_auth_admin;

create policy "auth hook reads invites" on private.member_invites
  for select to supabase_auth_admin using (true);
create policy "auth hook reads member status" on public.members
  for select to supabase_auth_admin using (true);
