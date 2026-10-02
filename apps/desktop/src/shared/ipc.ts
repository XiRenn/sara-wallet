/**
 * The IPC contract between the main process, the preload bridge and the
 * renderer. Types only — this file is imported by all three, so it must not
 * reference `electron` or any DOM global.
 */

export const IPC = {
  getVersion: 'app:get-version',
  openExternal: 'shell:open-external',
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  windowState: 'window:state',
  getWindowState: 'window:get-state',
} as const;

export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
}

/**
 * The exact surface exposed on `window.desktop` by the preload script.
 * The renderer never touches `ipcRenderer` directly.
 */
/** `process.platform` values, spelled out so this file stays Node-type free. */
export type DesktopPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

export interface DesktopApi {
  readonly platform: DesktopPlatform;
  readonly versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  /** Resolves with `app.getVersion()` from the main process. */
  getAppVersion(): Promise<string>;
  /**
   * Opens a URL in the user's default browser.
   * Only `https:`, `http:` and `mailto:` are accepted; anything else resolves
   * with `false`.
   */
  openExternal(url: string): Promise<boolean>;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  /**
   * The window's state right now. The change event below only fires on a
   * transition, so the custom title bar needs one pull to paint its first
   * frame correctly — a window can be restored already maximized.
   */
  getWindowState(): Promise<WindowState>;
  /** Returns an unsubscribe function. */
  onWindowStateChange(listener: (state: WindowState) => void): () => void;
}
