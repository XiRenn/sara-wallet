// electron.vite.config.ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
var __electron_vite_injected_dirname = "D:\\My App\\sara-wallet\\apps\\desktop";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer/src"),
        "@wallet/shared": resolve(__electron_vite_injected_dirname, "../../packages/shared/index.ts")
      }
    },
    optimizeDeps: {
      // Linked workspace source must not be pre-bundled.
      exclude: ["@wallet/shared"]
    },
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") }
      }
    },
    server: {
      port: 5173,
      strictPort: true
    }
  }
});
export {
  electron_vite_config_default as default
};
