// Pre-auth invite gateway: the logic behind the invite-preview and
// invite-claim-begin Edge Functions.
//
// The database never sees a plaintext invite code. This module turns the code
// into the HMAC-SHA-256 hash that private.member_invites.code_hash holds, and
// calls the service_role-only sign-in functions from the member_access and
// code_only_sign_in migrations. Every invite rule stays in those functions;
// nothing here re-implements them.
//
// Only Web APIs are used (Request, Response, crypto.subtle), and everything
// the handlers need from the platform is passed in as GatewayDeps, so the
// same code runs in the Edge runtime and under the Node test runner.
//
// Nothing here logs an invite code, a claim ticket, a hash, or the secret.
// The only thing returned beyond an outcome is the name on the invite and,
// to the caller who presented a valid code, their own claim ticket.
//
// ---------------------------------------------------------------------------
// Invite-code hashing contract
// ---------------------------------------------------------------------------
// This is the one definition. Everything that writes or looks up
// private.member_invites.code_hash must follow it: these two endpoints, the
// future create-invite function (create_member_invite's p_code_hash), and the
// hash Dino computes by hand for private.bootstrap_owner.
//
//   code       At least 12 characters from A-Z and 0-9 (at most 32). Normally
//              generated with a cryptographic random source; Dino may choose
//              one for a member instead (see owner-invites.ts for what that
//              costs and how it is bounded). May be shown grouped with
//              hyphens or spaces and typed in any case.
//   normalize  normalizeInviteCode(): remove every whitespace character and
//              hyphen, upper-case, then require ^[A-Z0-9]{12,32}$.
//   secret     INVITE_CODE_HMAC_SECRET, an Edge Function secret of at least
//              32 characters. Its UTF-8 bytes are the HMAC key.
//   hash       inviteCodeHash(): HMAC-SHA-256(key = secret, message = the
//              normalized code's UTF-8 bytes, nothing added), written as 64
//              lowercase hex characters.
//   stored     That hex string is code_hash, which the database checks
//              against ^[0-9a-f]{64}$. The code and the secret never reach it.
//
// By hand, for the bootstrap, the same value is:
//   printf %s "<NORMALIZED CODE>" | openssl dgst -sha256 -hmac "<secret>"
//
// Why the length floor: nothing can throttle guesses at codes by code, since
// every wrong guess is a different code, and the caller's network address is
// client-controlled. A guess is refused by arithmetic instead: 12 characters
// of A-Z0-9 is about 62 bits. The code is the whole credential now that
// there is no SMS step behind it, so this floor matters more than it did.
//
// ---------------------------------------------------------------------------
// Claim tickets
// ---------------------------------------------------------------------------
// A valid code is exchanged for a one-time claim ticket: 32 random bytes as
// 64 lowercase hex characters, made here and returned to the caller. The
// database is given only SHA-256(ticket's UTF-8 bytes) in hex, which is what
// private.claim_ticket_hash computes on its side. The client passes the
// ticket to Supabase Auth's anonymous sign-in as user metadata
// ({ claim_ticket }), where the Before User Created hook and
// complete_invite_claim look it up. It works for 10 minutes and once.

/** Name of the Edge Function secret holding the invite-code HMAC key. */
export const INVITE_HMAC_SECRET_NAME = 'INVITE_CODE_HMAC_SECRET';

/** Shortest invite code accepted. See the contract above before lowering it. */
export const INVITE_CODE_MIN_LENGTH = 12;

// A short secret is treated as a missing one rather than used.
const MIN_SECRET_LENGTH = 32;

// Request-shape limits. The real throttling is the database's invite_redeem
// rate limit; these only keep junk away from the hashing.
const MAX_BODY_BYTES = 1024;
const MAX_RAW_CODE_LENGTH = 64;

const CODE_PATTERN = new RegExp(`^[A-Z0-9]{${INVITE_CODE_MIN_LENGTH},32}$`);
const ADDRESS_PATTERN = /^[0-9A-Fa-f:.]{2,45}$/;

// The rate-limit subject shares the HMAC key with invite codes. Its prefix
// contains characters a normalized code cannot, so a subject hash can never
// equal a code hash.
const CLIENT_DOMAIN = 'client:v1:';

export type RpcResult = { data: unknown; error: unknown };
export type Rpc = (fn: string, args: Record<string, string>) => Promise<RpcResult>;

export interface GatewayDeps {
  /** Calls a public database function as service_role. */
  rpc: Rpc;
  /** Value of INVITE_CODE_HMAC_SECRET, or undefined when it is not set. */
  hmacSecret: string | undefined;
  /** Receives fixed event names only, never request or database content. */
  log?: (event: string) => void;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * The one place an invite code is normalized (see the contract at the top):
 * whitespace and hyphens are dropped and letters upper-cased, so
 * "abcd-2345-efgh", "ABCD 2345 EFGH" and "ABCD2345EFGH" are the same code.
 * Returns null for anything that is not then 12-32 ASCII letters and digits.
 */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_CODE_LENGTH) return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/**
 * A best-effort label for the caller, used only as the subject of the
 * database's per-client invite_redeem counter (the database functions
 * require one). It comes from request headers, which the caller can set, so
 * it is not a security boundary and nothing may rely on it: it slows a
 * careless client and no more. What stops guessing is the code length and
 * the database's per-invite limit, neither of which looks at this value.
 * Requests with no usable address share one bucket.
 */
export function clientAddress(headers: Headers): string {
  const candidates = [
    headers.get('cf-connecting-ip'),
    headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const candidate of candidates) {
    const address = candidate?.trim().toLowerCase();
    if (address && ADDRESS_PATTERN.test(address)) return address;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** code_hash for an invite code already passed through normalizeInviteCode. */
export function inviteCodeHash(secret: string, normalizedCode: string): Promise<string> {
  return hmacSha256Hex(secret, normalizedCode);
}

/** Rate-limit subject for a client address. Keyed, so stored subjects cannot be reversed to addresses. */
export function clientKeyHash(secret: string, address: string): Promise<string> {
  return hmacSha256Hex(secret, CLIENT_DOMAIN + address);
}

/** A new claim ticket: 32 random bytes as 64 lowercase hex characters. */
export function newClaimTicket(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** ticket_hash for a claim ticket: plain SHA-256 of its UTF-8 bytes, in hex. Matches private.claim_ticket_hash. */
export async function claimTicketHash(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Request and response plumbing
// ---------------------------------------------------------------------------

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const invalidRequest = () => respond(400, { outcome: 'invalid_request' });
const rateLimited = () => respond(429, { outcome: 'rate_limited' });
const serverError = () => respond(500, { outcome: 'server_error' });

// Returns the parsed JSON object, or the Response to send instead.
async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  if (req.method !== 'POST') return respond(405, { outcome: 'method_not_allowed' });
  if (!req.headers.get('content-type')?.toLowerCase().includes('application/json')) return invalidRequest();
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return invalidRequest();
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

function usableSecret(deps: GatewayDeps): string | null {
  const secret = deps.hmacSecret;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    deps.log?.('misconfigured');
    return null;
  }
  return secret;
}

// The database functions return a jsonb object with an outcome. Anything
// else, including any error, is a backend failure and is never passed on.
async function callOutcome(
  deps: GatewayDeps,
  fn: string,
  args: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await deps.rpc(fn, args);
  if (error || typeof data !== 'object' || data === null || typeof (data as { outcome?: unknown }).outcome !== 'string') {
    deps.log?.('backend_error');
    return null;
  }
  return data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST { invite_code } -> whose invite it is.
 *
 *   200 { outcome: 'ok', first_name, last_initial }
 *   200 { outcome: 'invalid_invite' }   unknown, expired, revoked, redeemed: all the same
 *   400 { outcome: 'invalid_request' }
 *   429 { outcome: 'rate_limited' }
 *   500 { outcome: 'server_error' }
 */
export async function handleInvitePreview(req: Request, deps: GatewayDeps): Promise<Response> {
  try {
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const code = normalizeInviteCode(body.invite_code);
    if (!code) return invalidRequest();
    const secret = usableSecret(deps);
    if (!secret) return serverError();

    const result = await callOutcome(deps, 'preview_member_invite', {
      p_code_hash: await inviteCodeHash(secret, code),
      p_client_key_hash: await clientKeyHash(secret, clientAddress(req.headers)),
    });
    if (!result) return serverError();

    switch (result.outcome) {
      case 'ok':
        if (typeof result.first_name !== 'string' || typeof result.last_initial !== 'string') break;
        return respond(200, { outcome: 'ok', first_name: result.first_name, last_initial: result.last_initial });
      case 'invalid_invite':
        return respond(200, { outcome: 'invalid_invite' });
      case 'rate_limited':
        return rateLimited();
    }
    deps.log?.('unexpected_outcome');
    return serverError();
  } catch {
    deps.log?.('unhandled_error');
    return serverError();
  }
}

/**
 * POST { invite_code } -> a claim ticket for that invite. On ok the client
 * signs in anonymously with Supabase Auth, passing { claim_ticket } as the
 * user's metadata, then calls complete_invite_claim.
 *
 *   200 { outcome: 'ok', claim_ticket }
 *   200 { outcome: 'invalid_invite' }
 *   400 { outcome: 'invalid_request' }
 *   429 { outcome: 'rate_limited' }
 *   500 { outcome: 'server_error' }
 */
export async function handleInviteClaimBegin(req: Request, deps: GatewayDeps): Promise<Response> {
  try {
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const code = normalizeInviteCode(body.invite_code);
    if (!code) return invalidRequest();
    const secret = usableSecret(deps);
    if (!secret) return serverError();

    const ticket = newClaimTicket();
    const result = await callOutcome(deps, 'begin_invite_claim', {
      p_code_hash: await inviteCodeHash(secret, code),
      p_ticket_hash: await claimTicketHash(ticket),
      p_client_key_hash: await clientKeyHash(secret, clientAddress(req.headers)),
    });
    if (!result) return serverError();

    switch (result.outcome) {
      case 'ok':
        return respond(200, { outcome: 'ok', claim_ticket: ticket });
      case 'invalid_invite':
        return respond(200, { outcome: 'invalid_invite' });
      case 'rate_limited':
        return rateLimited();
    }
    deps.log?.('unexpected_outcome');
    return serverError();
  } catch {
    deps.log?.('unhandled_error');
    return serverError();
  }
}
