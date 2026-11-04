// Tells the database where the notification dispatcher is and how to call it.
//
//   npm run setup:dispatch
//
// The scheduled job (pg_cron, every 5 minutes) calls the
// notifications-dispatch Edge Function with the project's secret key. Both
// the function URL and the key are stored in Supabase Vault (encrypted, in
// this project only) under the names the notifications migration reads:
//
//   dispatch_function_url
//   dispatch_secret_key
//
// The key is read through the Supabase CLI and passed to the database in a
// temporary SQL file that is deleted straight away. It is never printed.
// Run this again after rotating the project's secret key.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'vabgqjbgkhovgzylhezp';

function fail(message) {
  console.error(`setup-dispatch: ${message}`);
  process.exit(1);
}

// Output is captured, never echoed: it can contain keys.
function supabase(args) {
  const result = spawnSync('npx', ['supabase', ...args], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

let ref;
try {
  ref = readFileSync(join(ROOT, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
} catch {
  fail('no linked Supabase project. Run: npx supabase link');
}
if (ref !== EXPECTED_REF) fail(`the linked project is not Opening Night (${EXPECTED_REF}). Refusing to touch it.`);

const keys = supabase(['projects', 'api-keys', '--project-ref', ref, '--reveal', '-o', 'json']);
let secretKey;
try {
  secretKey = JSON.parse(keys.stdout).find((key) => key.type === 'secret' && key.name === 'default')?.api_key;
} catch {
  secretKey = undefined;
}
if (!keys.ok || typeof secretKey !== 'string' || !/^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey)) {
  fail('could not read the project secret key through the Supabase CLI. Are you logged in (npx supabase login)?');
}

const url = `https://${ref}.supabase.co/functions/v1/notifications-dispatch`;
// Both values match strict patterns above, so they are safe inside a
// dollar-quoted literal.
const sql = `
do $do$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'dispatch_function_url';
  if v_id is null then
    perform vault.create_secret($v$${url}$v$, 'dispatch_function_url', 'Opening Night: notifications-dispatch URL');
  else
    perform vault.update_secret(v_id, $v$${url}$v$);
  end if;
  select id into v_id from vault.secrets where name = 'dispatch_secret_key';
  if v_id is null then
    perform vault.create_secret($v$${secretKey}$v$, 'dispatch_secret_key', 'Opening Night: key the scheduled job presents to notifications-dispatch');
  else
    perform vault.update_secret(v_id, $v$${secretKey}$v$);
  end if;
end;
$do$;
`;

const dir = mkdtempSync(join(tmpdir(), 'opening-night-'));
const file = join(dir, 'vault.sql');
let ok;
try {
  writeFileSync(file, sql, { mode: 0o600 });
  ok = supabase(['db', 'query', '--linked', '-f', file]).ok;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!ok) fail('storing the dispatcher settings failed. Nothing was changed.');
console.log('Dispatcher URL and key stored in Vault. The scheduled job will start pushing within 5 minutes.');
