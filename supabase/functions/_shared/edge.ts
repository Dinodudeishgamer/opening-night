// Edge runtime wiring for the invite gateway: caller authorization, the
// privileged database client, and the HMAC secret. Kept apart from
// invite-gateway.ts so that module stays runtime-agnostic.
import { withSupabase } from '@supabase/server';

import { type GatewayDeps, INVITE_HMAC_SECRET_NAME } from './invite-gateway.ts';
import type { IssueDeps } from './owner-invites.ts';

type GatewayHandler = (req: Request, deps: GatewayDeps) => Promise<Response>;

// Who may call: the app, identified by the project's publishable key in the
// `apikey` header. withSupabase checks it against the platform-provided
// SUPABASE_PUBLISHABLE_KEYS and answers 401 itself when it is missing or
// wrong, so the handler below only ever runs for an authorized caller. No
// user JWT is involved: these endpoints run before the member has a session.
//
// config.toml sets verify_jwt = false for these functions. That only turns
// off the platform's user-JWT check, which a pre-auth caller cannot pass; it
// authorizes nothing. The publishable-key check here is the authorization.
//
// Only new-format keys (sb_publishable_...) are accepted, which is the key
// the app ships.
//
// The privileged client is ctx.supabaseAdmin, built from the platform-provided
// SUPABASE_SECRET_KEYS. It acts as service_role and never leaves this process.
//
// CORS is on for the endpoints the app calls, so the app also runs in a web
// browser (which is how it is tested without an iPhone build). That widens
// nothing: these endpoints are authorized by a key or a session token sent in
// a header, never by a cookie, so a page on another origin can do no more
// than any other caller holding the same key.
export function serveInviteEndpoint(name: string, handler: GatewayHandler) {
  return {
    fetch: withSupabase(
      { auth: 'publishable', cors: 'default', errors: { detailed: false } },
      (req, ctx) =>
        handler(req, {
          hmacSecret: Deno.env.get(INVITE_HMAC_SECRET_NAME),
          rpc: async (fn, args) => {
            const { data, error } = await ctx.supabaseAdmin.rpc(fn, args);
            return { data, error };
          },
          log: (event) => console.error(`${name}: ${event}`),
        }),
    ),
  };
}

type IssueHandler = (req: Request, deps: IssueDeps) => Promise<Response>;

// Signed-in endpoints. withSupabase verifies the caller's Supabase Auth JWT
// (and the platform does too: verify_jwt stays on for these functions), then
// ctx.supabase is a client carrying that JWT, so every database call runs as
// the caller under RLS. Whether the caller is the owner is decided by the
// database functions, never here. The admin client is not used.
export function serveOwnerEndpoint(name: string, handler: IssueHandler) {
  return {
    fetch: withSupabase({ auth: 'user', cors: 'default', errors: { detailed: false } }, (req, ctx) =>
      handler(req, {
        hmacSecret: Deno.env.get(INVITE_HMAC_SECRET_NAME),
        rpc: async (fn, args) => {
          const { data, error } = await ctx.supabase.rpc(fn, args);
          return { data, error };
        },
        log: (event) => console.error(`${name}: ${event}`),
      }),
    ),
  };
}

// Server-to-server endpoints: the caller presents the project's secret key in
// the `apikey` header, which withSupabase checks against SUPABASE_SECRET_KEYS.
// config.toml sets verify_jwt = false for these (no user JWT is involved).
export function serveSecretEndpoint(name: string, handler: IssueHandler) {
  return {
    fetch: withSupabase({ auth: 'secret', cors: 'disabled', errors: { detailed: false } }, (req, ctx) =>
      handler(req, {
        hmacSecret: Deno.env.get(INVITE_HMAC_SECRET_NAME),
        rpc: async (fn, args) => {
          const { data, error } = await ctx.supabaseAdmin.rpc(fn, args);
          return { data, error };
        },
        log: (event) => console.error(`${name}: ${event}`),
      }),
    ),
  };
}
