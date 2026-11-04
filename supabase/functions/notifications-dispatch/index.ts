// POST /functions/v1/notifications-dispatch
// Sends queued push notifications. Server-to-server only: the caller presents the
// project's secret key in the `apikey` header, which withSupabase checks
// against SUPABASE_SECRET_KEYS. config.toml sets verify_jwt = false (no user
// JWT is involved). Invoked every few minutes by pg_cron; see the
// notifications migration and ../_shared/dispatch.ts.
import { withSupabase } from '@supabase/server';

import { handleDispatch } from '../_shared/dispatch.ts';

export default {
  fetch: withSupabase({ auth: 'secret', cors: 'disabled', errors: { detailed: false } }, (req, ctx) =>
    handleDispatch(req, {
      rpc: async (fn, args) => {
        const { data, error } = await ctx.supabaseAdmin.rpc(fn, args);
        return { data, error };
      },
      fetch: (input, init) => fetch(input, init),
      expoAccessToken: Deno.env.get('EXPO_ACCESS_TOKEN') || undefined,
      log: (event) => console.error(`notifications-dispatch: ${event}`),
    }),
  ),
};
