-- Opening Night v3 — member management and invite-based phone sign-in.
--
-- Dino is the only owner and manages members; members get in with a
-- personal invite code plus a phone number verified by Supabase Auth SMS OTP.
-- This migration adds the server-side operations for that, and nothing else:
-- no Auth or SMS provider configuration, no seed data, no owner row.
--
-- Two layers. public is exposed through the Data API, so it holds no
-- SECURITY DEFINER function:
--   public.<name>(...)        the RPC the client calls. SECURITY INVOKER, and
--                             nothing but a call to its implementation; it
--                             reads and writes no table itself.
--   private.<name>_impl(...)  the implementation. SECURITY DEFINER, in the
--                             unexposed private schema, so it cannot be
--                             reached as an RPC. This is the privilege
--                             boundary: it does its own authorization and
--                             never relies on having come through the wrapper.
-- A role gets EXECUTE on a wrapper and on that wrapper's implementation, or on
-- neither.
--
-- Who calls what:
--   authenticated (Dino)   create_member, rename_member, set_member_status,
--                          reset_member_access, create_member_invite,
--                          revoke_member_invite. Each checks
--                          current_owner_id() itself and writes an audit row.
--   service_role           preview_member_invite, begin_invite_claim,
--                          consume_rate_limit. These are the unauthenticated
--                          steps of sign-in. They run in an Edge Function,
--                          which holds the invite-code HMAC secret (the
--                          database never sees a plaintext code) and knows
--                          the client's address for rate limiting. anon is
--                          granted nothing.
--   authenticated (anyone  complete_invite_claim, sync_verified_phone. They
--   signed in to Auth)     read the caller's verified phone from auth.users
--                          and never accept one from the client.
--   nobody                 private.bootstrap_owner: run once by hand, as the
--                          database owner, to create Dino's row.
--
-- Sign-in, first time:
--   1. preview_member_invite(code_hash)       shows "Alice A." for the code
--   2. begin_invite_claim(code_hash, phone)   records the phone on the invite
--   3. Supabase Auth SMS OTP verifies that phone; the client is now signed in
--   4. complete_invite_claim()                links that Auth user to the
--                                             member and closes the invite
-- Signing in again later is plain Supabase phone OTP; the existing claim
-- still resolves. A member who already has a live claim can only be
-- re-linked through an invite by proving the phone on that claim (step 2
-- refuses any other number, step 4 re-checks it), so a code alone never
-- takes over a claimed member. After Dino resets a member's access there is
-- no live claim, and the next invite links whatever phone the member
-- verifies.
--
-- Throughout, failed sign-in steps RETURN an outcome instead of raising: an
-- exception would roll back the rate-limit counter along with everything
-- else, and guessing would be free.
--
-- Not done here (Auth configuration, later): anyone can still ask Supabase
-- Auth directly for a phone OTP and become an Auth user. Such a user gets no
-- Opening Night identity (no claim), but the Auth integration should use
-- Supabase's sign-in controls / a Before User Created hook so arbitrary
-- direct phone sign-ups are refused unless an invite claim is in progress
-- for that phone.

-- ---------------------------------------------------------------------------
-- 1. auth_claims: one row per link, not per Auth user
-- ---------------------------------------------------------------------------

-- The core schema keyed claims on auth_user_id and cascaded them from
-- auth.users. Both break this workflow:
--   - A revoked claim stays as history, so its auth_user_id stays taken. The
--     same person re-claiming with the same phone gets the same Auth user
--     (Supabase keys phone users by number), and the primary key refused
--     that second link. Claims now have their own id; the one-live-claim rule
--     per Auth user is a partial unique index, like the existing ones per
--     member and per phone, so a revoked claim does not stop the same Auth
--     user being linked again by a fresh invite.
--   - Deleting an Auth user silently deleted its claims, live and revoked,
--     so the member looked never-claimed and the next invite code alone
--     would link a new phone. The key to auth.users stays, but as ON DELETE
--     RESTRICT: an Auth user that has any claim, live or historical, cannot
--     be deleted, so a live claim can never be orphaned and revoked claims
--     keep their Auth user.
-- No Opening Night workflow deletes Auth users. Ending access means revoking
-- the live claim: current_member_id() requires revoked_at is null, so that
-- takes effect on the caller's very next request, whatever JWT they hold.
alter table private.auth_claims
  drop constraint auth_claims_auth_user_id_fkey,
  drop constraint auth_claims_pkey,
  add column id uuid not null default gen_random_uuid(),
  add constraint auth_claims_pkey primary key (id),
  add constraint auth_claims_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users (id) on delete restrict;

create unique index auth_claims_one_active_per_auth_user
  on private.auth_claims (auth_user_id)
  where revoked_at is null;

-- Same rules as before, plus the new id is immutable too.
create or replace function private.auth_claims_guard_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.member_id is distinct from old.member_id
     or new.claimed_at is distinct from old.claimed_at then
    raise exception 'auth_claims id, auth_user_id, member_id, and claimed_at are immutable; link a new claim instead'
      using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or new.phone_e164 is distinct from old.phone_e164
          or (new.invite_id is distinct from old.invite_id and new.invite_id is not null)
          or (new.revoked_by_member_id is distinct from old.revoked_by_member_id
              and new.revoked_by_member_id is not null)) then
    raise exception 'revoked auth_claims are frozen; only an active claim''s phone may change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.auth_claims_guard_binding() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Members: role is fixed, the owner stays active
-- ---------------------------------------------------------------------------

-- Nothing grants members write access, and no function below changes a
-- role. This holds even for code running as the table owner:
--   - role never changes. The owner is created as owner (bootstrap) and
--     every other member as member; there is no promotion path.
--   - the owner's status stays active, so current_owner_id() keeps
--     resolving and the group always has its organizer.
--   - status_changed_at follows status.
-- Plain trigger function; nobody is granted EXECUTE.
create function private.members_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    raise exception 'members.role is immutable'
      using errcode = 'check_violation';
  end if;
  if old.role = 'owner' and new.status <> 'active' then
    raise exception 'the owner cannot be deactivated or removed'
      using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.members_guard() from public, anon, authenticated, service_role;

create trigger guard_role_and_status before update on public.members
  for each row execute function private.members_guard();

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (no grants; called only from the implementations below)
-- ---------------------------------------------------------------------------

-- Appends to the audit log as the current caller. actor_member_id is null for
-- the service_role sign-in steps and for bootstrap.
create function private.write_audit(
  p_action text,
  p_target_table text,
  p_target_id uuid,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into private.audit_log (actor_member_id, actor_auth_user_id, action, target_table, target_id, details)
  values (private.current_member_id(), auth.uid(), p_action, p_target_table, p_target_id::text,
          coalesce(p_details, '{}'::jsonb));
end;
$$;

-- The phone Supabase Auth has verified for this Auth user, as E.164, or null.
-- Auth stores numbers without the leading '+'. During a pending phone_change
-- the new number sits in auth.users.phone_change and phone keeps the old,
-- verified one, so reading phone is always the verified number.
create function private.auth_user_verified_phone(p_auth_user_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_phone text;
begin
  select case when u.phone like '+%' then u.phone else '+' || u.phone end
    into v_phone
  from auth.users u
  where u.id = p_auth_user_id
    and u.phone_confirmed_at is not null
    and u.deleted_at is null
    and coalesce(u.phone, '') <> '';
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    return null;
  end if;
  return v_phone;
end;
$$;

-- Counts one attempt against (scope, subject) and reports whether it is
-- allowed. Fixed windows; going over the limit locks the subject out for a
-- while. Limits:
--   invite_redeem  10 per 15 minutes, then locked 1 hour
--   otp_request     5 per hour,       then locked 1 hour
--   otp_verify     10 per 15 minutes, then locked 1 hour
-- subject_hash is 64 hex characters: the caller's hash of the throttled key
-- (client address, phone), never the raw value. Every call counts, allowed or
-- not, so the caller must not raise afterwards if it wants the count kept.
create function private.rate_limit_consume(p_scope text, p_subject_hash text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_max     integer;
  v_window  interval;
  v_lockout interval;
  v_start   timestamptz;
  v_count   integer;
begin
  case p_scope
    when 'invite_redeem' then v_max := 10; v_window := interval '15 minutes'; v_lockout := interval '1 hour';
    when 'otp_request'   then v_max := 5;  v_window := interval '1 hour';     v_lockout := interval '1 hour';
    when 'otp_verify'    then v_max := 10; v_window := interval '15 minutes'; v_lockout := interval '1 hour';
    else raise exception 'unknown rate-limit scope: %', p_scope using errcode = '22023';
  end case;
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'rate-limit subject must be a 64-character hex hash' using errcode = '22023';
  end if;

  -- Housekeeping for this subject only: windows and lockouts long past.
  delete from private.rate_limits r
  where r.scope = p_scope
    and r.subject_hash = p_subject_hash
    and r.window_started_at < now() - interval '1 day'
    and (r.locked_until is null or r.locked_until < now());

  if exists (
    select 1 from private.rate_limits r
    where r.scope = p_scope and r.subject_hash = p_subject_hash and r.locked_until > now()
  ) then
    return false;
  end if;

  v_start := date_bin(v_window, now(), timestamptz '2000-01-01 00:00:00+00');
  insert into private.rate_limits as r (scope, subject_hash, window_started_at, attempt_count)
  values (p_scope, p_subject_hash, v_start, 1)
  on conflict (scope, subject_hash, window_started_at)
    do update set attempt_count = r.attempt_count + 1
  returning r.attempt_count into v_count;

  if v_count > v_max then
    update private.rate_limits r
    set locked_until = now() + v_lockout
    where r.scope = p_scope and r.subject_hash = p_subject_hash and r.window_started_at = v_start;
    return false;
  end if;
  return true;
end;
$$;

-- Rate-limit subject for one invite: guesses at the phone for a known code
-- are throttled per invite, whatever address they come from.
create function private.invite_rate_subject(p_code_hash text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  return encode(sha256(convert_to('invite:' || p_code_hash, 'UTF8')), 'hex');
end;
$$;

revoke all on function private.write_audit(text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.auth_user_verified_phone(uuid) from public, anon, authenticated, service_role;
revoke all on function private.rate_limit_consume(text, text) from public, anon, authenticated, service_role;
revoke all on function private.invite_rate_subject(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Owner bootstrap (run once, by hand)
-- ---------------------------------------------------------------------------

-- Creates Dino's owner row and an open invite for it, so he signs in through
-- the same claim flow as everyone else. Nobody is granted EXECUTE: only the
-- database owner can run it, from the SQL editor or psql, which is the
-- deployment-time step. It is SECURITY INVOKER, so even if EXECUTE were
-- granted by mistake an API role would have no table access to act with.
--
-- It refuses once anyone exists: if public.members has any row, or if a
-- bootstrap was ever audited. The table lock serializes two concurrent runs.
-- After the bootstrap a later migration can drop it; until then it can only
-- fail.
--
-- p_invite_code_hash is the HMAC-SHA-256 (hex) of Dino's invite code under
-- the same secret the Edge Function uses.
create function private.bootstrap_owner(
  p_first_name text,
  p_last_initial text,
  p_invite_code_hash text,
  p_invite_expires_at timestamptz default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_member  uuid;
  v_invite  uuid;
  v_expires timestamptz := coalesce(p_invite_expires_at, now() + interval '1 day');
begin
  lock table public.members in share row exclusive mode;
  if exists (select 1 from public.members) then
    raise exception 'bootstrap refused: members already exist' using errcode = '42501';
  end if;
  if exists (select 1 from private.audit_log a where a.action = 'owner.bootstrapped') then
    raise exception 'bootstrap refused: it has already run' using errcode = '42501';
  end if;
  if p_invite_code_hash is null or p_invite_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invite code hash must be 64 hex characters' using errcode = '22023';
  end if;
  if v_expires <= now() or v_expires > now() + interval '7 days' then
    raise exception 'bootstrap invite must expire within 7 days' using errcode = '22023';
  end if;

  insert into public.members (first_name, last_initial, role, status)
  values (btrim(p_first_name), upper(btrim(p_last_initial)), 'owner', 'active')
  returning id into v_member;

  insert into private.member_invites (member_id, code_hash, created_by_member_id, expires_at)
  values (v_member, p_invite_code_hash, null, v_expires)
  returning id into v_invite;

  perform private.write_audit('owner.bootstrapped', 'public.members', v_member,
    jsonb_build_object('invite_id', v_invite, 'expires_at', v_expires, 'run_as', current_user));
  return v_member;
end;
$$;

revoke all on function private.bootstrap_owner(text, text, text, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Owner operations (authenticated; each checks current_owner_id())
-- ---------------------------------------------------------------------------

-- Sections 5 to 7 are the implementations; their public wrappers are in
-- section 8. Any signed-in Auth user holds EXECUTE on the six below, so the
-- current_owner_id() check at the top of each is what makes them Dino's.

-- A new member is always role member; there is no owner parameter. Status is
-- active or deactivated (added ahead of time, access paused).
create function private.create_member_impl(
  p_first_name text,
  p_last_initial text,
  p_status text default 'active'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := private.current_owner_id();
  v_id    uuid;
begin
  if v_owner is null then
    raise exception 'only the owner can create members' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'deactivated') then
    raise exception 'a new member is active or deactivated' using errcode = '22023';
  end if;

  insert into public.members (first_name, last_initial, role, status, status_changed_at)
  values (btrim(p_first_name), upper(btrim(p_last_initial)), 'member', p_status,
          case when p_status = 'active' then null else now() end)
  returning id into v_id;

  perform private.write_audit('member.created', 'public.members', v_id,
    jsonb_build_object('first_name', btrim(p_first_name), 'last_initial', upper(btrim(p_last_initial)), 'status', p_status));
  return v_id;
end;
$$;

-- Names are Dino's to set; members cannot edit their own.
create function private.rename_member_impl(
  p_member_id uuid,
  p_first_name text,
  p_last_initial text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := private.current_owner_id();
  v_old   public.members%rowtype;
begin
  if v_owner is null then
    raise exception 'only the owner can rename members' using errcode = '42501';
  end if;
  select * into v_old from public.members m where m.id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = 'P0002';
  end if;

  update public.members m
  set first_name = btrim(p_first_name), last_initial = upper(btrim(p_last_initial))
  where m.id = p_member_id;

  perform private.write_audit('member.renamed', 'public.members', p_member_id,
    jsonb_build_object('from', jsonb_build_object('first_name', v_old.first_name, 'last_initial', v_old.last_initial),
                       'to', jsonb_build_object('first_name', btrim(p_first_name), 'last_initial', upper(btrim(p_last_initial)))));
end;
$$;

-- active / deactivated / removed. History stays in every case; only access
-- changes:
--   deactivated  access paused. current_member_id() stops resolving because
--                the member is not active, but the claim is kept, so
--                reactivating restores access with no new invite. Any open
--                invite is revoked.
--   removed      access stops. The claim and any open invite are revoked
--                (the Auth user is left intact); coming back needs a new
--                invite.
--   active       resumes; a deactivated member's kept claim works again.
-- The owner's own status cannot change.
create function private.set_member_status_impl(p_member_id uuid, p_status text)
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
  end if;

  perform private.write_audit('member.status_changed', 'public.members', p_member_id,
    jsonb_build_object('from', v_member.status, 'to', p_status,
                       'claims_revoked', v_claims, 'invites_revoked', v_invites));
end;
$$;

-- Cuts the member's current login and any open invite, and nothing else: the
-- member row, its status, and all its history stay. The revoked claim stays
-- as history, still pointing at its Auth user, and the Supabase Auth user
-- itself is left intact. Access ends on the member's next request:
-- current_member_id() ignores revoked claims, whatever JWT they still hold.
-- With no live claim, the next invite Dino creates links whatever phone the
-- member verifies, which is how a member who lost their number gets back
-- in; with the same phone it links the same Auth user again. Not available
-- for the owner (it would lock the group out of its only organizer).
create function private.reset_member_access_impl(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := private.current_owner_id();
  v_role    text;
  v_claims  integer;
  v_invites integer;
begin
  if v_owner is null then
    raise exception 'only the owner can reset member access' using errcode = '42501';
  end if;
  select m.role into v_role from public.members m where m.id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = 'P0002';
  end if;
  if v_role = 'owner' then
    raise exception 'the owner''s access cannot be reset' using errcode = '42501';
  end if;

  update private.auth_claims c
  set revoked_at = now(), revoked_by_member_id = v_owner
  where c.member_id = p_member_id and c.revoked_at is null;
  get diagnostics v_claims = row_count;

  update private.member_invites i
  set revoked_at = now()
  where i.member_id = p_member_id and i.redeemed_at is null and i.revoked_at is null;
  get diagnostics v_invites = row_count;

  perform private.write_audit('member.access_reset', 'public.members', p_member_id,
    jsonb_build_object('claims_revoked', v_claims, 'invites_revoked', v_invites));
end;
$$;

-- Records a new invite for an active member, replacing (revoking) any open
-- one, so there is never more than one. p_code_hash is computed by the Edge
-- Function, which generates the code, calls this with Dino's session, and
-- shows the code to Dino once; the plaintext is never stored. Expiry
-- defaults to 14 days and may be at most 90. An invite for a member who
-- already has a live claim is a recovery invite: it only works with the
-- phone on that claim.
create function private.create_member_invite_impl(
  p_member_id uuid,
  p_code_hash text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := private.current_owner_id();
  v_status   text;
  v_expires  timestamptz := coalesce(p_expires_at, now() + interval '14 days');
  v_replaced uuid;
  v_id       uuid;
begin
  if v_owner is null then
    raise exception 'only the owner can create invites' using errcode = '42501';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invite code hash must be 64 hex characters' using errcode = '22023';
  end if;
  if v_expires <= now() or v_expires > now() + interval '90 days' then
    raise exception 'invite must expire in the future and within 90 days' using errcode = '22023';
  end if;
  select m.status into v_status from public.members m where m.id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'invites are only for active members' using errcode = '22023';
  end if;

  update private.member_invites i
  set revoked_at = now()
  where i.member_id = p_member_id and i.redeemed_at is null and i.revoked_at is null
  returning i.id into v_replaced;

  insert into private.member_invites (member_id, code_hash, created_by_member_id, expires_at)
  values (p_member_id, p_code_hash, v_owner, v_expires)
  returning id into v_id;

  perform private.write_audit('invite.created', 'private.member_invites', v_id,
    jsonb_build_object('member_id', p_member_id, 'expires_at', v_expires, 'replaced_invite_id', v_replaced));
  return v_id;
end;
$$;

-- Revokes the member's open invite, if any. Reports whether there was one.
create function private.revoke_member_invite_impl(p_member_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid := private.current_owner_id();
  v_invite uuid;
begin
  if v_owner is null then
    raise exception 'only the owner can revoke invites' using errcode = '42501';
  end if;
  update private.member_invites i
  set revoked_at = now()
  where i.member_id = p_member_id and i.redeemed_at is null and i.revoked_at is null
  returning i.id into v_invite;
  if v_invite is null then
    return false;
  end if;
  perform private.write_audit('invite.revoked', 'private.member_invites', v_invite,
    jsonb_build_object('member_id', p_member_id));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Sign-in steps before Auth (service_role, from the Edge Function)
-- ---------------------------------------------------------------------------

-- p_client_key_hash is the Edge Function's hash of the client's address; it
-- is the invite_redeem rate-limit subject. Every call counts against it,
-- valid code or not.
--
-- Outcomes: ok | rate_limited | invalid_invite. An unknown, revoked,
-- redeemed, or expired code, or one for a member who is not active, are all
-- invalid_invite, so the answer says nothing about which.

-- Step 1: the code shows whose invite it is.
create function private.preview_member_invite_impl(p_code_hash text, p_client_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first   text;
  v_initial text;
  v_member  uuid;
begin
  if not private.rate_limit_consume('invite_redeem', p_client_key_hash) then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select m.id, m.first_name, m.last_initial into v_member, v_first, v_initial
  from private.member_invites i
  join public.members m on m.id = i.member_id
  where i.code_hash = p_code_hash
    and i.redeemed_at is null and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
    and m.status = 'active';
  if not found then
    return jsonb_build_object('outcome', 'invalid_invite');
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'first_name', v_first,
    'last_initial', v_initial,
    -- true when the member already has a live claim: only that phone works.
    'linked_phone_required', exists (
      select 1 from private.auth_claims c where c.member_id = v_member and c.revoked_at is null));
end;
$$;

-- Step 2: the member supplies their phone, which is recorded on the invite
-- (and may be corrected by calling again). The Edge Function sends the OTP
-- only after ok. A member with a live claim must give exactly the phone on
-- that claim. Otherwise the phone must not belong to another member's live
-- claim or be pending on another open invite.
--
-- Outcomes: ok | rate_limited | invalid_invite | invalid_phone |
--           phone_mismatch | phone_unavailable
create function private.begin_invite_claim_impl(
  p_code_hash text,
  p_phone_e164 text,
  p_client_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite private.member_invites%rowtype;
  v_bound  text;
begin
  if not private.rate_limit_consume('invite_redeem', p_client_key_hash) then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    return jsonb_build_object('outcome', 'invalid_phone');
  end if;

  select i.* into v_invite
  from private.member_invites i
  join public.members m on m.id = i.member_id
  where i.code_hash = p_code_hash
    and i.redeemed_at is null and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
    and m.status = 'active'
  for update of i;
  if not found then
    return jsonb_build_object('outcome', 'invalid_invite');
  end if;
  if not private.rate_limit_consume('invite_redeem', private.invite_rate_subject(p_code_hash)) then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select c.phone_e164 into v_bound
  from private.auth_claims c
  where c.member_id = v_invite.member_id and c.revoked_at is null;

  if v_bound is not null and v_bound <> p_phone_e164 then
    return jsonb_build_object('outcome', 'phone_mismatch');
  end if;
  if v_bound is null and exists (
    select 1 from private.auth_claims c where c.phone_e164 = p_phone_e164 and c.revoked_at is null
  ) then
    return jsonb_build_object('outcome', 'phone_unavailable');
  end if;

  begin
    update private.member_invites i set phone_e164 = p_phone_e164 where i.id = v_invite.id;
  exception when unique_violation then
    -- Pending on another open invite (member_invites_one_open_per_phone).
    return jsonb_build_object('outcome', 'phone_unavailable');
  end;

  perform private.write_audit('invite.claim_started', 'private.member_invites', v_invite.id,
    jsonb_build_object('member_id', v_invite.member_id, 'recovery', v_bound is not null));
  return jsonb_build_object('outcome', 'ok', 'linked_phone_required', v_bound is not null);
end;
$$;

-- For the steps around Supabase Auth's OTP endpoints (otp_request before
-- sending a code, otp_verify before checking one). invite_redeem is counted
-- inside the invite functions and is not accepted here. Returns whether the
-- attempt is allowed.
create function private.consume_rate_limit_impl(p_scope text, p_subject_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_scope is null or p_scope not in ('otp_request', 'otp_verify') then
    raise exception 'scope must be otp_request or otp_verify' using errcode = '22023';
  end if;
  return private.rate_limit_consume(p_scope, p_subject_hash);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Sign-in steps after Auth (authenticated)
-- ---------------------------------------------------------------------------

-- Step 4: binds the caller's Auth user to the member whose open invite holds
-- the phone that Auth has just verified for them. The phone is read from
-- auth.users, never taken from the client; the code was proved in step 2,
-- which is the only way a phone gets onto an invite.
--   no live claim for the member      new claim (first claim, or after reset)
--   live claim, same Auth user        nothing to link (already signed in as
--                                     them); the invite is closed
--   live claim, other Auth user       the old login's claim is revoked and
--                                     this one linked: recovery when the
--                                     number now belongs to a different Auth
--                                     user (e.g. the old account's phone was
--                                     changed in Auth). The verified phone
--                                     must equal the claim's phone. The old
--                                     Auth user is left as it is.
-- Application data is keyed on members.id, so nothing else changes.
--
-- Outcomes: ok (with member_id and mode: claimed | already_linked |
--           relinked) | not_signed_in | phone_not_verified |
--           no_pending_invite | invalid_invite | auth_user_already_claimed |
--           phone_mismatch | phone_unavailable
create function private.complete_invite_claim_impl()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_phone   text;
  v_invite  private.member_invites%rowtype;
  v_status  text;
  v_mine    private.auth_claims%rowtype;
  v_current private.auth_claims%rowtype;
  v_mode    text;
begin
  if v_uid is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;
  v_phone := private.auth_user_verified_phone(v_uid);
  if v_phone is null then
    return jsonb_build_object('outcome', 'phone_not_verified');
  end if;

  select i.* into v_invite
  from private.member_invites i
  where i.phone_e164 = v_phone
    and i.redeemed_at is null and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
  for update;
  if not found then
    return jsonb_build_object('outcome', 'no_pending_invite');
  end if;

  select m.status into v_status from public.members m where m.id = v_invite.member_id for update;
  if v_status <> 'active' then
    return jsonb_build_object('outcome', 'invalid_invite');
  end if;

  select c.* into v_mine
  from private.auth_claims c
  where c.auth_user_id = v_uid and c.revoked_at is null
  for update;
  if found and v_mine.member_id <> v_invite.member_id then
    return jsonb_build_object('outcome', 'auth_user_already_claimed');
  end if;

  select c.* into v_current
  from private.auth_claims c
  where c.member_id = v_invite.member_id and c.revoked_at is null
  for update;

  if found then
    if v_current.phone_e164 <> v_phone then
      return jsonb_build_object('outcome', 'phone_mismatch');
    end if;
    if v_current.auth_user_id = v_uid then
      v_mode := 'already_linked';
    else
      update private.auth_claims c
      set revoked_at = now()
      where c.id = v_current.id;
      insert into private.auth_claims (auth_user_id, member_id, invite_id, phone_e164)
      values (v_uid, v_invite.member_id, v_invite.id, v_phone);
      v_mode := 'relinked';
    end if;
  else
    if exists (select 1 from private.auth_claims c where c.phone_e164 = v_phone and c.revoked_at is null) then
      return jsonb_build_object('outcome', 'phone_unavailable');
    end if;
    insert into private.auth_claims (auth_user_id, member_id, invite_id, phone_e164)
    values (v_uid, v_invite.member_id, v_invite.id, v_phone);
    v_mode := 'claimed';
  end if;

  update private.member_invites i set redeemed_at = now() where i.id = v_invite.id;

  perform private.write_audit('member.claim_' || v_mode, 'public.members', v_invite.member_id,
    jsonb_build_object('invite_id', v_invite.id, 'auth_user_id', v_uid,
                       'replaced_auth_user_id', case when v_mode = 'relinked' then v_current.auth_user_id end));
  return jsonb_build_object('outcome', 'ok', 'member_id', v_invite.member_id, 'mode', v_mode);
end;
$$;

-- After a signed-in member changes their number with Supabase Auth's
-- phone_change OTP, copies the newly verified Auth phone onto their own live
-- claim. Takes no arguments: the phone comes from auth.users and the claim is
-- the caller's own. A number on another member's live claim is refused.
--
-- Outcomes: ok | unchanged | not_a_member | phone_not_verified |
--           phone_unavailable
create function private.sync_verified_phone_impl()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_claim private.auth_claims%rowtype;
  v_phone text;
begin
  select c.* into v_claim
  from private.auth_claims c
  join public.members m on m.id = c.member_id
  where c.auth_user_id = v_uid and c.revoked_at is null and m.status = 'active'
  for update of c;
  if not found then
    return jsonb_build_object('outcome', 'not_a_member');
  end if;

  v_phone := private.auth_user_verified_phone(v_uid);
  if v_phone is null then
    return jsonb_build_object('outcome', 'phone_not_verified');
  end if;
  if v_phone = v_claim.phone_e164 then
    return jsonb_build_object('outcome', 'unchanged');
  end if;
  if exists (
    select 1 from private.auth_claims c
    where c.phone_e164 = v_phone and c.revoked_at is null and c.id <> v_claim.id
  ) then
    return jsonb_build_object('outcome', 'phone_unavailable');
  end if;

  begin
    update private.auth_claims c set phone_e164 = v_phone where c.id = v_claim.id;
  exception when unique_violation then
    return jsonb_build_object('outcome', 'phone_unavailable');
  end;

  perform private.write_audit('member.phone_synced', 'public.members', v_claim.member_id,
    jsonb_build_object('claim_id', v_claim.id));
  return jsonb_build_object('outcome', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Public RPCs (thin SECURITY INVOKER wrappers)
-- ---------------------------------------------------------------------------

-- The client-facing names. Each runs as its caller and only calls its
-- implementation, so on its own it can do nothing the caller could not
-- already do; the argument and result types are the implementation's.

create function public.create_member(
  p_first_name text,
  p_last_initial text,
  p_status text default 'active'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.create_member_impl(p_first_name, p_last_initial, p_status);
end;
$$;

create function public.rename_member(
  p_member_id uuid,
  p_first_name text,
  p_last_initial text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform private.rename_member_impl(p_member_id, p_first_name, p_last_initial);
end;
$$;

create function public.set_member_status(p_member_id uuid, p_status text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform private.set_member_status_impl(p_member_id, p_status);
end;
$$;

create function public.reset_member_access(p_member_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform private.reset_member_access_impl(p_member_id);
end;
$$;

create function public.create_member_invite(
  p_member_id uuid,
  p_code_hash text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.create_member_invite_impl(p_member_id, p_code_hash, p_expires_at);
end;
$$;

create function public.revoke_member_invite(p_member_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.revoke_member_invite_impl(p_member_id);
end;
$$;

create function public.preview_member_invite(p_code_hash text, p_client_key_hash text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.preview_member_invite_impl(p_code_hash, p_client_key_hash);
end;
$$;

create function public.begin_invite_claim(
  p_code_hash text,
  p_phone_e164 text,
  p_client_key_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.begin_invite_claim_impl(p_code_hash, p_phone_e164, p_client_key_hash);
end;
$$;

create function public.consume_rate_limit(p_scope text, p_subject_hash text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.consume_rate_limit_impl(p_scope, p_subject_hash);
end;
$$;

create function public.complete_invite_claim()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.complete_invite_claim_impl();
end;
$$;

create function public.sync_verified_phone()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.sync_verified_phone_impl();
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

-- Start from nothing on every wrapper and every implementation, then grant
-- each pair to exactly the role that calls it. No table privileges are
-- granted to anyone: the implementations are the only write paths. anon gets
-- nothing in either layer.

-- Implementations.
revoke all on function private.create_member_impl(text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.rename_member_impl(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.set_member_status_impl(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.reset_member_access_impl(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_member_invite_impl(uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.revoke_member_invite_impl(uuid) from public, anon, authenticated, service_role;
revoke all on function private.preview_member_invite_impl(text, text) from public, anon, authenticated, service_role;
revoke all on function private.begin_invite_claim_impl(text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.consume_rate_limit_impl(text, text) from public, anon, authenticated, service_role;
revoke all on function private.complete_invite_claim_impl() from public, anon, authenticated, service_role;
revoke all on function private.sync_verified_phone_impl() from public, anon, authenticated, service_role;

-- Wrappers.
revoke all on function public.create_member(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.rename_member(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.set_member_status(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.reset_member_access(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_member_invite(uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.revoke_member_invite(uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_member_invite(text, text) from public, anon, authenticated, service_role;
revoke all on function public.begin_invite_claim(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.consume_rate_limit(text, text) from public, anon, authenticated, service_role;
revoke all on function public.complete_invite_claim() from public, anon, authenticated, service_role;
revoke all on function public.sync_verified_phone() from public, anon, authenticated, service_role;

-- authenticated: the owner operations and the two post-Auth sign-in steps.
-- It already has USAGE on private, from the core schema.
grant execute on function private.create_member_impl(text, text, text) to authenticated;
grant execute on function private.rename_member_impl(uuid, text, text) to authenticated;
grant execute on function private.set_member_status_impl(uuid, text) to authenticated;
grant execute on function private.reset_member_access_impl(uuid) to authenticated;
grant execute on function private.create_member_invite_impl(uuid, text, timestamptz) to authenticated;
grant execute on function private.revoke_member_invite_impl(uuid) to authenticated;
grant execute on function private.complete_invite_claim_impl() to authenticated;
grant execute on function private.sync_verified_phone_impl() to authenticated;

grant execute on function public.create_member(text, text, text) to authenticated;
grant execute on function public.rename_member(uuid, text, text) to authenticated;
grant execute on function public.set_member_status(uuid, text) to authenticated;
grant execute on function public.reset_member_access(uuid) to authenticated;
grant execute on function public.create_member_invite(uuid, text, timestamptz) to authenticated;
grant execute on function public.revoke_member_invite(uuid) to authenticated;
grant execute on function public.complete_invite_claim() to authenticated;
grant execute on function public.sync_verified_phone() to authenticated;

-- service_role: the three pre-Auth sign-in steps and nothing else. Its
-- wrappers run as service_role, so it needs USAGE on private to reach their
-- implementations. USAGE grants nothing by itself: service_role holds no
-- privilege on any private table or sequence, and EXECUTE on only these
-- three private functions.
grant usage on schema private to service_role;

grant execute on function private.preview_member_invite_impl(text, text) to service_role;
grant execute on function private.begin_invite_claim_impl(text, text, text) to service_role;
grant execute on function private.consume_rate_limit_impl(text, text) to service_role;

grant execute on function public.preview_member_invite(text, text) to service_role;
grant execute on function public.begin_invite_claim(text, text, text) to service_role;
grant execute on function public.consume_rate_limit(text, text) to service_role;
