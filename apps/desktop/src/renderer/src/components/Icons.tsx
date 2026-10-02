/**
 * The desktop icon set.
 *
 * Inline SVG rather than an icon package: the renderer is a sandboxed Electron
 * page with a strict CSP, and the app needs a dozen glyphs — a dependency with
 * a font loader or a sprite sheet would be more moving parts than the whole
 * set is worth. Every icon inherits `currentColor` and takes an explicit size,
 * so they follow the theme tokens automatically.
 */

import React from 'react';

export interface IconProps {
  /** Square edge length in px. Defaults to 16. */
  size?: number;
  className?: string;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    focusable: false,
    'aria-hidden': true,
  };
}

export function IconWallet({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 8.5V7a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 0 3 7.5v9A2.5 2.5 0 0 0 5.5 19H18a2 2 0 0 0 2-2v-1.5" />
      <path d="M21 9.5h-4.25a2.25 2.25 0 0 0 0 4.5H21a1 1 0 0 0 1-1v-2.5a1 1 0 0 0-1-1Z" />
    </svg>
  );
}

export function IconArrowUpRight({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 17 17 7" />
      <path d="M8.5 7H17v8.5" />
    </svg>
  );
}

export function IconArrowDownRight({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 7l10 10" />
      <path d="M17 8.5V17H8.5" />
    </svg>
  );
}

export function IconTransfer({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 4 4 8l4 4" />
      <path d="M4 8h16" />
      <path d="m16 20 4-4-4-4" />
      <path d="M20 16H4" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9L21 8.7" />
      <path d="M21 3.5v5.2h-5.2" />
      <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3 15.3" />
      <path d="M3 20.5v-5.2h5.2" />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="11" cy="11" r="6.75" />
      <path d="m20 20-3.7-3.7" />
    </svg>
  );
}

export function IconChevronLeft({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

export function IconSun({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function IconMoon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z" />
    </svg>
  );
}

export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function IconPencil({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17l-1 3Z" />
      <path d="m14.5 7.5 2 2" />
    </svg>
  );
}

export function IconTrash({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.5 7h15" />
      <path d="M10 11.5v5.5M14 11.5v5.5" />
      <path d="M6.5 7l.9 12.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7" />
      <path d="M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
    </svg>
  );
}

export function IconSignOut({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="m10 8-4 4 4 4" />
      <path d="M6 12h10" />
    </svg>
  );
}

export function IconPie({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3a9 9 0 1 0 9 9h-9V3Z" />
    </svg>
  );
}

export function IconAlert({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10.3 4 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.8h.01" />
    </svg>
  );
}

export function IconInbox({ size = 32, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 13.5h4.2l1.4 2.4h5.8l1.4-2.4h4.2" />
      <path d="M5.6 5h12.8l2.1 8.5v5.4a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-5.4L5.6 5Z" />
    </svg>
  );
}

/**
 * The AP/AR mark. Deliberately not one of the arrow glyphs: those already mean
 * "money in" and "money out" on the ledger, and a debt is neither — it is a
 * promise, and reusing an arrow would say the cash had already moved.
 */
export function IconHandCoins({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="15.5" cy="7.5" r="3.25" />
      <path d="M13.9 7.5h3.2M15.5 5.9v3.2" />
      <path d="M8.5 12.5H4.2a1.7 1.7 0 0 0-1.7 1.7v.9l3.3 3.3a2 2 0 0 0 1.4.6h4.3a2 2 0 0 0 1.5-.7l3.4-3.9" />
      <path d="m9.8 14.4 2.5 2.4a1.4 1.4 0 0 0 2-2l-2.6-2.5" />
      <path d="M6.2 12.5 4 15.4" />
    </svg>
  );
}

/** A bill — the "you owe" side of the pair. */
export function IconReceipt({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5.5 3.5h13v16.2l-2.2-1.5-2.2 1.5-2.1-1.5-2.2 1.5-2.2-1.5-2.1 1.5V3.5Z" />
      <path d="M9 8.5h6M9 12.5h4" />
    </svg>
  );
}

export function IconClock({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.4V12l3 1.8" />
    </svg>
  );
}

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m5 12.6 4.6 4.6L19 7.4" />
    </svg>
  );
}

export function IconLock({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.2" />
      <path d="M8 10V7.6a4 4 0 0 1 8 0V10" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Window controls                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The three caption glyphs.
 *
 * Deliberately not built on `base()`: those icons are drawn in a 24-unit box
 * at 1.75 stroke, which at caption size lands a hairline under a pixel and
 * greys out. These use a 10-unit box at 1 stroke with half-pixel coordinates,
 * so at 1× DPR they land on exact device pixels — a real 1px hairline, the
 * way the system caption buttons draw them.
 */
function captionBase(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 10 10',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1,
    strokeLinecap: 'butt' as const,
    strokeLinejoin: 'miter' as const,
    focusable: false,
    'aria-hidden': true,
  };
}

export function IconWindowMinimize({ size = 10, className }: IconProps) {
  return (
    <svg {...captionBase(size)} className={className}>
      <path d="M0 5.5h10" />
    </svg>
  );
}

export function IconWindowMaximize({ size = 10, className }: IconProps) {
  return (
    <svg {...captionBase(size)} className={className}>
      <rect x="0.5" y="0.5" width="9" height="9" />
    </svg>
  );
}

/** Two offset squares — the glyph a maximized window shows to restore down. */
export function IconWindowRestore({ size = 10, className }: IconProps) {
  return (
    <svg {...captionBase(size)} className={className}>
      <path d="M2.5 2.5V0.5h7v7H7.5" />
      <rect x="0.5" y="2.5" width="7" height="7" />
    </svg>
  );
}

export function IconWindowClose({ size = 10, className }: IconProps) {
  return (
    <svg {...captionBase(size)} className={className}>
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
    </svg>
  );
}
