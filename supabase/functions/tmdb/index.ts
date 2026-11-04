// POST /functions/v1/tmdb
// Movie search and details for creating an event, so the TMDB credential
// stays server-side. Signed-in endpoint: the platform JWT check stays on and
// withSupabase verifies the session again. The database is asked, with the
// caller's own session, whether they are the owner. See ../_shared/tmdb.ts.
import { withSupabase } from '@supabase/server';

import { handleTmdb, TMDB_SECRET_NAME } from '../_shared/tmdb.ts';

export default {
  fetch: withSupabase({ auth: 'user', cors: 'default', errors: { detailed: false } }, (req, ctx) =>
    handleTmdb(req, {
      rpc: async (fn, args) => {
        const { data, error } = await ctx.supabase.rpc(fn, args);
        return { data, error };
      },
      fetch: (input, init) => fetch(input, init),
      apiKey: Deno.env.get(TMDB_SECRET_NAME),
      log: (event) => console.error(`tmdb: ${event}`),
    }),
  ),
};
