/// <reference types="vite/client" />

import type { DesktopApi } from '../../shared/ipc';

declare global {
  interface Window {
    /**
     * Injected by the preload script. Optional so the renderer still renders
     * (without native features) when opened in a plain browser tab.
     */
    desktop?: DesktopApi;
  }

  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
  }
}

export {};
