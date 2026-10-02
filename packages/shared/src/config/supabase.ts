/**
 * Supabase client setup, shared by Expo and Electron.
 *
 * ── Why this file looks the way it does ─────────────────────────────────────
 * The two bundlers are mutually hostile when it comes to platform detection:
 *
 *   • Metro (React Native) understands `require()` but chokes on `import.meta`.
 *   • Vite (Electron renderer) understands `import.meta.env` but a bare
 *     `require('@react-native-async-storage/async-storage')` makes the build
 *     try to resolve a React-Native-only package.
 *
 * So instead of guessing, the storage engine is resolved at runtime through a
 * chain of safe checks, and every app can also inject one explicitly:
 *
 *   1. an adapter passed to `configureSupabase({ storage })`
 *   2. a `globalThis.__WALLET_STORAGE__` adapter (registered by the app entry)
 *   3. AsyncStorage on React Native (loaded through an indirect require that
 *      web bundlers cannot statically analyse)
 *   4. `localStorage` on web / Electron renderer
 *   5. an in-memory adapter as the last resort (session is lost on reload, but
 *      nothing crashes — which is what you want in SSR or a sandboxed webview)
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 * Call `configureSupabase()` exactly once, as early as possible:
 *
 *   // apps/mobile/index.ts
 *   import { configureSupabase } from '@wallet/shared';
 *   configureSupabase({
 *     url: process.env.EXPO_PUBLIC_SUPABASE_URL!,
 *     anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
 *     storage: AsyncStorage,
 *   });
 *
 * Every service then imports `getSupabase()` (or the `supabase` proxy) and
 * gets the configured instance.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../types/database';
import { AppError } from '../utils/errors';

/* -------------------------------------------------------------------------- */
/* Storage adapters                                                            */
/* -------------------------------------------------------------------------- */

/** The exact contract Supabase auth expects from a storage engine. */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** Non-persistent fallback. Keeps auth working inside a bare webview/SSR. */
export function createMemoryStorage(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/** Explicit localStorage adapter — used when auto-detection is not wanted. */
export function createWebStorage(): StorageAdapter {
  return {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => {
      globalThis.localStorage?.setItem(key, value);
    },
    removeItem: (key) => {
      globalThis.localStorage?.removeItem(key);
    },
  };
}

/** True when we are running inside React Native / Expo. */
export function isReactNative(): boolean {
  const nav = (globalThis as { navigator?: { product?: string } }).navigator;
  return typeof nav !== 'undefined' && nav?.product === 'ReactNative';
}

/**
 * Loads AsyncStorage without a static `require`/`import`, so Vite and Rollup
 * never try to resolve a package that only exists in the mobile workspace.
 */
function loadAsyncStorage(): StorageAdapter | null {
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req !== 'function') return null;

    const loaded = req('@react-native-async-storage/async-storage') as
      | { default?: StorageAdapter }
      | StorageAdapter
      | undefined;

    const candidate =
      (loaded as { default?: StorageAdapter } | undefined)?.default ??
      (loaded as StorageAdapter | undefined);

    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      return candidate;
    }
    return null;
  } catch {
    // Package not installed, or the bundler refused the dynamic require.
    return null;
  }
}

let storageOverride: StorageAdapter | null = null;

/** Injects a storage adapter for the whole process. Call before configuring. */
export function registerStorageAdapter(adapter: StorageAdapter | null): void {
  storageOverride = adapter;
}

/** Walks the detection chain described at the top of this file. */
export function resolveStorageAdapter(): StorageAdapter {
  if (storageOverride) return storageOverride;

  const injected = (globalThis as { __WALLET_STORAGE__?: StorageAdapter })
    .__WALLET_STORAGE__;
  if (injected) return injected;

  if (isReactNative()) {
    const asyncStorage = loadAsyncStorage();
    if (asyncStorage) return asyncStorage;
    return createMemoryStorage();
  }

  try {
    if (typeof globalThis.localStorage !== 'undefined') return createWebStorage();
  } catch {
    // Accessing localStorage can throw in a hardened webview.
  }

  return createMemoryStorage();
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface SupabaseConfig {
  /** `https://<project-ref>.supabase.co` */
  url: string;
  /** The **anon** key. Never the service-role key — this runs on-device. */
  anonKey: string;
  /** Overrides auto-detection. */
  storage?: StorageAdapter;
  /** Key the session is persisted under. */
  storageKey?: string;
  /**
   * Parses `#access_token=...` out of the URL after an OAuth redirect.
   * Defaults to `true` on web, `false` on React Native.
   */
  detectSessionInUrl?: boolean;
  /** Verbose supabase-js auth logging. */
  debug?: boolean;
}

const DEFAULT_STORAGE_KEY = 'wallet.auth.token';

let client: SupabaseClient<Database> | null = null;
let activeConfig: SupabaseConfig | null = null;

function assertValidConfig(config: SupabaseConfig): void {
  if (typeof config.url !== 'string' || config.url.trim().length === 0) {
    throw new AppError(
      'configureSupabase(): `url` is required.',
      'validation_error',
      config,
    );
  }
  if (!/^https?:\/\//i.test(config.url)) {
    throw new AppError(
      `configureSupabase(): \`url\` must start with http(s):// (received "${config.url}").`,
      'validation_error',
      config,
    );
  }
  if (typeof config.anonKey !== 'string' || config.anonKey.trim().length === 0) {
    throw new AppError(
      'configureSupabase(): `anonKey` is required.',
      'validation_error',
      config,
    );
  }
}

/**
 * Creates (or returns) the singleton client.
 * Idempotent for identical credentials; throws if called with a different
 * project, because silently swapping the backend mid-session is a bug magnet.
 */
export function configureSupabase(config: SupabaseConfig): SupabaseClient<Database> {
  assertValidConfig(config);

  if (client) {
    const sameProject =
      activeConfig?.url === config.url && activeConfig?.anonKey === config.anonKey;
    if (sameProject) return client;

    throw new AppError(
      'Supabase is already configured with different credentials. Call configureSupabase() exactly once, at app start-up.',
      'validation_error',
    );
  }

  const reactNative = isReactNative();

  client = createClient<Database>(config.url, config.anonKey, {
    auth: {
      storage: config.storage ?? resolveStorageAdapter(),
      storageKey: config.storageKey ?? DEFAULT_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      // Only meaningful in a browser; on RN the redirect is handled manually.
      detectSessionInUrl: config.detectSessionInUrl ?? !reactNative,
      flowType: 'pkce',
      debug: config.debug ?? false,
    },
    global: {
      headers: { 'x-application-name': 'sara-wallet' },
    },
    db: { schema: 'public' },
  });

  activeConfig = config;
  return client;
}

/** True once `configureSupabase()` has run. */
export function isSupabaseConfigured(): boolean {
  return client !== null;
}

/**
 * Returns the client, configuring it from the environment as a last resort.
 *
 * The env lookup is deliberately defensive: `process` does not exist in the
 * Vite renderer, and touching `process.env` there would throw at runtime.
 */
export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;

  const fallback = readConfigFromEnvironment();
  if (fallback) return configureSupabase(fallback);

  throw new AppError(
    'Supabase is not configured. Call configureSupabase({ url, anonKey }) once during app start-up.',
    'validation_error',
  );
}

/** Escape hatch for tests and for swapping the client in Storybook. */
export function resetSupabaseClient(): void {
  client = null;
  activeConfig = null;
}

/* -------------------------------------------------------------------------- */
/* Environment fallback                                                        */
/* -------------------------------------------------------------------------- */

function readProcessEnv(): Record<string, string | undefined> | null {
  try {
    const maybeProcess = (globalThis as { process?: { env?: unknown } }).process;
    if (maybeProcess && typeof maybeProcess.env === 'object' && maybeProcess.env) {
      return maybeProcess.env as Record<string, string | undefined>;
    }
  } catch {
    // `process` is not defined — expected in the Electron renderer.
  }
  return null;
}

/**
 * First value that is genuinely usable.
 *
 * `??` is not enough here: a bundler that defines an unset variable as `''`
 * (Vite and some `process.env` shims both do) would make `'' ?? x` return `''`
 * and shadow a perfectly good fallback, leaving the app permanently
 * "unconfigured" with the real credentials sitting right there.
 */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function readConfigFromEnvironment(): SupabaseConfig | null {
  const injected = (globalThis as { __WALLET_SUPABASE_CONFIG__?: unknown })
    .__WALLET_SUPABASE_CONFIG__;
  if (injected && typeof injected === 'object') {
    const candidate = injected as Partial<SupabaseConfig>;
    if (typeof candidate.url === 'string' && typeof candidate.anonKey === 'string') {
      return candidate as SupabaseConfig;
    }
  }

  const env = readProcessEnv();
  if (!env) return null;

  const url = firstNonEmpty(
    env.SUPABASE_URL,
    env.EXPO_PUBLIC_SUPABASE_URL,
    env.VITE_SUPABASE_URL,
  );
  const anonKey = firstNonEmpty(
    env.SUPABASE_ANON_KEY,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    env.VITE_SUPABASE_ANON_KEY,
  );

  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/* -------------------------------------------------------------------------- */
/* Ergonomic proxy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `supabase.from('wallets')...` without having to call `getSupabase()` first.
 *
 * Every property read is forwarded to the real client, and methods are bound
 * to it, so `supabase.auth`, `supabase.rpc(...)` and friends all behave
 * exactly as they would on the raw instance.
 */
export const supabase: SupabaseClient<Database> = new Proxy(
  {} as SupabaseClient<Database>,
  {
    get(_target, property) {
      const instance = getSupabase();
      const value = Reflect.get(instance, property, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    has(_target, property) {
      return property in getSupabase();
    },
  },
);
