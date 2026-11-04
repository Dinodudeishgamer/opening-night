// Invite issuing: the logic behind the owner-members Edge Function (Dino,
// signed in) and the temporary owner-bootstrap Edge Function (secret key).
//
// The code is generated here with the platform's cryptographic random
// source, hashed under the contract in invite-gateway.ts, and only the hash
// goes to the database. The plaintext is returned once, to the caller, and is
// never logged or stored.
//
// Dino may instead choose the code for a member ("kirbyisthebest"). A chosen
// code goes through the same normalization and the same 12-character floor,
// but it is a phrase a person picked, not 80 random bits, and the code is the
// whole credential. So a custom code lives for 48 hours instead of 14 days:
// it is meant to be used the day it is handed over. It still works once, and
// a phrase that has ever been a code (used, expired, or revoked) is refused.
// The owner bootstrap never takes one.
//
// Who the caller is, is not decided here. owner-members calls the database
// with the caller's own session, and every database function checks
// current_owner_id() itself: a member who calls this endpoint gets 403 from
// the database's answer, not from anything this module believes.
import { inviteCodeHash, normalizeInviteCode, type Rpc } from './invite-gateway.ts';

// Letters only, and only the ones nobody misreads or mistypes on a phone: no
// digits (no switching keyboards), and none of I, L, O, Q, S, U, V, X, Y, Z,
// which get confused with each other or with 1, 0, 5 and 2. Sixteen symbols,
// so half a random byte maps to one with no bias (byte & 15).
const ALPHABET = 'ABCDEFGHJKMNPRTW';
// 16 symbols x 4 bits = 64 bits: far beyond guessing, with every guess
// rate-limited and every code expiring.
export const GENERATED_CODE_LENGTH = 16;

/** How long a code Dino chose himself stays valid. */
export const CUSTOM_CODE_TTL_MS = 48 * 60 * 60 * 1000;

const MIN_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssueDeps {
  /** Calls a public database function: as the signed-in caller (owner-members) or as service_role (bootstrap). */
  rpc: Rpc;
  hmacSecret: string | undefined;
  /** Fixed event names only. */
  log?: (event: string) => void;
  /** Test seam; defaults to crypto.getRandomValues. */
  randomBytes?: (length: number) => Uint8Array;
  /** Test seam; defaults to Date.now. */
  now?: () => number;
}

/** A fresh canonical invite code (no separators). */
export function generateInviteCode(randomBytes?: (length: number) => Uint8Array): string {
  const bytes = randomBytes
    ? randomBytes(GENERATED_CODE_LENGTH)
    : crypto.getRandomValues(new Uint8Array(GENERATED_CODE_LENGTH));
  let code = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i += 1) code += ALPHABET[bytes[i] & 15];
  return code;
}

/** "ABCDEFGHJKMNPRTW" -> "ABCD-EFGH-JKMN-PRTW", for showing to Dino. */
export function formatInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const invalidRequest = () => respond(400, { outcome: 'invalid_request' });
const serverError = () => respond(500, { outcome: 'server_error' });

async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  if (req.method !== 'POST') return respond(405, { outcome: 'method_not_allowed' });
  if (!req.headers.get('content-type')?.toLowerCase().includes('application/json')) return invalidRequest();
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return invalidRequest();
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalidRequest();
    return body as Record<string, unknown>;
  } catch {
    return invalidRequest();
  }
}

function cleanName(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= max ? name : null;
}

type Minted = {
  hash: string;
  /** The code as it is handed back to Dino. */
  shown: string;
  /** Set for a custom code only: the short expiry, as the database argument. */
  expiresAt?: string;
};

// A code and its hash: the one Dino chose, when the request carries
// custom_code, otherwise a fresh random one. 'invalid_code' when the chosen
// one does not meet the contract; null when the secret is unusable.
async function mint(deps: IssueDeps, custom?: unknown): Promise<Minted | 'invalid_code' | null> {
  const secret = deps.hmacSecret;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    deps.log?.('misconfigured');
    return null;
  }
  if (custom !== undefined && custom !== null && custom !== '') {
    const chosen = normalizeInviteCode(custom);
    if (!chosen) return 'invalid_code';
    return {
      hash: await inviteCodeHash(secret, chosen),
      // Lower case reads as the phrase it is; case never matters when it is typed.
      shown: chosen.toLowerCase(),
      expiresAt: new Date((deps.now?.() ?? Date.now()) + CUSTOM_CODE_TTL_MS).toISOString(),
    };
  }
  const code = generateInviteCode(deps.randomBytes);
  // The generator and the contract must agree; refuse rather than issue a
  // code the gateway would not accept back.
  if (normalizeInviteCode(code) !== code) {
    deps.log?.('generator_contract_violation');
    return null;
  }
  return { hash: await inviteCodeHash(secret, code), shown: formatInviteCode(code) };
}

// Maps a database refusal to a response without passing its text on.
function refusal(error: unknown, deps: IssueDeps, custom = false): Response {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === '42501') return respond(403, { outcome: 'forbidden' });
  // code_hash is unique for good, so a chosen phrase cannot be issued twice.
  if (custom && code === '23505') return respond(409, { outcome: 'code_taken' });
  if (code === 'P0002') return respond(404, { outcome: 'not_found' });
  if (code === '22023' || code === '23514') return invalidRequest();
  deps.log?.('backend_error');
  return serverError();
}

/**
 * POST, as the signed-in owner:
 *   { action: 'create_member', first_name, last_initial, custom_code? }
 *       -> 200 { outcome: 'ok', member_id, invite_code, expires_at }
 *   { action: 'create_invite', member_id, custom_code? }   (replaces any open invite; using it moves the login)
 *       -> 200 { outcome: 'ok', member_id, invite_code }
 *   400 invalid_request | 400 invalid_code | 403 forbidden | 404 not_found |
 *   409 code_taken | 500 server_error
 *
 * custom_code is optional. Absent, null, or empty means a random code.
 */
export async function handleOwnerMembers(req: Request, deps: IssueDeps): Promise<Response> {
  try {
    const body = await readBody(req);
    if (body instanceof Response) return body;

    if (body.action === 'create_member') {
      const firstName = cleanName(body.first_name, 40);
      const lastInitial = cleanName(body.last_initial, 1);
      if (!firstName || !lastInitial) return invalidRequest();
      const minted = await mint(deps, body.custom_code);
      if (minted === 'invalid_code') return respond(400, { outcome: 'invalid_code' });
      if (!minted) return serverError();
      const { data, error } = await deps.rpc('create_member_with_invite', {
        p_first_name: firstName,
        p_last_initial: lastInitial,
        p_code_hash: minted.hash,
        ...(minted.expiresAt ? { p_expires_at: minted.expiresAt } : {}),
      });
      if (error) return refusal(error, deps, Boolean(minted.expiresAt));
      const row = data as { member_id?: unknown; expires_at?: unknown } | null;
      if (!row || typeof row.member_id !== 'string') {
        deps.log?.('backend_error');
        return serverError();
      }
      return respond(200, {
        outcome: 'ok',
        member_id: row.member_id,
        invite_code: minted.shown,
        expires_at: row.expires_at ?? null,
      });
    }

    if (body.action === 'create_invite') {
      if (typeof body.member_id !== 'string' || !UUID_PATTERN.test(body.member_id)) return invalidRequest();
      const minted = await mint(deps, body.custom_code);
      if (minted === 'invalid_code') return respond(400, { outcome: 'invalid_code' });
      if (!minted) return serverError();
      const { data, error } = await deps.rpc('create_member_invite', {
        p_member_id: body.member_id,
        p_code_hash: minted.hash,
        ...(minted.expiresAt ? { p_expires_at: minted.expiresAt } : {}),
      });
      if (error) return refusal(error, deps, Boolean(minted.expiresAt));
      if (typeof data !== 'string') {
        deps.log?.('backend_error');
        return serverError();
      }
      return respond(200, { outcome: 'ok', member_id: body.member_id, invite_code: minted.shown });
    }

    return invalidRequest();
  } catch {
    deps.log?.('unhandled_error');
    return serverError();
  }
}

/**
 * POST { first_name, last_initial }, with the project's secret key:
 *   200 { outcome: 'ok', mode: 'created' | 'reissued', invite_code, expires_at }
 *   409 { outcome: 'already_bootstrapped' }
 *   400 invalid_request | 500 server_error
 *
 * After the owner's first sign-in the database revokes the function behind
 * this, and every call ends in 409.
 */
export async function handleOwnerBootstrap(req: Request, deps: IssueDeps): Promise<Response> {
  try {
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const firstName = cleanName(body.first_name, 40);
    const lastInitial = cleanName(body.last_initial, 1);
    if (!firstName || !lastInitial) return invalidRequest();
    // Always random: the organizer's code is never a chosen phrase.
    const minted = await mint(deps);
    if (!minted || minted === 'invalid_code') return serverError();

    const { data, error } = await deps.rpc('bootstrap_owner_invite', {
      p_first_name: firstName,
      p_last_initial: lastInitial,
      p_code_hash: minted.hash,
    });
    if (error) {
      // 42501: the grant is gone, i.e. the bootstrap has closed itself.
      if ((error as { code?: unknown }).code === '42501') return respond(409, { outcome: 'already_bootstrapped' });
      return refusal(error, deps);
    }
    const row = data as { outcome?: unknown; mode?: unknown; expires_at?: unknown } | null;
    if (row?.outcome === 'already_bootstrapped') return respond(409, { outcome: 'already_bootstrapped' });
    if (row?.outcome !== 'ok') {
      deps.log?.('backend_error');
      return serverError();
    }
    return respond(200, {
      outcome: 'ok',
      mode: row.mode,
      invite_code: minted.shown,
      expires_at: row.expires_at ?? null,
    });
  } catch {
    deps.log?.('unhandled_error');
    return serverError();
  }
}
