/**
 * Electron main process.
 *
 * Security posture:
 *   • contextIsolation ON, nodeIntegration OFF, sandbox ON
 *   • every navigation and window.open is intercepted — only the dev server
 *     origin is allowed in-app, everything else goes to the system browser
 *   • a strict Content-Security-Policy header is injected in packaged builds
 *     (skipped in dev so Vite's HMR websocket and inline preamble still work)
 *   • the renderer has no filesystem, shell or Node access beyond the
 *     explicitly enumerated IPC channels declared in `src/shared/ipc.ts`
 *
 * Window chrome:
 *   • the window is frameless — the OS title bar is gone and the renderer
 *     paints its own (`components/WindowControls.tsx`, mounted in the top bar)
 *   • on macOS the native traffic lights are kept instead, via
 *     `titleBarStyle: 'hiddenInset'`; the renderer hides its own controls and
 *     pads the top bar to clear them
 *   • the drag region is CSS (`-webkit-app-region: drag` on `.topbar`), so
 *     nothing here needs to know where the bar is
 */

import { join } from 'node:path';

import { app, BrowserWindow, ipcMain, session, shell } from 'electron';

import { IPC, type WindowState } from '../shared/ipc';

const isDev = !app.isPackaged;

/** electron-vite sets this in dev; absent in a packaged build. */
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

let mainWindow: BrowserWindow | null = null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function openExternal(rawUrl: unknown): Promise<boolean> {
  if (typeof rawUrl !== 'string') return false;

  try {
    const parsed = new URL(rawUrl);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
    await shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}

function readWindowState(): WindowState {
  return {
    maximized: mainWindow?.isMaximized() ?? false,
    fullScreen: mainWindow?.isFullScreen() ?? false,
  };
}

function broadcastWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.windowState, readWindowState());
}

/* -------------------------------------------------------------------------- */
/* Content Security Policy                                                     */
/* -------------------------------------------------------------------------- */

function applyContentSecurityPolicy(): void {
  if (isDev) return; // Vite needs 'unsafe-inline' for its dev preamble.

  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Supabase REST + Realtime. Narrow this to your own project ref if you can.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Window                                                                      */
/* -------------------------------------------------------------------------- */

function createWindow(): void {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'Sara Wallet',
    backgroundColor: '#F5F7FA',
    /**
     * Frameless: the renderer's top bar *is* the title bar.
     *
     * macOS keeps its traffic lights (`hiddenInset`) because they sit in a
     * system-controlled cluster the app cannot reproduce — `WindowControls`
     * hides itself there and `.topbar` pads left to clear them.
     *
     * Trade-off on Windows: `frame: false` gives up the Snap Layouts flyout
     * (the hover-the-maximize-button gesture needs a real caption button).
     * Drag-to-edge snapping and double-click-to-maximize still work, because
     * Electron routes the drag region through native hit-testing. If Snap
     * Layouts matter more than the custom look, drop `frame: false` for
     * `titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor,
     * height }` — the buttons stay native and only their colours are yours.
     */
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    // With no OS frame the menu bar has nowhere to live; accelerators still
    // fire, so Ctrl+W / Ctrl+R / F12 keep working.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Avoid the white flash before React paints.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Anything that tries to open a new window goes to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });

  // Block in-app navigation away from the app shell.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = rendererDevUrl !== undefined && url.startsWith(rendererDevUrl);
    const isLocalFile = url.startsWith('file://');

    if (isDevServer || (isLocalFile && !isDev)) return;

    event.preventDefault();
    void openExternal(url);
  });

  // Deny every permission request (camera, geolocation, notifications…).
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  mainWindow.on('maximize', broadcastWindowState);
  mainWindow.on('unmaximize', broadcastWindowState);
  mainWindow.on('enter-full-screen', broadcastWindowState);
  mainWindow.on('leave-full-screen', broadcastWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (rendererDevUrl) {
    void mainWindow.loadURL(rendererDevUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                         */
/* -------------------------------------------------------------------------- */

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getVersion, () => app.getVersion());

  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => openExternal(url));

  ipcMain.on(IPC.minimize, () => mainWindow?.minimize());

  ipcMain.on(IPC.toggleMaximize, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on(IPC.close, () => mainWindow?.close());

  ipcMain.handle(IPC.getWindowState, () => readWindowState());
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

// A second launch focuses the existing window instead of opening a new one.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.sarawallet.desktop');

    applyContentSecurityPolicy();
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
