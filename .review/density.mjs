/**
 * Density probe.
 *
 * Reports the geometry the density layer actually produces, and captures a crop
 * of the app shell so a `--density` change can be judged rather than guessed.
 * Reads the built preview, so run `pnpm design:preview` first.
 *
 *   node .review/density.mjs [tag] [selector]   # writes density-<tag>.png
 *
 * The selector defaults to the app shell; pass one to crop a specific region
 * (e.g. `.table-wrap` for the ledger).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const PREVIEW = join(repoRoot, 'apps/desktop/design/preview.html');
const PORT = 9413;
const TAG = process.argv[2] ?? 'current';
const REGION = process.argv[3] ?? '.shell';
const CROP_HEIGHT = REGION === '.shell' ? 520 : 340;
const CROP_SCALE = REGION === '.shell' ? 1.6 : 1.8;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('No Chromium binary found. Set CHROME_PATH.');
  process.exit(2);
}
if (!existsSync(PREVIEW)) {
  console.error(`Preview not built: ${PREVIEW}\nRun: pnpm design:preview`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sara-density-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--hide-scrollbars',
    '--window-size=1280,900',
    pathToFileURL(PREVIEW).href,
  ],
  { stdio: 'ignore' },
);

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await response.json()).find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* browser is still booting */
    }
    await sleep(500);
  }
  throw new Error('Chromium never exposed a page target');
}

const client = connect((await findTarget()).webSocketDebuggerUrl);
await client.ready;
const { send } = client;
await send('Runtime.enable');
await send('Page.enable');

const ev = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then(
    (result) => {
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
  );

for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await ev("!!document.querySelector('.preview-frame .shell')").catch(() => false)) break;
  await sleep(300);
}
await ev("document.documentElement.dataset.theme = 'dark', 'ok'");
await sleep(300);

/* The declared knob, not the computed one — the computed value is what we are
   here to check. */
const density = await ev(
  "getComputedStyle(document.documentElement).getPropertyValue('--density').trim()",
);

const report = await ev(`(() => {
  const frame = document.querySelector('.preview-frame');
  const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) || 0 : 0);
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);

  const rows = [...frame.querySelectorAll('table.ledger tbody tr')];
  const input = frame.querySelector('.input');
  const btn = frame.querySelector('.btn');

  return JSON.stringify({
    bodyFont: px(document.body, 'fontSize'),
    bodyLineHeight: px(document.body, 'lineHeight'),
    ledgerRow: { height: h(rows[0]), font: px(rows[0], 'fontSize') },
    input: { height: h(input), font: px(input, 'fontSize') },
    button: { height: h(btn), font: px(btn, 'fontSize') },
    heroTile: { width: w(frame.querySelector('.summary-tile.is-hero')), height: h(frame.querySelector('.summary-tile.is-hero')) },
    sidebarWidth: w(frame.querySelector('.sidebar')),
    topbarHeight: h(frame.querySelector('.topbar')),
  });
})()`);

console.log(`--density: ${density}`);
console.log(JSON.stringify(JSON.parse(report), null, 2));

const rect = JSON.parse(
  await ev(`(() => {
    const r = document.querySelector('.preview-frame ${REGION}').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
  })()`),
);

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: Math.min(CROP_HEIGHT, rect.height),
    scale: CROP_SCALE,
  },
});
const out = join(here, `density-${TAG}.png`);
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`\n${out}`);

client.close();
chrome.kill();
