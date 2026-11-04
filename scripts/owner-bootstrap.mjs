// One-time owner bootstrap: creates Dino's owner row and prints his invite
// code, so he signs in with an invite code like everyone else.
//
//   node scripts/owner-bootstrap.mjs --first Dino --last-initial W
//
// What it does, against the linked Opening Night project only:
//   1. deploys the temporary owner-bootstrap Edge Function
//   2. calls it with the project's secret key (read through the Supabase CLI,
//      held in memory, never printed or written anywhere)
//   3. deletes the function again, whatever happened
//   4. prints the invite code once
//
// Run it when you are ready to sign in: the code expires after 7 days. If it
// is lost or expires before you use it, run this again; that replaces it.
// After your first sign-in the database revokes the function behind this for
// good, and running it again only reports "already bootstrapped".
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'vabgqjbgkhovgzylhezp';
const FUNCTION = 'owner-bootstrap';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`owner-bootstrap: ${message}`);
  process.exit(1);
}

// Runs the Supabase CLI. Output is captured, never echoed: it can contain keys.
function supabase(args) {
  const result = spawnSync('npx', ['supabase', ...args], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

const firstName = arg('first')?.trim();
const lastInitial = arg('last-initial')?.trim();
if (!firstName || !lastInitial || lastInitial.length !== 1) {
  fail('usage: node scripts/owner-bootstrap.mjs --first <First name> --last-initial <X>');
}

let ref;
try {
  ref = readFileSync(join(ROOT, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
} catch {
  fail('no linked Supabase project (supabase/.temp/project-ref is missing). Run: npx supabase link');
}
if (ref !== EXPECTED_REF) fail(`the linked project is not Opening Night (${EXPECTED_REF}). Refusing to touch it.`);

const keys = supabase(['projects', 'api-keys', '--project-ref', ref, '--reveal', '-o', 'json']);
let secretKey;
try {
  secretKey = JSON.parse(keys.stdout).find((key) => key.type === 'secret' && key.name === 'default')?.api_key;
} catch {
  secretKey = undefined;
}
if (!keys.ok || typeof secretKey !== 'string' || !secretKey.startsWith('sb_secret_')) {
  fail('could not read the project secret key through the Supabase CLI. Are you logged in (npx supabase login)?');
}

let outcome;
console.log('Deploying the temporary bootstrap function...');
if (!supabase(['functions', 'deploy', FUNCTION, '--project-ref', ref, '--use-api']).ok) {
  fail('deploying the bootstrap function failed. Nothing was changed.');
}
try {
  const url = `https://${ref}.supabase.co/functions/v1/${FUNCTION}`;
  // A fresh deployment can take a moment to answer.
  for (let attempt = 0; attempt < 6 && !outcome; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: secretKey },
      body: JSON.stringify({ first_name: firstName, last_initial: lastInitial }),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => null) : null;
    if (body && typeof body.outcome === 'string' && (response.status === 200 || response.status === 409 || response.status === 400)) {
      outcome = body;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
} finally {
  console.log('Removing the temporary bootstrap function...');
  if (!supabase(['functions', 'delete', FUNCTION, '--project-ref', ref, '--yes']).ok) {
    console.error(`owner-bootstrap: WARNING: could not delete the function. Delete it now: npx supabase functions delete ${FUNCTION}`);
  }
}

if (!outcome) fail('the bootstrap function did not answer. Nothing was created; try again.');
if (outcome.outcome === 'already_bootstrapped') {
  fail('the owner has already signed in, or other members exist. Bootstrap is closed.');
}
if (outcome.outcome !== 'ok') fail(`refused (${outcome.outcome}). Check the name and try again.`);

console.log('');
console.log(outcome.mode === 'reissued' ? 'Owner invite replaced.' : 'Owner created.');
console.log('');
console.log(`  Your invite code:  ${outcome.invite_code}`);
console.log(`  Expires:           ${outcome.expires_at ?? 'in 7 days'}`);
console.log('');
console.log('Open the app, enter this code, and tap Sign in.');
console.log('This code is shown once. It is not stored anywhere in plain text.');
