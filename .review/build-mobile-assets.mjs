/**
 * Generates the four assets `apps/mobile/app.json` references.
 *
 * They did not exist, so every `expo start` printed
 * `Unable to resolve asset "./assets/icon.png"`, and `expo prebuild` / an EAS
 * build would fail outright on the missing icon.
 *
 * These are **derived from the app's own brand mark**, not invented: `App.tsx`
 * already draws the splash logo as a `#2563EB` rounded square carrying a white
 * `₿`, and `app.json` already sets that blue as both the splash and the
 * adaptive-icon background. This script just renders the same thing at the
 * sizes the platform wants.
 *
 * Replace them with real artwork when there is some — nothing here is precious.
 *
 * Rendering goes through headless Chrome, which is already on this machine and
 * is what `.review/verify-preview.mjs` drives. No image library required.
 *
 * Run: `node .review/build-mobile-assets.mjs`
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const assetsDir = join(repo, 'apps', 'mobile', 'assets');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error('FAIL  no Chrome found at the usual paths');
  process.exit(1);
}

const BRAND = '#2563EB';

/**
 * `size` is the canvas; `mark` is the glyph size as a fraction of it.
 *
 * Android's adaptive icon crops to a circle and keeps only the middle ~66%, so
 * its foreground glyph has to be noticeably smaller than the iOS icon's.
 */
const ASSETS = [
  { file: 'icon.png', size: 1024, mark: 0.56, plate: 'rounded', radius: 0.22 },
  { file: 'adaptive-icon.png', size: 1024, mark: 0.40, plate: 'none' },
  { file: 'splash.png', size: 1024, mark: 0.30, plate: 'none' },
  { file: 'favicon.png', size: 196, mark: 0.56, plate: 'rounded', radius: 0.22 },
];

function html({ size, mark, plate, radius }) {
  const plateCss =
    plate === 'rounded'
      ? `background:${BRAND};border-radius:${(radius * size).toFixed(1)}px;`
      : 'background:transparent;';

  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .plate {
    width: ${size}px; height: ${size}px;
    ${plateCss}
    display: flex; align-items: center; justify-content: center;
  }
  .mark {
    /* Font-independent in practice: these stacks all carry U+20BF, and the
       script verifies the render rather than trusting that. */
    font-family: "Segoe UI Symbol", "Segoe UI", "DejaVu Sans", sans-serif;
    font-size: ${(size * mark).toFixed(1)}px;
    font-weight: 700;
    line-height: 1;
    color: #FFFFFF;
    ${plate === 'none' ? `text-shadow: 0 0 0 ${BRAND};` : ''}
  }
</style>
<div class="plate"><span class="mark">&#8383;</span></div>
`;
}

mkdirSync(assetsDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'wallet-assets-'));

let failures = 0;

for (const asset of ASSETS) {
  const page = join(scratch, `${asset.file}.html`);
  const out = join(assetsDir, asset.file);
  writeFileSync(page, html(asset), 'utf8');

  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${asset.size},${asset.size}`,
      `--screenshot=${out}`,
      '--default-background-color=00000000',
      `file:///${page.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore', timeout: 60_000 },
  );

  if (!existsSync(out) || statSync(out).size < 200) {
    console.error(`FAIL  ${asset.file} was not written`);
    failures += 1;
    continue;
  }

  console.log(`ok    ${asset.file.padEnd(20)} ${asset.size}×${asset.size}  ${statSync(out).size} bytes`);
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`} — wrote to apps/mobile/assets/`);
console.log('Now verify the pixels: `node .review/asset-audit.mjs` (catches a tofu box,');
console.log('an opaque foreground layer, or the wrong blue — none of which fail a build).');
process.exit(failures === 0 ? 0 : 1);
