import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

// The only two values the app is built with: where the project is, and its
// publishable key. Both are public by design. Everything a member may do is
// decided by the database (RLS and the RPCs), never by what the app holds.
// No secret key, service-role key, HMAC secret, or TMDB key belongs in an
// EXPO_PUBLIC_* variable: those are inlined into the bundle.
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  // These are inlined at build time, so a missing .env otherwise fails deep
  // inside the client with "supabaseUrl is required".
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill it in.',
  );
}
if (!SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')) {
  throw new Error('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be the project publishable key (sb_publishable_...).');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
