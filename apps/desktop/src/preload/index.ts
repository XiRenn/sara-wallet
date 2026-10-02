/**
 * Preload bridge.
 *
 * Runs in an isolated context with `sandbox: true`. It exposes a small,
 * explicitly enumerated API on `window.desktop` — never `ipcRenderer` itself,
 * because handing the renderer a raw IPC handle would let any injected script
 * reach every channel in the main process.
 *
 * No Supabase code runs here. Auth and data access happen entirely inside the
 * renderer, over HTTPS, exactly as they do in the mobile app.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type DesktopApi, type WindowState } from '../shared/ipc';

const api: DesktopApi = {
  platform: process.platform,

  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  getAppVersion: () => ipcRenderer.invoke(IPC.getVersion) as Promise<string>,

  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC.openExternal, url) as Promise<boolean>,

  minimize: () => ipcRenderer.send(IPC.minimize),

  toggleMaximize: () => ipcRenderer.send(IPC.toggleMaximize),

  close: () => ipcRenderer.send(IPC.close),

  getWindowState: () =>
    ipcRenderer.invoke(IPC.getWindowState) as Promise<WindowState>,

  onWindowStateChange: (listener: (state: WindowState) => void) => {
    const handler = (_event: unknown, state: WindowState) => listener(state);
    ipcRenderer.on(IPC.windowState, handler);
    return () => {
      ipcRenderer.removeListener(IPC.windowState, handler);
    };
  },
};

contextBridge.exposeInMainWorld('desktop', api);
