/**
 * Design tokens.
 *
 * ── A note on INCOME / EXPENSE colours ──────────────────────────────────────
 * This project follows the Chinese-market convention for financial figures:
 * a **rise** is red and a **fall** is green. For a wallet that means money
 * coming in is red and money going out is green.
 *
 * If you would rather use the Western convention, swap these two values —
 * nothing else in the codebase hardcodes either colour.
 */

export const colors = {
  background: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF2F7',
  surfaceSunken: '#E4E9F0',

  border: '#E1E6EE',
  borderStrong: '#CBD3E0',

  text: '#0F172A',
  textMuted: '#64748B',
  textFaint: '#94A3B8',
  textInverse: '#FFFFFF',

  primary: '#2563EB',
  primaryPressed: '#1D4ED8',
  primarySoft: '#E6EEFE',

  /** Money in — balance rises. Red, per the convention above. */
  income: '#D92D20',
  incomeSoft: '#FEF3F2',

  /** Money out — balance falls. Green, per the convention above. */
  expense: '#079455',
  expenseSoft: '#ECFDF3',

  warning: '#B54708',
  warningSoft: '#FFFAEB',

  danger: '#B42318',
  dangerSoft: '#FEF3F2',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 30,
  display: 38,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** 4-point shadow preset that renders acceptably on both platforms. */
export const shadow = {
  card: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  floating: {
    shadowColor: '#1D4ED8',
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Derived colours                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Stable hash. `charCodeAt` with the classic 31-multiplier — we only need
 * determinism across sessions, not cryptographic quality.
 *
 * Byte-for-byte the same as the desktop's copy in
 * `apps/desktop/src/renderer/src/theme.ts`, so a counterparty or category gets
 * the *same* colour in both apps rather than two unrelated ones.
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
 * A hue in `[0, 360)` for a free-text name.
 *
 * Names here are free text in the database — a counterparty, a category — so
 * the colour cannot come from a fixed lookup table: every custom name would
 * land on the same fallback. Hashing means "Daw Hla" is always the same colour
 * wherever it appears, and an unknown name still gets one of its own.
 *
 * The golden-angle multiplier spreads consecutive hashes far apart in hue,
 * which stops similar names from producing near-identical colours.
 */
export function categoryHue(name: string): number {
  return (hashString(name) * 137) % 360;
}

/** HSL → `#rrggbb`. Exported so the contrast guarantee below is testable. */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;

  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;

  const [r, g, b] =
    hue < 60
      ? [chroma, secondary, 0]
      : hue < 120
        ? [secondary, chroma, 0]
        : hue < 180
          ? [0, chroma, secondary]
          : hue < 240
            ? [0, secondary, chroma]
            : hue < 300
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];

  const channel = (value: number) =>
    Math.round((value + match) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The avatar's fill and ink. Named and exported so the contrast guarantee can
 * be asserted against the same numbers the implementation uses, rather than a
 * copy of them that is free to drift.
 */
export const AVATAR_SATURATION = 66;
export const AVATAR_FILL_LIGHTNESS = 90;
export const AVATAR_INK_LIGHTNESS = 26;

/**
 * The colours for a name's avatar — a soft tinted fill with dark ink.
 *
 * Not a solid fill with white text, which is what the desktop does. Measured
 * across all 360 hues at the desktop's `--cat-saturation: 66%`, white text on
 * the solid `hsl(h 66% 45%)` fill bottoms out at **1.98:1** (worst at hue 60 —
 * yellow is far brighter than blue at the same lightness). Clearing AA for
 * white text would need lightness ≤ 28.5%, which is a muddy near-black blob.
 *
 * The tinted pair inverts that: fill at 90% lightness, ink at 26%, which
 * measures **4.88:1 or better for every hue**. It also matches how the app
 * already tints category chips, so the avatar reads as part of the same system.
 */
export function categoryColors(name: string): { background: string; text: string } {
  const hue = categoryHue(name);
  return {
    background: hslToHex(hue, AVATAR_SATURATION, AVATAR_FILL_LIGHTNESS),
    text: hslToHex(hue, AVATAR_SATURATION, AVATAR_INK_LIGHTNESS),
  };
}

export const theme = {
  colors,
  spacing,
  radii,
  fontSize,
  fontWeight,
  shadow,
} as const;

export type Theme = typeof theme;
