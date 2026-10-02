/**
 * Sanity-checks the mobile hue helper.
 *
 * The desktop resolves `--cat-hue` in CSS; React Native has no custom
 * properties, so the mobile copy has to resolve concrete colours itself. That
 * makes `hslToHex` new logic nothing else exercises — if it is wrong every debt
 * avatar is wrong, and a wrong colour is not something a typecheck or a bundle
 * build would ever notice.
 *
 * The contrast assertion is the one that earned its keep: it is what caught the
 * original white-on-solid-fill avatar failing AA at 1.98:1.
 *
 * Run: `node .review/hue-check.mjs` — it compiles the real theme.ts itself, so
 * there is no build step to remember.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = join(here, '_huecheck');

// Compile the *real* source rather than re-implementing it — a copy would be
// free to drift from the thing under test.
//
// tsc is invoked through its JS entry with the current node binary, not via
// `node_modules/.bin/tsc`: on Windows that is a `.cmd` shim, and Node 22
// refuses to spawn those without a shell (EINVAL).
rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
    'apps/mobile/src/theme.ts',
    '--outDir',
    outDir,
    '--module',
    'esnext',
    '--target',
    'es2020',
    '--moduleResolution',
    'bundler',
  ],
  { cwd: repo, stdio: 'inherit' },
);

const {
  categoryHue,
  categoryColors,
  hslToHex,
  AVATAR_SATURATION,
  AVATAR_FILL_LIGHTNESS,
  AVATAR_INK_LIGHTNESS,
} = await import(`file://${join(outDir, 'theme.js')}`);

/** The desktop's formula, transcribed from its theme.ts, as the oracle. */
function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
const desktopHue = (name) => (hashString(name) * 137) % 360;

const channel = (v) => {
  const c = parseInt(v, 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex) => {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const NAMES = ['Daw Hla', 'KBZ Bank', 'Food', 'Transfer', 'a', 'U Kyaw', '', '🎉 emoji'];

// 1. Same hue as the desktop, for every name.
const hueMismatch = NAMES.filter((name) => categoryHue(name) !== desktopHue(name));
check('hue matches the desktop formula', hueMismatch.length === 0, hueMismatch.join(', '));

// 2. Always well-formed 6-digit hex.
const swatches = NAMES.map(categoryColors);
const malformed = swatches.filter(
  (s) => !/^#[0-9a-f]{6}$/.test(s.background) || !/^#[0-9a-f]{6}$/.test(s.text),
);
check('every colour is #rrggbb', malformed.length === 0, JSON.stringify(malformed));

// 3. Deterministic across calls — the whole point of hashing rather than a table.
check(
  'deterministic',
  NAMES.every((name) => {
    const a = categoryColors(name);
    const b = categoryColors(name);
    return a.background === b.background && a.text === b.text;
  }),
);

// 4. Hue is in range, and spread rather than clustered.
const hues = NAMES.map(categoryHue);
check('hue within [0, 360)', hues.every((h) => h >= 0 && h < 360), hues.join(', '));
check('hues are spread, not clustered', new Set(hues).size >= NAMES.length - 1);

// 5. Distinct names give distinct fills.
const realNames = NAMES.filter((n) => n.length > 0);
const fills = realNames.map((n) => categoryColors(n).background);
check('distinct names give distinct fills', new Set(fills).size === fills.length);

// 6. The avatar must clear WCAG AA for visible text — and because the hue is
//    hashed, that has to hold for all 360 of them, not just the sampled names.
//    Swept through `hslToHex` directly: hashing a probe name does NOT produce
//    every hue, so a name-driven loop would test nothing of the sort.
let worst = Infinity;
let worstHue = 0;
for (let hue = 0; hue < 360; hue += 1) {
  const ratio = contrast(
    hslToHex(hue, AVATAR_SATURATION, AVATAR_FILL_LIGHTNESS),
    hslToHex(hue, AVATAR_SATURATION, AVATAR_INK_LIGHTNESS),
  );
  if (ratio < worst) {
    worst = ratio;
    worstHue = hue;
  }
}
check(
  `avatar ink clears AA on all 360 hues (worst ${worst.toFixed(2)}:1 at hue ${worstHue})`,
  worst >= 4.5,
);

console.log(`\n${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`} — ${NAMES.length} names sampled, 360 hues swept`);
process.exit(failures === 0 ? 0 : 1);
