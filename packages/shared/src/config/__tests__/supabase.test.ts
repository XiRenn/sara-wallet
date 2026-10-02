import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../utils/errors';
import {
  configureSupabase,
  createMemoryStorage,
  createWebStorage,
  getSupabase,
  isReactNative,
  isSupabaseConfigured,
  registerStorageAdapter,
  resetSupabaseClient,
  resolveStorageAdapter,
  type StorageAdapter,
} from '../supabase';

/**
 * This module is where the Metro-vs-Vite platform problem is solved, so the
 * detection chain is the part most worth pinning down. It is also the part that
 * a browser or device test would struggle to cover, because the interesting
 * branches only exist on the *other* platform.
 */

const URL_A = 'https://project-a.supabase.co';
const URL_B = 'https://project-b.supabase.co';
const KEY = 'anon-key-value';

/** The three env vars `readConfigFromEnvironment` looks at. */
const ENV_KEYS = [
  'SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'VITE_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY',
] as const;

function clearInjectedGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  delete scope.__WALLET_STORAGE__;
  delete scope.__WALLET_SUPABASE_CONFIG__;
}

beforeEach(() => {
  resetSupabaseClient();
  registerStorageAdapter(null);
  clearInjectedGlobals();
  // Blank rather than delete: `readConfigFromEnvironment` treats an empty
  // string as "not configured", and it keeps the test independent of whatever
  // happens to be in the developer's real environment.
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  resetSupabaseClient();
  registerStorageAdapter(null);
  clearInjectedGlobals();
  vi.unstubAllEnvs();
});

describe('createMemoryStorage', () => {
  it('round-trips a value', () => {
    const storage = createMemoryStorage();
    storage.setItem('k', 'v');
    expect(storage.getItem('k')).toBe('v');
  });

  it('returns null for a missing key', () => {
    expect(createMemoryStorage().getItem('nope')).toBeNull();
  });

  it('removes a value', () => {
    const storage = createMemoryStorage();
    storage.setItem('k', 'v');
    storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
  });

  it('overwrites an existing value', () => {
    const storage = createMemoryStorage();
    storage.setItem('k', 'first');
    storage.setItem('k', 'second');
    expect(storage.getItem('k')).toBe('second');
  });

  it('does not share state between instances', () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    a.setItem('k', 'v');
    expect(b.getItem('k')).toBeNull();
  });

  it('satisfies the StorageAdapter contract synchronously', () => {
    const storage: StorageAdapter = createMemoryStorage();
    expect(storage.getItem('k')).not.toBeInstanceOf(Promise);
  });
});

describe('createWebStorage', () => {
  it('is a no-op rather than a crash when localStorage is absent', () => {
    // Node has no localStorage, which is exactly the "hardened webview" case
    // the optional chaining in this adapter exists for.
    const storage = createWebStorage();
    expect(() => storage.setItem('k', 'v')).not.toThrow();
    expect(storage.getItem('k')).toBeNull();
    expect(() => storage.removeItem('k')).not.toThrow();
  });
});

describe('isReactNative', () => {
  it('is false in Node', () => {
    expect(isReactNative()).toBe(false);
  });

  it('is true when navigator.product says so', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    expect(isReactNative()).toBe(true);
  });

  it('is false for a browser navigator', () => {
    vi.stubGlobal('navigator', { product: 'Gecko' });
    expect(isReactNative()).toBe(false);
  });
});

describe('resolveStorageAdapter — the detection chain', () => {
  it('prefers an explicitly registered adapter', () => {
    const injected = createMemoryStorage();
    registerStorageAdapter(injected);
    expect(resolveStorageAdapter()).toBe(injected);
  });

  it('falls back to the global adapter when nothing is registered', () => {
    const global = createMemoryStorage();
    (globalThis as Record<string, unknown>).__WALLET_STORAGE__ = global;
    expect(resolveStorageAdapter()).toBe(global);
  });

  it('lets an explicitly registered adapter win over the global one', () => {
    const registered = createMemoryStorage();
    const global = createMemoryStorage();
    registerStorageAdapter(registered);
    (globalThis as Record<string, unknown>).__WALLET_STORAGE__ = global;
    expect(resolveStorageAdapter()).toBe(registered);
  });

  it('uses localStorage on the web', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    const adapter = resolveStorageAdapter();
    adapter.setItem('k', 'v');
    expect(store.get('k')).toBe('v');
  });

  it('loads AsyncStorage on React Native through the indirect require', () => {
    const asyncStorage = createMemoryStorage();
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('require', (id: string) =>
      id === '@react-native-async-storage/async-storage' ? { default: asyncStorage } : undefined,
    );

    expect(resolveStorageAdapter()).toBe(asyncStorage);
  });

  it('accepts an AsyncStorage module without a default export', () => {
    const asyncStorage = createMemoryStorage();
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('require', () => asyncStorage);

    expect(resolveStorageAdapter()).toBe(asyncStorage);
  });

  it('degrades to memory on RN when the module cannot be required', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('require', () => {
      throw new Error('module not found');
    });

    const adapter = resolveStorageAdapter();
    adapter.setItem('k', 'v');
    expect(adapter.getItem('k')).toBe('v');
  });

  it('degrades to memory on RN when require returns something unusable', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('require', () => ({ nope: true }));

    const adapter = resolveStorageAdapter();
    expect(typeof adapter.getItem).toBe('function');
    expect(typeof adapter.setItem).toBe('function');
    expect(typeof adapter.removeItem).toBe('function');
  });

  it('degrades to memory when there is no require at all', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('require', undefined);

    const adapter = resolveStorageAdapter();
    adapter.setItem('k', 'v');
    expect(adapter.getItem('k')).toBe('v');
  });

  it('always returns a usable adapter', () => {
    const adapter = resolveStorageAdapter();
    expect(typeof adapter.getItem).toBe('function');
    expect(typeof adapter.setItem).toBe('function');
    expect(typeof adapter.removeItem).toBe('function');
  });
});

describe('configureSupabase — validation', () => {
  it('rejects a missing url', () => {
    expect(() => configureSupabase({ url: '', anonKey: KEY })).toThrow(AppError);
  });

  it('rejects a url that is not http(s)', () => {
    const error = (() => {
      try {
        configureSupabase({ url: 'example.supabase.co', anonKey: KEY });
        return null;
      } catch (thrown) {
        return thrown as AppError;
      }
    })();
    expect(error?.code).toBe('validation_error');
    expect(error?.message).toContain('http');
  });

  it('rejects a missing anon key', () => {
    expect(() => configureSupabase({ url: URL_A, anonKey: '' })).toThrow(AppError);
  });

  it('leaves the client unconfigured after a rejected call', () => {
    try {
      configureSupabase({ url: '', anonKey: KEY });
    } catch {
      // expected
    }
    expect(isSupabaseConfigured()).toBe(false);
  });
});

describe('configureSupabase — singleton behaviour', () => {
  it('returns the same instance for the same credentials', () => {
    const first = configureSupabase({ url: URL_A, anonKey: KEY });
    const second = configureSupabase({ url: URL_A, anonKey: KEY });
    expect(second).toBe(first);
  });

  it('refuses to swap the backend mid-session', () => {
    configureSupabase({ url: URL_A, anonKey: KEY });
    expect(() => configureSupabase({ url: URL_B, anonKey: KEY })).toThrow(AppError);
  });

  it('refuses to swap the anon key mid-session', () => {
    configureSupabase({ url: URL_A, anonKey: KEY });
    expect(() => configureSupabase({ url: URL_A, anonKey: 'other-key' })).toThrow(AppError);
  });

  it('keeps the original client after a refused swap', () => {
    const original = configureSupabase({ url: URL_A, anonKey: KEY });
    try {
      configureSupabase({ url: URL_B, anonKey: KEY });
    } catch {
      // expected
    }
    expect(getSupabase()).toBe(original);
  });

  it('reports itself as configured', () => {
    expect(isSupabaseConfigured()).toBe(false);
    configureSupabase({ url: URL_A, anonKey: KEY });
    expect(isSupabaseConfigured()).toBe(true);
  });

  it('resets cleanly', () => {
    configureSupabase({ url: URL_A, anonKey: KEY });
    resetSupabaseClient();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it('uses an explicitly supplied storage adapter', () => {
    const storage = createMemoryStorage();
    configureSupabase({ url: URL_A, anonKey: KEY, storage });
    // No public accessor for the adapter, so assert the client was built and
    // that auth can read through it without throwing.
    expect(isSupabaseConfigured()).toBe(true);
    expect(() => getSupabase().auth.getSession()).not.toThrow();
  });

  it('defaults detectSessionInUrl to false outside a browser', () => {
    // Nothing to assert on the client directly; what matters is that building
    // one in Node does not throw while looking for `window.location`.
    expect(() => configureSupabase({ url: URL_A, anonKey: KEY })).not.toThrow();
  });
});

describe('getSupabase — fallback configuration', () => {
  it('throws when nothing is configured', () => {
    const error = (() => {
      try {
        getSupabase();
        return null;
      } catch (thrown) {
        return thrown as AppError;
      }
    })();
    expect(error?.code).toBe('validation_error');
    expect(error?.message).toContain('configureSupabase');
  });

  it('configures itself from __WALLET_SUPABASE_CONFIG__', () => {
    (globalThis as Record<string, unknown>).__WALLET_SUPABASE_CONFIG__ = {
      url: URL_A,
      anonKey: KEY,
    };
    expect(isSupabaseConfigured()).toBe(false);
    expect(getSupabase()).toBeTruthy();
    expect(isSupabaseConfigured()).toBe(true);
  });

  it('ignores an incomplete __WALLET_SUPABASE_CONFIG__', () => {
    (globalThis as Record<string, unknown>).__WALLET_SUPABASE_CONFIG__ = { url: URL_A };
    expect(() => getSupabase()).toThrow(AppError);
  });

  it('configures itself from EXPO_PUBLIC_* variables', () => {
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', URL_A);
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', KEY);
    expect(getSupabase()).toBeTruthy();
  });

  it('configures itself from VITE_* variables', () => {
    vi.stubEnv('VITE_SUPABASE_URL', URL_A);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', KEY);
    expect(getSupabase()).toBeTruthy();
  });

  it('prefers SUPABASE_URL over the framework-prefixed ones', () => {
    vi.stubEnv('SUPABASE_URL', URL_A);
    vi.stubEnv('SUPABASE_ANON_KEY', KEY);
    vi.stubEnv('VITE_SUPABASE_URL', URL_B);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'vite-key');

    const client = getSupabase();
    expect(client).toBeTruthy();
    // Swapping in the other project must now be refused, which proves which
    // credentials were actually used.
    expect(() => configureSupabase({ url: URL_B, anonKey: 'vite-key' })).toThrow(AppError);
  });

  it('stays unconfigured when only half the pair is present', () => {
    vi.stubEnv('SUPABASE_URL', URL_A);
    expect(() => getSupabase()).toThrow(AppError);
  });
});
