/**
 * Theme and colour helpers for the desktop renderer.
 *
 * Two unrelated jobs live here because they share one idea: the renderer
 * decides *which* colour, and `global.css` decides *how* that colour is
 * expressed in the active theme. Nothing here hard-codes a hex value.
 */

import type React from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'sara-wallet.theme';

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/**
 * The theme to start in: the user's last explicit choice, otherwise whatever
 * the OS reports. Runs before React mounts (see `main.tsx`) so the first paint
 * is already correct — the Electron window is hidden until `ready-to-show`,
 * so there is no flash to hide.
 */
export function readStoredTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch {
    // localStorage can be unavailable (private mode, blocked storage). The OS
    // preference is a perfectly good fallback, so this is not an error.
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Writes the attribute the stylesheet keys off. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset['theme'] = mode;
}

export function storeTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A theme that cannot be remembered for next launch is not worth an error.
  }
}

/* -------------------------------------------------------------------------- */
/* Category colours                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Stable hash. `charCodeAt` with the classic 31-multiplier — we only need
 * determinism across sessions, not cryptographic quality.
 */
function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0; // keep it in 32-bit range
  }
  return Math.abs(hash);
}

/**
 * A hue in `[0, 360)` for a category name.
 *
 * Categories are free text in the database, so the colour cannot come from a
 * fixed lookup table — a custom category would land on the same fallback as
 * every other custom category. Hashing the name instead means "Food" is always
 * the same colour everywhere it appears, and an unknown category still gets a
 * colour of its own.
 *
 * The golden-angle multiplier spreads consecutive hashes far apart in hue,
 * which stops similar names (or names differing by one character) from
 * producing near-identical colours.
 */
export function categoryHue(name: string): number {
  return (hashString(name) * 137) % 360;
}

/**
 * Inline style carrying the hue. The stylesheet turns it into a concrete
 * colour, so lightness/saturation can differ between light and dark themes
 * without the renderer knowing which one is active.
 */
export function categoryStyle(name: string): React.CSSProperties {
  return { '--cat-hue': categoryHue(name) } as React.CSSProperties;
}
