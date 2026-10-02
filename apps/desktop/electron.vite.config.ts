import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * electron-vite builds three bundles:
 *
 *   main     → out/main/index.js      (Node context, deps externalised)
 *   preload  → out/preload/index.js   (isolated context, deps externalised)
 *   renderer → out/renderer/**        (browser context, everything bundled)
 *
 * Only the renderer imports `@wallet/shared`. It is aliased to the TypeScript
 * source and excluded from the dependency optimiser so edits in
 * `packages/shared` hot-reload instantly.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@wallet/shared': resolve(__dirname, '../../packages/shared/index.ts'),
      },
    },
    optimizeDeps: {
      // Linked workspace source must not be pre-bundled.
      exclude: ['@wallet/shared'],
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  },
});
