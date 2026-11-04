-- Opening Night v3 — sign-in with the invite code alone.
--
-- Sign-in used to be invite code -> phone number -> SMS OTP. The SMS is the
-- one thing in the project that costs money, so it is gone. The invite code
-- is now the whole credential, and the session it produces stays on the
-- phone it was entered on:
--
--   1. preview_member_invite(code_hash)      shows "Alice A." for the code
--   2. begin_invite_claim(code_hash,         records a one-time claim ticket
--        ticket_hash)                        on the invite; the Edge Function
--                                            made the ticket and returns it
--   3. Supabase Auth anonymous sign-in,      the Before User Created hook lets
--        carrying the ticket as user         Auth create the user only because
--        metadata                            that ticket is on an open invite
--   4. complete_invite_claim()               links that Auth user to the
--                                            member and closes the invite
--
-- The ticket is 32 random bytes from the Edge Function, valid for 10
-- minutes, and stored only as its SHA-256. It exists so that step 3 can be
-- tied to step 2 without the database ever seeing the invite code: only
-- someone who has just presented a valid code holds one. User metadata is
-- editable by its user, which changes nothing: writing a ticket there only
-- helps someone who already has a valid one.
--
-- What this changes for members:
--   - There is no signing back in. An anonymous Auth user cannot be reached
--     from another phone, so a new phone, a reinstall, or signing out means a
--     new invite code from Dino.
--   - A code now replaces the member's current login. Before, an invite for a
--     member who was signed in only worked with the phone number on their
--     claim. There is no phone to prove any more, so redeeming the invite
--     revokes the old claim and links the new Auth user. Codes come only from
--     Dino, work once, and expire, and that is the whole protection.
--
-- Phone columns stay where they are, unused and null from here on
-- (member_invites.phone_e164, auth_claims.phone_e164). The optional SMS
-- escalation for long-unpaid tickets reads auth_claims.phone_e164, so it has
-- nobody to text; it was already off unless an SMS provider is configured.
--
-- Auth configuration that goes with this (config.toml): anonymous sign-ins
-- on, phone sign-ups off.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

alter table private.member_invites
  drop constraint member_invites_redeemed_phone_check,
  add column ticket_hash text,
  add column ticket_issued_at timestamptz,
  add constraint member_invites_ticket_check check (
    (ticket_hash is null and ticket_issued_at is null)
    or (ticket_hash ~ '^[0-9a-f]{64}$' and ticket_issued_at is not null));

create unique index member_invites_ticket_hash_key
  on private.member_invites (ticket_hash)
  where ticket_hash is not null;

alter table private.auth_claims alter column phone_e164 drop not null;

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (no grants)
-- ---------------------------------------------------------------------------

-- How long after begin_invite_claim the ticket still works.
create function private.claim_ticket_ttl()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '10 minutes' $$;

-- ticket_hash for a ticket as the client holds it (64 lowercase hex
-- characters): SHA-256 of its UTF-8 bytes, in hex. Null for anything else.
-- The Edge Function computes the same value before calling
-- begin_invite_claim.
create function private.claim_ticket_hash(p_ticket text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_ticket is null or p_ticket !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  return encode(sha256(convert_to(p_ticket, 'UTF8')), 'hex');
end;
$$;

-- The hash of the claim ticket this Auth user signed up with, or null. Only
-- anonymous users have one.
create function private.auth_user_claim_ticket_hash(p_auth_user_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ticket text;
begin
  select u.raw_user_meta_data ->> 'claim_ticket' into v_ticket
  from auth.users u
  where u.id = p_auth_user_id and u.is_anonymous and u.deleted_at is null;
  return private.claim_ticket_hash(v_ticket);
end;
$$;

revoke all on function private.claim_ticket_ttl() from public, anon, authenticated, service_role;
revoke all on function private.claim_ticket_hash(text) from public, anon, authenticated, service_role;
revoke all on function private.auth_user_claim_ticket_hash(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Sign-in steps before Auth (service_role, from the Edge Function)
-- ---------------------------------------------------------------------------

-- Step 1. Outcomes: ok | rate_limited | invalid_invite.
create or replace function private.preview_member_invite_impl(p_code_hash text, p_client_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first   text;
  v_initial text;
begin
  if not private.rate_limit_consume('invite_redeem', p_client_key_hash) then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select m.first_name, m.last_initial into v_first, v_initial
  from private.member_invites i
  join public.members m on m.id = i.member_id
  where i.code_hash = p_code_hash
    and i.redeemed_at is null and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
    and m.status = 'active';
  if not found then
    return jsonb_build_object('outcome', 'invalid_invite');
  end if;

  return jsonb_build_object('outcome', 'ok', 'first_name', v_first, 'last_initial', v_initial);
end;
$$;

-- Step 2: records the ticket on the invite. Calling again replaces it, which
-- is what a retry does. Throttled per client and per invite, as before.
--
-- Outcomes: ok | rate_limited | invalid_invite
drop function public.begin_invite_claim(text, text, text);
drop function private.begin_invite_claim_impl(text, text, text);

create function private.begin_invite_claim_impl(
  p_code_hash text,
  p_ticket_hash text,
  p_client_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite private.member_invites%rowtype;
begin
  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ticket hash must be 64 hex characters' using errcode = '22023';
  end if;
  if not private.rate_limit_consume('invite_redeem', p_client_key_hash) then
    return jsonb_build_object('outcome', 'rate_limited');
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

  update private.member_invites i
  set ticket_hash = p_ticket_hash, ticket_issued_at = now()
  where i.id = v_invite.id;

  perform private.write_audit('invite.claim_started', 'private.member_invites', v_invite.id,
    jsonb_build_object('member_id', v_invite.member_id));
  return jsonb_build_object('outcome', 'ok');
end;
$$;

create function public.begin_invite_claim(
  p_code_hash text,
  p_ticket_hash text,
  p_client_key_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.begin_invite_claim_impl(p_code_hash, p_ticket_hash, p_client_key_hash);
end;
$$;

select private.grant_rpc('begin_invite_claim', 'service_role');

-- ---------------------------------------------------------------------------
-- 4. Sign-in steps after Auth (authenticated)
-- ---------------------------------------------------------------------------

-- Step 4: binds the caller's Auth user to the member whose open invite holds
-- the ticket the caller signed up with. The ticket is read from auth.users,
-- never taken as an argument.
--   no live claim for the member      new claim (first claim, or after reset)
--   live claim, same Auth user        nothing to link; the invite is closed
--   live claim, other Auth user       the old login's claim is revoked and
--                                     this one linked: the member moved to a
--                                     new phone. The old Auth user is left as
--                                     it is, with no claim.
-- Application data is keyed on members.id, so nothing else changes.
--
-- Outcomes: ok (with member_id and mode: claimed | already_linked |
--           relinked) | not_signed_in | no_pending_invite | invalid_invite |
--           auth_user_already_claimed
create or replace function private.complete_invite_claim_impl()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_ticket  text;
  v_invite  private.member_invites%rowtype;
  v_status  text;
  v_mine    private.auth_claims%rowtype;
  v_current private.auth_claims%rowtype;
  v_mode    text;
begin
  if v_uid is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;
  v_ticket := private.auth_user_claim_ticket_hash(v_uid);
  if v_ticket is null then
    return jsonb_build_object('outcome', 'no_pending_invite');
  end if;

  select i.* into v_invite
  from private.member_invites i
  where i.ticket_hash = v_ticket
    and i.ticket_issued_at > now() - private.claim_ticket_ttl()
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
    if v_current.auth_user_id = v_uid then
      v_mode := 'already_linked';
    else
      update private.auth_claims c
      set revoked_at = now()
      where c.id = v_current.id;
      insert into private.auth_claims (auth_user_id, member_id, invite_id)
      values (v_uid, v_invite.member_id, v_invite.id);
      v_mode := 'relinked';
    end if;
  else
    insert into private.auth_claims (auth_user_id, member_id, invite_id)
    values (v_uid, v_invite.member_id, v_invite.id);
    v_mode := 'claimed';
  end if;

  update private.member_invites i set redeemed_at = now() where i.id = v_invite.id;

  perform private.write_audit('member.claim_' || v_mode, 'public.members', v_invite.member_id,
    jsonb_build_object('invite_id', v_invite.id, 'auth_user_id', v_uid,
                       'replaced_auth_user_id', case when v_mode = 'relinked' then v_current.auth_user_id end));
  return jsonb_build_object('outcome', 'ok', 'member_id', v_invite.member_id, 'mode', v_mode);
end;
$$;

-- pending_invite: whether complete_invite_claim would have something to do.
create or replace function private.whoami_impl()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_ticket text;
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
  v_ticket := private.auth_user_claim_ticket_hash(auth.uid());
  return jsonb_build_object(
    'outcome', 'no_member',
    'pending_invite', v_ticket is not null and exists (
      select 1 from private.member_invites i
      where i.ticket_hash = v_ticket
        and i.ticket_issued_at > now() - private.claim_ticket_ttl()
        and i.redeemed_at is null and i.revoked_at is null
        and (i.expires_at is null or i.expires_at > now())));
end;
$$;

-- invite_started: someone has entered the code and not finished signing in.
create or replace function private.owner_member_access_impl()
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
      'invite_started', i.ticket_hash is not null) order by m.created_at)
    from public.members m
    left join private.member_invites i
      on i.member_id = m.id and i.redeemed_at is null and i.revoked_at is null
     and (i.expires_at is null or i.expires_at > now())
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. What only phone sign-in needed
-- ---------------------------------------------------------------------------

drop function public.sync_verified_phone();
drop function private.sync_verified_phone_impl();
drop function public.consume_rate_limit(text, text);
drop function private.consume_rate_limit_impl(text, text);
drop function private.auth_user_verified_phone(uuid);

-- ---------------------------------------------------------------------------
-- 6. The Before User Created hook
-- ---------------------------------------------------------------------------

-- Auth may create a user only for an anonymous sign-in that carries a claim
-- ticket recorded on an open invite of an active member within the last 10
-- minutes. Everything else is refused: phones, emails, anonymous sign-ins
-- with no ticket or one that is not on an invite. So nobody holding only the
-- publishable key can make an Auth user.
--
-- The two refusals say different things. Which one a caller gets depends
-- only on what they sent, so it tells them nothing about any invite.
--
-- Still not SECURITY DEFINER: it runs as supabase_auth_admin with exactly the
-- column access below.
create or replace function private.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ticket text := coalesce(event -> 'user' -> 'user_metadata' ->> 'claim_ticket', '');
begin
  if coalesce(event -> 'user' ->> 'is_anonymous', 'false') <> 'true'
     or coalesce(event -> 'user' ->> 'phone', '') <> ''
     or coalesce(event -> 'user' ->> 'email', '') <> ''
     or v_ticket !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Opening Night is invite-only. Start with your invite code.'));
  end if;

  if exists (
    select 1
    from private.member_invites i
    join public.members m on m.id = i.member_id
    where i.ticket_hash = encode(sha256(convert_to(v_ticket, 'UTF8')), 'hex')
      and i.ticket_issued_at > now() - interval '10 minutes'
      and i.redeemed_at is null and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now())
      and m.status = 'active'
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'That invite is no longer valid. Ask for a new code.'));
end;
$$;

revoke select (phone_e164) on table private.member_invites from supabase_auth_admin;
grant select (ticket_hash, ticket_issued_at) on table private.member_invites to supabase_auth_admin;
