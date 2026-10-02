/**
 * The window caption buttons.
 *
 * The OS frame is gone (`frame: false` in `src/main/index.ts`), so minimize,
 * maximize/restore and close have to be drawn and wired here. The main process
 * already owned the three channels before this — what is new is that anything
 * calls them.
 *
 * Two details worth knowing:
 *
 *   • The buttons must opt out of the drag region. `.topbar` is
 *     `-webkit-app-region: drag`, and a click inside a drag region is
 *     swallowed by the window manager instead of reaching the button. The
 *     `no-drag` rule lives next to `.window-controls` in `global.css`.
 *
 *   • The maximize glyph has to track the window, and a window can be
 *     *restored already maximized*. The change event only fires on a
 *     transition, so the first paint pulls the current state instead of
 *     assuming "restored" and correcting a frame later.
 *
 * On macOS the main process keeps the native traffic lights
 * (`titleBarStyle: 'hiddenInset'`) and CSS hides this component — see
 * `[data-platform='darwin']` in `global.css`.
 */

import React, { useEffect, useState } from 'react';

import {
  IconWindowClose,
  IconWindowMaximize,
  IconWindowMinimize,
  IconWindowRestore,
} from './Icons';

export function WindowControls() {
  const api = window.desktop;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!api) return;

    let cancelled = false;

    void api
      .getWindowState()
      .then((state) => {
        if (!cancelled) setMaximized(state.maximized);
      })
      .catch(() => {
        // The bar falls back to the restored glyph. Not worth an error state.
      });

    const unsubscribe = api.onWindowStateChange((state) => setMaximized(state.maximized));

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-btn"
        onClick={() => api?.minimize()}
        title="Minimize"
        aria-label="Minimize"
      >
        <IconWindowMinimize />
      </button>

      <button
        type="button"
        className="window-btn"
        onClick={() => api?.toggleMaximize()}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <IconWindowRestore /> : <IconWindowMaximize />}
      </button>

      <button
        type="button"
        className="window-btn is-close"
        onClick={() => api?.close()}
        title="Close"
        aria-label="Close"
      >
        <IconWindowClose />
      </button>
    </div>
  );
}
