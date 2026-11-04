-- Opening Night v3 — database foundation.
--
-- Establishes the privilege baseline every later migration builds on. Creates
-- no application tables, functions, or data.
--
-- Architecture:
--   public   The only schema exposed through the Data API (PostgREST). Holds
--            the tables and RPC functions the app is meant to reach. Nothing
--            in it is reachable by an API role until a migration GRANTs it
--            explicitly, and every table enables RLS in the migration that
--            creates it.
--   private  Not exposed through the Data API. Holds data the client must
--            not read directly (phone numbers, payment handles, push tokens)
--            and the SECURITY DEFINER helpers that RLS policies and RPCs
--            call. API roles start with no privileges here. Later migrations
--            may grant USAGE on the schema plus EXECUTE on specific helper
--            functions to authenticated, because an RLS policy runs as the
--            caller and cannot call a helper otherwise. That does not make
--            private tables readable: the schema is not exposed, and anon and
--            authenticated are never granted privileges on private tables or
--            sequences. Server-side Edge Functions (service_role) may receive
--            narrowly scoped privileges later where required.
--
-- Rules for every later migration:
--   - Every application table enables RLS in the migration that creates it.
--   - Every exposed table and function gets explicit GRANTs, to exactly the
--     roles that need them. Nothing is reachable by default.
--   - Every exposed view over RLS-protected tables is created with
--     security_invoker = true; otherwise it reads as its owner and bypasses
--     RLS.
--   - Extensions are installed outside public (e.g. the extensions schema)
--     when practical.
--
-- Safe to re-run: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Nothing new is reachable by default
-- ---------------------------------------------------------------------------

-- Postgres grants EXECUTE on every new function to PUBLIC, which includes
-- anon. For a SECURITY DEFINER helper that is a hole: anyone holding the anon
-- key could call it over /rest/v1/rpc. This must be revoked globally (not
-- per-schema) because per-schema default privileges can only add to the
-- global defaults, never subtract from them.
alter default privileges for role postgres
  revoke execute on functions from public;

-- Supabase has historically auto-granted everything created by postgres in
-- public to the three API roles. The CLI notes the hosted default is now
-- "not auto-exposed", but this project should not depend on a platform
-- default, so pin it here. Each later migration grants exactly what it needs,
-- to exactly the roles that need it — including service_role.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- Same, for any schema (covers private and anything added later). These are
-- no-ops if no such global default exists.
alter default privileges for role postgres
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres
  revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. public: API roles may look up objects, never create them
-- ---------------------------------------------------------------------------

-- USAGE on public is Supabase's standard baseline and is required for any
-- table or RPC to be reachable at all; it grants nothing on its own. CREATE
-- is already withheld from PUBLIC on Postgres 15+; restate it for the API
-- roles so it cannot drift.
revoke create on schema public from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. private: internal schema, not exposed through the Data API
-- ---------------------------------------------------------------------------

create schema if not exists private;

-- A new schema already has no grants to other roles; state it explicitly as
-- the baseline. Later migrations add back only what is needed: USAGE plus
-- EXECUTE on specific RLS helper functions for authenticated, and narrowly
-- scoped privileges for service_role. Any table or sequence grant to anon or
-- authenticated in this schema is a mistake.
revoke all on schema private from public, anon, authenticated, service_role;

comment on schema private is
  'Opening Night internal data and SECURITY DEFINER helpers. Not exposed '
  'through the Data API. API roles have no table or sequence privileges here; '
  'only specific helper functions are granted EXECUTE where needed.';
