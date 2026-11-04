-- Opening Night v3 — check-in roster facts, and one platform function tidied.

-- ---------------------------------------------------------------------------
-- 1. What Dino needs at the door, without breaking his own blinding
-- ---------------------------------------------------------------------------

-- The check-in list shows whether each person has predicted. Dino cannot
-- read other people's predictions until he has made his own (the same rule
-- as everyone), so the list could not tell "has not predicted" from "has,
-- but hidden from you". owner_roster now also says, per participant, WHETHER
-- a prediction exists, never what it is.
create or replace function private.owner_roster_impl(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_owner();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'participant_id', p.id,
      'prior_confirmation_status', p.prior_confirmation_status,
      'rsvp_updated_at', p.rsvp_updated_at,
      'confirmation_updated_at', p.confirmation_updated_at,
      'has_prediction', exists (select 1 from public.predictions pr where pr.participant_id = p.id))
      order by p.created_at, p.id)
    from public.event_participants p where p.event_id = p_event_id), '[]'::jsonb);
end;
$$;

select private.grant_rpc('owner_roster', 'authenticated');

-- ---------------------------------------------------------------------------
-- 2. public.rls_auto_enable
-- ---------------------------------------------------------------------------

-- Supabase creates this in new projects: an event-trigger function that turns
-- RLS on for any table created in public. It is not application code, it
-- returns event_trigger so it cannot be called as an RPC, and Postgres does
-- not check EXECUTE when an event trigger fires. But it is SECURITY DEFINER,
-- in the exposed schema, and executable by PUBLIC, which is exactly the shape
-- this project otherwise forbids. Revoking EXECUTE changes nothing about how
-- it works and leaves no SECURITY DEFINER function in public that an API role
-- may execute. It does not exist in the test database, where this is a no-op.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0
  ) then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;
  end if;
end;
$$;
