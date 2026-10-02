#!/usr/bin/env node
/**
 * Builds the standalone desktop design preview.
 *
 *   apps/desktop/design/preview.template.html  →  apps/desktop/design/preview.html
 *
 * The template is a hand-written snapshot of the real markup. This script
 * makes it self-contained and keeps it honest in two ways:
 *
 *   1. It inlines `global.css` verbatim, so the preview cannot drift from the
 *      stylesheet the Electron renderer actually loads.
 *   2. It resolves every `{{hue:Name}}` placeholder with the *same* hash the
 *      renderer uses (`apps/desktop/src/renderer/src/theme.ts`), so category
 *      and wallet colours match the running app instead of being eyeballed.
 *
 * Run with `pnpm design:preview`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEMPLATE = join(repoRoot, 'apps/desktop/design/preview.template.html');
const STYLESHEET = join(repoRoot, 'apps/desktop/src/renderer/src/styles/global.css');
const OUTPUT = join(repoRoot, 'apps/desktop/design/preview.html');

/* -- Mirrors theme.ts ------------------------------------------------------ */

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function categoryHue(name) {
  return (hashString(name) * 137) % 360;
}

/* -- Build ----------------------------------------------------------------- */

const template = readFileSync(TEMPLATE, 'utf8');
const stylesheet = readFileSync(STYLESHEET, 'utf8');

const seen = new Set();
const html = template
  .replace('/* INLINE:STYLES */', () => stylesheet.trimEnd())
  .replace(/\{\{hue:([^}]+)\}\}/g, (_match, name) => {
    seen.add(name);
    return String(categoryHue(name));
  });

const unresolved = html.match(/\{\{[^}]+\}\}/g);
if (unresolved) {
  console.error(`Unresolved placeholders: ${unresolved.join(', ')}`);
  process.exit(1);
}

writeFileSync(OUTPUT, html, 'utf8');

console.log(`Wrote ${OUTPUT}`);
console.log(`  stylesheet  ${(stylesheet.length / 1024).toFixed(1)} kB inlined`);
console.log(`  hues        ${seen.size} names resolved`);
