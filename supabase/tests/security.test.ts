// Structural security invariants, checked against the catalog after every
// migration has run. These hold for the whole schema, so a later migration
// that breaks one fails here even if its own tests forget to look.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { PGlite } from '@electric-sql/pglite';
import { createDb, migrationFiles, migrationSql } from './harness.ts';

let pg: PGlite;
before(async () => {
  pg = await createDb();
});

const rows = async (sql: string) => (await pg.query(sql)).rows as Record<string, any>[];

test('no SECURITY DEFINER function in the exposed public schema', async () => {
  const found = await rows(`
    select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef`);
  assert.deepEqual(found, []);
});

test('every private SECURITY DEFINER function pins an empty search_path', async () => {
  const found = await rows(`
    select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and not coalesce(p.proconfig, '{}') && array['search_path=""', 'search_path=']`);
  assert.deepEqual(found, []);
});

test('every public function pins an empty search_path', async () => {
  const found = await rows(`
    select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not coalesce(p.proconfig, '{}') && array['search_path=""', 'search_path=']`);
  assert.deepEqual(found, []);
});

test('anon and PUBLIC can execute no application function', async () => {
  const found = await rows(`
    select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (has_function_privilege('anon', p.oid, 'execute')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))`);
  assert.deepEqual(found, []);
});

test('every public RPC is a thin wrapper whose implementation has the same grants', async () => {
  const wrappers = await rows(`
    select p.proname, p.prosrc,
           has_function_privilege('authenticated', p.oid, 'execute') as authed,
           has_function_privilege('service_role', p.oid, 'execute') as service
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
  assert.ok(wrappers.length > 10);
  for (const w of wrappers) {
    assert.match(w.prosrc, new RegExp(`private\\.${w.proname}_impl\\(`), `${w.proname} must only call its implementation`);
    assert.doesNotMatch(w.prosrc, /\b(insert|update|delete)\b/i, `${w.proname} must not write`);
    const impl = await rows(`
      select has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = '${w.proname}_impl'`);
    assert.equal(impl.length, 1, `${w.proname}_impl must exist exactly once`);
    assert.deepEqual(impl[0], { authed: w.authed, service: w.service }, `${w.proname}: wrapper and implementation grants differ`);
  }
});

test('every application table has RLS enabled', async () => {
  const found = await rows(`
    select n.nspname || '.' || c.relname as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(found, []);
});

test('API roles hold no privilege on any private table or sequence', async () => {
  const found = await rows(`
    select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) r
    where n.nspname = 'private' and c.relkind in ('r', 'S', 'v')
      and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert')
        or has_table_privilege(r.rolname, c.oid, 'update') or has_table_privilege(r.rolname, c.oid, 'delete')
        or exists (select 1 from information_schema.column_privileges cp
                   where cp.table_schema = 'private' and cp.table_name = c.relname and cp.grantee = r.rolname))`);
  assert.deepEqual(found, []);
});

test('anon holds no privilege on any public table', async () => {
  const found = await rows(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
        or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`);
  assert.deepEqual(found, []);
});

test('members have no direct write on any table except marking notifications read', async () => {
  const found = await rows(`
    select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('insert'), ('update'), ('delete'), ('truncate')) p(priv)
    where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('authenticated', c.oid, p.priv)`);
  assert.deepEqual(found, []);
  const columns = await rows(`
    select table_name, column_name, privilege_type from information_schema.column_privileges
    where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT'`);
  assert.deepEqual(columns, [{ table_name: 'notifications', column_name: 'read_at', privilege_type: 'UPDATE' }]);
});

test('every public view is security_invoker', async () => {
  const found = await rows(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce(c.reloptions, '{}') && array['security_invoker=true', 'security_invoker=on']`);
  assert.deepEqual(found, []);
});

test('storage buckets are private', async () => {
  assert.deepEqual(await rows(`select id from storage.buckets where public`), []);
});

test('migrations contain no credentials and never touch the legacy project', () => {
  for (const name of migrationFiles()) {
    const sql = migrationSql(name);
    assert.doesNotMatch(sql, /sb_secret_|sb_publishable_|eyJhbGciOi|service_role_key\s*=/i, name);
    assert.doesNotMatch(sql, /pbttsidupnjgbjzfzwjy/, name);
  }
});
