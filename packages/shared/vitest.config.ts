import { defineConfig } from 'vitest/config';

/**
 * The shared package is consumed as TypeScript source by both Metro and Vite,
 * so there is no build step to hook into — Vitest compiles the same files the
 * apps do, straight from `src/`.
 *
 * `environment: 'node'` is deliberate: every module under test is written to
 * work without a DOM (that is the whole point of the storage-adapter chain in
 * `config/supabase.ts`), and a Node environment proves it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Tests that install globals or monkey-patch adapters must not leak into
    // their neighbours.
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
});
