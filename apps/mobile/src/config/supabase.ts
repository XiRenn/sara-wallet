/**
 * Mobile Supabase bootstrap.
 *
 * Importing this module configures the shared client for the whole app.
 * It is imported (for its side effect) from `index.ts` and from `App.tsx`, so
 * it is impossible to reach a screen before the client exists.
 *
 * `EXPO_PUBLIC_*` variables are inlined by Metro at build time. Changing one
 * requires a restart with a cleared cache: `npx expo start -c`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureSupabase } from '@wallet/shared';
import type { Database, SupabaseClient } from '@wallet/shared';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    [
      'Missing Supabase credentials for the mobile app.',
      '',
      'Fix:',
      '  1. cp apps/mobile/.env.example apps/mobile/.env',
      '  2. fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY',
      '  3. npx expo start -c   (the -c clears the Metro cache)',
    ].join('\n'),
  );
}

/**
 * `AsyncStorage` is passed explicitly rather than relying on auto-detection.
 * It is the one adapter Metro is guaranteed to resolve, and being explicit
 * keeps the storage engine identical between development and production.
 */
export const supabaseClient: SupabaseClient<Database> = configureSupabase({
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  storage: AsyncStorage,
  storageKey: 'sara-wallet.auth',
  // React Native has no address bar to parse an OAuth redirect out of.
  detectSessionInUrl: false,
  debug: __DEV__,
});
