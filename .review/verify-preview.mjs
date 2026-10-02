/**
 * Headless verification of the desktop design preview.
 *
 * Drives a local Chromium over CDP (no agent-browser on Windows), asserts on
 * the rendered DOM and computed styles, and captures light + dark screenshots.
 *
 *   node .review/verify-preview.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const PREVIEW = join(repoRoot, 'apps/desktop/design/preview.html');
const OUT_DIR = here;
const PORT = 9411;

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

/* ── CDP plumbing ───────────────────────────────────────────────────────── */

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { ready, send, events, close: () => ws.close() };
}

/* ── Main ───────────────────────────────────────────────────────────────── */

const userDataDir = mkdtempSync(join(tmpdir(), 'sara-verify-'));
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

let client;
const failures = [];
const check = (area, ok, detail) => {
  if (!ok) failures.push(`${area}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${area}  (${detail})`);
};

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Browser is still booting.
    }
    await sleep(500);
  }
  throw new Error('Chromium never exposed a page target');
}

async function main() {
  const target = await findTarget();
  client = connect(target.webSocketDebuggerUrl);
  await client.ready;

  const { send } = client;

  await send('Runtime.enable');
  await send('Page.enable');

  const ev = (expression) =>
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then(
      (result) => {
        if (result.exceptionDetails) {
          const details = result.exceptionDetails;
          throw new Error(
            `${details.text}: ${details.exception?.description ?? '(no description)'}`,
          );
        }
        return result.result.value;
      },
    );

  const waitFor = async (expression, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await ev(expression).catch(() => null);
      if (Array.isArray(value) ? value.length > 0 : Boolean(value)) return value;
      await sleep(300);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  await waitFor("!!document.querySelector('.preview-frame .shell')", 'app shell');

  const setTheme = async (mode) => {
    await ev(`document.documentElement.dataset.theme = ${JSON.stringify(mode)}, 'ok'`);
    await sleep(250);
  };

  const screenshot = async (name) => {
    const metrics = await send('Page.getLayoutMetrics');
    const { width, height } = metrics.cssContentSize;
    const result = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    writeFileSync(join(OUT_DIR, name), Buffer.from(result.data, 'base64'));
    return `${width}x${height}`;
  };

  /* ── Light theme ──────────────────────────────────────────────────────── */

  await setTheme('light');

  const structure = await ev(`(() => {
    // Scoped to the first frame on purpose: the preview now renders the debts
    // view in a second shell, so an unscoped query would double every count.
    const frame = document.querySelector('.preview-frame');
    return JSON.stringify({
      topbar: !!frame.querySelector('.topbar-mark'),
      userChip: !!frame.querySelector('.user-chip'),
      wallets: frame.querySelectorAll('.wallet-item').length,
      heroTiles: frame.querySelectorAll('.summary-tile.is-hero').length,
      segments: frame.querySelectorAll('.breakdown-segment').length,
      legend: frame.querySelectorAll('.legend-item').length,
      chipDots: frame.querySelectorAll('.chip-dot').length,
      rows: frame.querySelectorAll('table.ledger tbody tr').length,
      skeleton: document.querySelectorAll('.skeleton-row').length,
      tabs: frame.querySelectorAll('.tabs .tab').length,
      tabSelected: frame.querySelector('.tab[aria-selected="true"]')?.textContent.trim(),
    });
  })()`);
  const shape = JSON.parse(structure);
  check('structure', shape.topbar && shape.userChip, `topbar ${shape.topbar}, userChip ${shape.userChip}`);
  check('structure', shape.wallets === 3, `wallet rows ${shape.wallets}`);
  check('structure', shape.heroTiles === 1, `hero tiles ${shape.heroTiles}`);
  check('structure', shape.segments === 4, `breakdown segments ${shape.segments}`);
  check('structure', shape.legend === 4, `legend items ${shape.legend}`);
  check('structure', shape.rows === 7, `ledger rows ${shape.rows}`);
  check('structure', shape.skeleton === 0, `leftover skeletons ${shape.skeleton}`);
  check('structure', shape.tabs === 2, `tabs ${shape.tabs}`);
  check(
    'structure',
    (shape.tabSelected ?? '').startsWith('Ledger'),
    `ledger tab selected (${shape.tabSelected})`,
  );

  /* ── Transfer legs name both wallets ──────────────────────────────────── */

  // A leg on its own can only say which wallet it touched, so the pair has to
  // be read off `transfer_group_id`. The rendering rule is `from → to` on both
  // legs, with whichever end that row actually moves kept as the pill — get the
  // order wrong and every transfer in the ledger points backwards.
  const transferInfo = await ev(`(() => {
    const frame = document.querySelector('.preview-frame');
    const pairs = [...frame.querySelectorAll('table.ledger tbody .wallet-pair')];
    return JSON.stringify({
      pairs: pairs.length,
      arrows: pairs.filter((pair) => pair.querySelector('.wallet-pair-arrow')?.textContent.trim() === '\\u2192').length,
      // Each pair reads: pill? name? arrow name? pill?
      readings: pairs.map((pair) =>
        [...pair.children].map((child) =>
          child.classList.contains('wallet-pair-arrow') ? '→' : child.textContent.trim(),
        ).join(' '),
      ),
      // The emphasised end is the row's own wallet — the one the amount moves.
      emphasised: pairs.map((pair) =>
        [...pair.children].map((child) =>
          child.classList.contains('pill') ? 'own' : 'other',
        ).filter((side) => side === 'own').length,
      ),
      // Ordinary rows keep the single-wallet cell.
      singleWalletRows: [...frame.querySelectorAll('table.ledger tbody tr')]
        .filter((row) => row.querySelector('.wallet-pair') === null).length,
      overflow: pairs.some((pair) => pair.scrollWidth > pair.clientWidth + 1),
    });
  })()`);
  const transfer = JSON.parse(transferInfo);
  check('transfer', transfer.pairs === 2, `transfer legs showing both wallets ${transfer.pairs}`);
  check('transfer', transfer.arrows === 2, `arrows rendered ${transfer.arrows}`);
  check(
    'transfer',
    transfer.readings.every((reading) => reading === 'iWallet → Cash'),
    `both legs read from→to (${transfer.readings.join(' | ')})`,
  );
  check(
    'transfer',
    transfer.emphasised.every((count) => count === 1),
    `exactly one end emphasised per leg (${transfer.emphasised.join(', ')})`,
  );
  check(
    'transfer',
    transfer.singleWalletRows === 5,
    `ordinary rows keep one wallet (${transfer.singleWalletRows})`,
  );
  check('transfer', transfer.overflow === false, 'wallet pair fits its column');

  /* ── Frameless window chrome ─────────────────────────────────────────── */

  // `frame: false` means these three buttons are the only way to minimise,
  // maximise and close the window, and they are drawn in HTML — so nothing but
  // this check stops them from silently disappearing. The app-region values
  // matter just as much: a control left inside the drag region renders
  // perfectly and then never receives a click.
  const chrome = await ev(`(() => {
    const bar = document.querySelector('.preview-frame .topbar');
    const cluster = bar.querySelector('.window-controls');
    const buttons = [...cluster.querySelectorAll('.window-btn')];
    const region = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
    const barRect = bar.getBoundingClientRect();
    const clusterRect = cluster.getBoundingClientRect();
    return JSON.stringify({
      count: buttons.length,
      labels: buttons.map((button) => button.getAttribute('aria-label')),
      barDrag: region(bar),
      clusterRegion: region(cluster),
      signOutRegion: region(bar.querySelector('.btn-ghost, .icon-only')),
      inset: Math.round(barRect.right - clusterRect.right),
      clusterWidth: Math.round(clusterRect.width),
      barHeight: Math.round(barRect.height),
      // The bar is a 44px icon row — a button that has grown a text label
      // back is the regression this guards.
      textButtons: [...bar.querySelectorAll('button')].filter(
        (button) => button.textContent.trim().length > 0,
      ).length,
      strip: !!document.querySelector('.preview-panel .titlebar-strip .window-controls'),
    });
  })()`);
  const chromeInfo = JSON.parse(chrome);
  check('window chrome', chromeInfo.count === 3, `caption buttons ${chromeInfo.count}`);
  check(
    'window chrome',
    chromeInfo.labels.join('/') === 'Minimize/Maximize/Close',
    `caption order ${chromeInfo.labels.join('/')}`,
  );
  check('window chrome', chromeInfo.barDrag === 'drag', `topbar region ${chromeInfo.barDrag}`);
  check(
    'window chrome',
    chromeInfo.clusterRegion === 'no-drag' && chromeInfo.signOutRegion === 'no-drag',
    `cluster ${chromeInfo.clusterRegion}, sign out ${chromeInfo.signOutRegion}`,
  );
  check(
    'window chrome',
    chromeInfo.inset === 10,
    `caption sits ${chromeInfo.inset}px from the window edge`,
  );
  check('window chrome', chromeInfo.barHeight === 44, `topbar ${chromeInfo.barHeight}px tall`);
  check(
    'window chrome',
    chromeInfo.textButtons === 0,
    `text labels in the bar: ${chromeInfo.textButtons}`,
  );
  check('window chrome', chromeInfo.strip, 'pre-auth drag handle present');

  // Hover the close button for real and confirm it takes the danger fill — a
  // token wired to the wrong variable would still look plausible in a
  // screenshot, but it would not match `--danger-solid`.
  const closeBox = JSON.parse(
    await ev(`(() => {
      const button = document.querySelector('.preview-frame .window-btn.is-close');
      const r = button.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`),
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...closeBox });
  // `.window-btn` transitions its background over 140ms, and a computed style
  // read is not transition-aware — without this wait the hover fill still
  // reports the pre-transition `transparent`.
  await sleep(300);
  const hover = JSON.parse(
    await ev(`(() => {
      const button = document.querySelector('.preview-frame .window-btn.is-close');
      const expected = getComputedStyle(document.documentElement)
        .getPropertyValue('--danger-solid')
        .trim();
      const probe = document.createElement('span');
      probe.style.color = expected;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return JSON.stringify({
        fill: getComputedStyle(button).backgroundColor,
        expected: resolved,
        hovered: button.matches(':hover'),
      });
    })()`),
  );
  check(
    'window chrome',
    hover.hovered && hover.fill === hover.expected,
    `close hover ${hover.fill} vs --danger-solid ${hover.expected}`,
  );

  // A focused crop of the bar — the full-page shot is 5200px tall, so a 60px
  // strip is a couple of pixels in it.
  const barRect = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector('.preview-frame .topbar').getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(r.left + scrollX),
        y: Math.round(r.top + scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    })()`),
  );
  const barShot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...barRect, scale: 2 },
  });
  writeFileSync(join(OUT_DIR, 'preview-chrome.png'), Buffer.from(barShot.data, 'base64'));
  check('screenshot', true, `preview-chrome.png ${barRect.width}x${barRect.height}`);

  // Category colours must actually differ — this is the whole point of the
  // hash, and a broken custom property would silently fall back to one hue.
  const hues = await ev(`JSON.stringify(
    [...document.querySelectorAll('.preview-frame .breakdown-segment')]
      .map((el) => getComputedStyle(el).backgroundColor)
  )`);
  const palette = JSON.parse(hues);
  check(
    'category colours',
    new Set(palette).size === palette.length,
    `${new Set(palette).size} distinct of ${palette.length} — ${palette[0]}`,
  );
  check(
    'category colours',
    !palette.some((colour) => colour === 'rgba(0, 0, 0, 0)'),
    'no transparent segments',
  );

  // The hero tile must actually paint a gradient, not a flat fallback.
  const hero = await ev(`(() => {
    const el = document.querySelector('.summary-tile.is-hero');
    const style = getComputedStyle(el);
    return JSON.stringify({
      image: style.backgroundImage.slice(0, 24),
      valueColour: getComputedStyle(el.querySelector('.summary-value')).color,
      valueSize: getComputedStyle(el.querySelector('.summary-value')).fontSize,
    });
  })()`);
  const heroInfo = JSON.parse(hero);
  check('hero tile', heroInfo.image.startsWith('linear-gradient'), heroInfo.image);
  check('hero tile', heroInfo.valueColour === 'rgb(255, 255, 255)', heroInfo.valueColour);

  // Contrast: body text on the card surface.
  //
  // The label probe deliberately reads the *income* tile's label: the first
  // `.summary-label` in the DOM sits on the hero gradient, which this
  // flat-surface model cannot measure — it would report a meaningless 1:1.
  const contrast = await ev(`(() => {
    const flatten = (fg, bg) => {
      const parse = (value) => value.match(/[\\d.]+/g).map(Number);
      const [r, g, b, a = 1] = parse(fg);
      const [br, bg2, bb] = parse(bg);
      return [r * a + br * (1 - a), g * a + bg2 * (1 - a), b * a + bb * (1 - a)];
    };
    const lum = ([r, g, b]) => {
      const channel = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const card = document.querySelector('.preview-frame .main-panel');
    const surface = getComputedStyle(card).backgroundColor;
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const fg = flatten(getComputedStyle(el).color, surface);
      const bg = flatten(surface, surface);
      const a = lum(fg) + 0.05;
      const b = lum(bg) + 0.05;
      return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
    };
    return JSON.stringify({
      surface,
      label: read('.preview-frame .summary-tile.is-income .summary-label'),
      legend: read('.preview-frame .legend-value'),
      note: read('.preview-frame td.col-note'),
      date: read('.preview-frame td.col-date'),
      expense: read('.preview-frame .amount-expense'),
      income: read('.preview-frame .amount-income'),
      transfer: read('.preview-frame .amount-transfer'),
    });
  })()`);
  const ratios = JSON.parse(contrast);
  for (const [name, ratio] of Object.entries(ratios)) {
    if (name === 'surface') continue;
    check('contrast (light)', ratio !== null && ratio >= 4.5, `${name} ${ratio}:1`);
  }

  // Layout: the page must not scroll sideways, and the ledger must scroll
  // inside its wrapper rather than pushing the frame wider.
  const layout = await ev(`JSON.stringify({
    innerWidth,
    docWidth: document.documentElement.scrollWidth,
    frameOverflow: (() => {
      const frame = document.querySelector('.preview-frame');
      return frame.scrollWidth > frame.clientWidth + 1;
    })(),
    tableScrolls: (() => {
      const wrap = document.querySelector('.preview-frame .table-wrap');
      return wrap.scrollWidth > wrap.clientWidth + 1;
    })(),
  })`);
  const box = JSON.parse(layout);
  check('layout', box.docWidth <= box.innerWidth, `doc ${box.docWidth} vs viewport ${box.innerWidth}`);
  check('layout', box.frameOverflow === false, 'frame does not overflow horizontally');

  const lightSize = await screenshot('preview-light.png');
  check('screenshot', true, `preview-light.png ${lightSize}`);

  /* ── Debts: the AP/AR view ───────────────────────────────────────────── */

  const debts = await ev(`(() => {
    const list = document.querySelector('.debt-list');
    if (!list) return JSON.stringify({ missing: true });
    const frame = list.closest('.preview-frame');
    const rows = [...frame.querySelectorAll('.debt-row')];

    const borderSide = (el) => getComputedStyle(el).borderLeftWidth;
    const fillWidths = rows.map(
      (row) => row.querySelector('.debt-fill')?.style.width ?? null,
    );

    return JSON.stringify({
      rows: rows.length,
      overdue: rows.filter((row) => row.classList.contains('is-overdue')).length,
      settled: rows.filter((row) => row.classList.contains('is-settled')).length,
      closed: rows.filter((row) => row.classList.contains('is-closed')).length,
      tiles: frame.querySelectorAll('.debt-summary .summary-tile').length,
      tabs: frame.querySelectorAll('.tabs .tab').length,
      tabSelected: frame.querySelector('.tab[aria-selected="true"]')?.textContent.trim(),
      alertCount: frame.querySelectorAll('.tab-count.is-alert').length,
      overdueAccent: rows
        .filter((row) => row.classList.contains('is-overdue'))
        .map((row) => borderSide(row))[0],
      plainAccent: rows
        .filter((row) => !row.classList.contains('is-overdue'))
        .map((row) => borderSide(row))[0],
      fills: fillWidths,
      avatars: rows.map(
        (row) => getComputedStyle(row.querySelector('.debt-avatar')).backgroundColor,
      ),
      outstandingColours: rows.map(
        (row) => getComputedStyle(row.querySelector('.debt-outstanding')).color,
      ),
      // The design rule this whole section exists to hold: a debt is never
      // painted in the money-in / money-out colours, because nothing has moved.
      tokens: (() => {
        const style = getComputedStyle(document.documentElement);
        return {
          income: style.getPropertyValue('--income').trim(),
          expense: style.getPropertyValue('--expense').trim(),
          danger: style.getPropertyValue('--danger').trim(),
          text: style.getPropertyValue('--text').trim(),
        };
      })(),
    });
  })()`);
  const debtInfo = JSON.parse(debts);

  check('debts', debtInfo.rows === 5, `debt rows ${debtInfo.rows}`);
  check('debts', debtInfo.tiles === 2, `summary tiles ${debtInfo.tiles}`);
  check('debts', debtInfo.tabs === 2, `tabs ${debtInfo.tabs}`);
  check(
    'debts',
    (debtInfo.tabSelected ?? '').startsWith('Debts'),
    `debts tab selected (${debtInfo.tabSelected})`,
  );
  check('debts', debtInfo.alertCount === 1, `overdue tab badges ${debtInfo.alertCount}`);

  check('debts', debtInfo.overdue === 1, `rows marked overdue ${debtInfo.overdue}`);
  check('debts', debtInfo.settled === 1, `rows marked settled ${debtInfo.settled}`);
  check('debts', debtInfo.closed === 1, `rows marked closed ${debtInfo.closed}`);

  // An overdue row is marked on its edge; a normal one must not be, or the
  // accent stops meaning "late".
  check(
    'debts',
    debtInfo.overdueAccent === '3px' && debtInfo.plainAccent === '1px',
    `overdue border ${debtInfo.overdueAccent}, plain ${debtInfo.plainAccent}`,
  );

  // Progress bars must carry the data, not a shared default.
  const fills = debtInfo.fills.filter((width) => width !== null);
  check(
    'debts',
    new Set(fills).size === fills.length && fills.includes('40%'),
    `progress fills ${debtInfo.fills.join(', ')}`,
  );

  // Avatars are hashed from the counterparty, so they must differ.
  check(
    'debts',
    new Set(debtInfo.avatars).size === debtInfo.avatars.length,
    `${new Set(debtInfo.avatars).size} distinct avatar colours of ${debtInfo.avatars.length}`,
  );

  // The rule: no debt figure may use the income or expense colour.
  const toHex = (value) => value.trim().toLowerCase();
  check(
    'debts',
    !debtInfo.outstandingColours.some((colour) =>
      [
        toHex(debtInfo.tokens.income),
        toHex(debtInfo.tokens.expense),
        'rgb(220, 38, 38)',
        'rgb(4, 120, 87)',
      ].includes(toHex(colour)),
    ),
    `outstanding colours avoid income/expense — ${[...new Set(debtInfo.outstandingColours)].join(', ')}`,
  );

  // Contrast of the debt row's own text, measured against the row surface.
  const debtContrast = await ev(`(() => {
    const flatten = (fg, bg) => {
      const parse = (value) => value.match(/[\\d.]+/g).map(Number);
      const [r, g, b, a = 1] = parse(fg);
      const [br, bg2, bb] = parse(bg);
      return [r * a + br * (1 - a), g * a + bg2 * (1 - a), b * a + bb * (1 - a)];
    };
    const lum = ([r, g, b]) => {
      const channel = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const row = document.querySelector('.debt-row');
    const surface = getComputedStyle(row).backgroundColor;
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const a = lum(flatten(getComputedStyle(el).color, surface)) + 0.05;
      const b = lum(flatten(surface, surface)) + 0.05;
      return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
    };
    return JSON.stringify({
      surface,
      name: read('.debt-row .debt-name'),
      meta: read('.debt-row .debt-meta'),
      progress: read('.debt-row .debt-progress-label'),
      outstanding: read('.debt-row .debt-outstanding'),
      badge: read('.debt-row .badge-direction'),
      tabCount: read('.tab-count'),
      // A settled row is dimmed to 62% opacity; its text must still be legible
      // against the card behind it, which is what the eye actually resolves.
      settledMeta: (() => {
        const el = document.querySelector('.debt-row.is-settled .debt-meta');
        if (!el) return null;
        const card = getComputedStyle(document.querySelector('.debt-row').closest('.main-panel'))
          .backgroundColor;
        const blended = flatten(getComputedStyle(el).color, card);
        const a = lum(blended) + 0.05;
        const b = lum(flatten(card, card)) + 0.05;
        return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
      })(),
      // The avatar is the one category-coloured element carrying text, and its
      // fill is a hue, not the row surface — so it is measured against itself
      // rather than against the card. The worst avatar is reported, because the
      // hue is hashed from the counterparty's name: checking only the first row
      // would pass on a lucky hue and say nothing about the rest.
      avatarWorst: (() => {
        const avatars = [...document.querySelectorAll('.debt-row .debt-avatar')];
        if (avatars.length === 0) return null;
        const ratios = avatars.map((el) => {
          const style = getComputedStyle(el);
          const a = lum(flatten(style.color, style.backgroundColor)) + 0.05;
          const b = lum(flatten(style.backgroundColor, style.backgroundColor)) + 0.05;
          return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
        });
        return Math.min(...ratios);
      })(),
      avatarCount: document.querySelectorAll('.debt-row .debt-avatar').length,
    });
  })()`);
  const debtRatios = JSON.parse(debtContrast);
  for (const [name, ratio] of Object.entries(debtRatios)) {
    if (name === 'surface' || name === 'avatarCount') continue;
    const label = name === 'avatarWorst' ? 'avatar worst' : name;
    check('contrast (debts)', ratio !== null && ratio >= 4.5, `${label} ${ratio}:1`);
  }
  check(
    'contrast (debts)',
    debtRatios.avatarCount >= 5,
    `all ${debtRatios.avatarCount} debt avatars measured`,
  );

  const debtLayout = await ev(`(() => {
    const frame = document.querySelector('.debt-list').closest('.preview-frame');
    return JSON.stringify({
      overflow: frame.scrollWidth > frame.clientWidth + 1,
      docWidth: document.documentElement.scrollWidth,
      innerWidth,
    });
  })()`);
  const debtBox = JSON.parse(debtLayout);
  check('debts', debtBox.overflow === false, 'debts frame does not overflow horizontally');
  check('debts', debtBox.docWidth <= debtBox.innerWidth, `doc ${debtBox.docWidth} vs viewport ${debtBox.innerWidth}`);

  // A static snapshot has no scroll, so the frame's fixed height must fit its
  // own content. Without this check a too-short frame silently clips the last
  // row, and a screenshot cannot tell you that it is doing so.
  //
  // The height is measured from the last row's own box, not from
  // `scrollHeight` — the shell is `height: 100%`, so it is clamped by the frame
  // and would report the frame's height back at us however tall the content is.
  const debtFit = JSON.parse(
    await ev(`(() => {
      const frame = document.querySelector('.debt-list').closest('.preview-frame');
      const rows = [...frame.querySelectorAll('.debt-row')];
      const top = frame.getBoundingClientRect().top;
      const last = rows.at(-1).getBoundingClientRect();
      return JSON.stringify({
        frame: Math.round(frame.clientHeight),
        needed: Math.round(last.bottom - top + 24),
        rows: rows.length,
        visible: rows.filter((row) => row.getBoundingClientRect().bottom <= frame.getBoundingClientRect().bottom + 1).length,
      });
    })()`),
  );
  check(
    'debts',
    debtFit.needed <= debtFit.frame,
    `frame ${debtFit.frame}px fits content ${debtFit.needed}px`,
  );
  check(
    'debts',
    debtFit.visible === debtFit.rows,
    `all ${debtFit.rows} rows inside the frame (${debtFit.visible} visible)`,
  );

  // A focused shot of just this section. The full-page capture is 4900px tall
  // and the debt rows are illegible when it is scaled to fit.
  const debtRect = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector('.debt-list').closest('.preview-frame').getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(r.left + scrollX),
        y: Math.round(r.top + scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    })()`),
  );
  const debtShot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...debtRect, scale: 1 },
  });
  writeFileSync(join(OUT_DIR, 'preview-debts.png'), Buffer.from(debtShot.data, 'base64'));
  check('screenshot', true, `preview-debts.png ${debtRect.width}x${debtRect.height}`);

  /* ── Composition: legend must not collide, dialogs must not clip ─────── */

  const legend = await ev(`(() => {
    const boxes = [...document.querySelectorAll('.preview-frame .legend-item')]
      .map((el) => el.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (Math.abs(a.top - b.top) < 4 && a.right > b.left + 0.5) overlaps += 1;
      }
    }
    const rows = new Set(boxes.map((box) => Math.round(box.top)));
    return JSON.stringify({ count: boxes.length, overlaps, rows: rows.size });
  })()`);
  const legendInfo = JSON.parse(legend);
  check('legend', legendInfo.overlaps === 0, `${legendInfo.count} items, ${legendInfo.rows} row(s), ${legendInfo.overlaps} overlap(s)`);

  const clipping = await ev(`JSON.stringify(
    [...document.querySelectorAll('.preview-panel')]
      .map((panel) => {
        const dialog = panel.querySelector('.dialog');
        if (!dialog) return null;
        const p = panel.getBoundingClientRect();
        const d = dialog.getBoundingClientRect();
        return {
          fits: d.top >= p.top - 1 && d.bottom <= p.bottom + 1,
          headroom: Math.round(p.bottom - d.bottom),
        };
      })
      .filter(Boolean)
  )`);
  for (const [index, panel] of JSON.parse(clipping).entries()) {
    check('dialog clipping', panel.fits, `panel ${index + 1} headroom ${panel.headroom}px`);
  }

  /* ── Dark theme ───────────────────────────────────────────────────────── */

  await setTheme('dark');

  const dark = await ev(`(() => {
    const flatten = (fg, bg) => {
      const parse = (value) => value.match(/[\\d.]+/g).map(Number);
      const [r, g, b, a = 1] = parse(fg);
      const [br, bg2, bb] = parse(bg);
      return [r * a + br * (1 - a), g * a + bg2 * (1 - a), b * a + bb * (1 - a)];
    };
    const lum = ([r, g, b]) => {
      const channel = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const card = document.querySelector('.preview-frame .main-panel');
    const surface = getComputedStyle(card).backgroundColor;
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const fg = flatten(getComputedStyle(el).color, surface);
      const bg = flatten(surface, surface);
      const a = lum(fg) + 0.05;
      const b = lum(bg) + 0.05;
      return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
    };
    // The caption glyphs sit on the bar, not on a card, so they need their own
    // reading — and they are the only way to close the window, so "nearly
    // invisible in dark mode" is a real failure, not a nitpick.
    const barSurface = getComputedStyle(
      document.querySelector('.preview-frame .topbar'),
    ).backgroundColor;
    const readOnBar = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const fg = flatten(getComputedStyle(el).color, barSurface);
      const bg = flatten(barSurface, barSurface);
      const a = lum(fg) + 0.05;
      const b = lum(bg) + 0.05;
      return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
    };
    return JSON.stringify({
      surface,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      label: read('.preview-frame .summary-tile.is-income .summary-label'),
      legend: read('.preview-frame .legend-value'),
      note: read('.preview-frame td.col-note'),
      date: read('.preview-frame td.col-date'),
      expense: read('.preview-frame .amount-expense'),
      income: read('.preview-frame .amount-income'),
      transfer: read('.preview-frame .amount-transfer'),
      caption: readOnBar('.preview-frame .window-btn'),
      chipActive: (() => {
        const chip = document.querySelector('.preview-frame .chip[aria-pressed="true"]');
        return chip ? getComputedStyle(chip).backgroundColor : null;
      })(),
      chipActiveText: (() => {
        const chip = document.querySelector('.preview-frame .chip[aria-pressed="true"]');
        return chip ? getComputedStyle(chip).color : null;
      })(),
      // Dark mode uses its own avatar pair (--cat-avatar-fill / --cat-avatar-ink),
      // so the guarantee has to be re-measured here, not inferred from light.
      // No backticks in this comment: it lives inside a template literal.
      avatarWorst: (() => {
        const avatars = [...document.querySelectorAll('.debt-row .debt-avatar')];
        if (avatars.length === 0) return null;
        return Math.min(
          ...avatars.map((el) => {
            const style = getComputedStyle(el);
            const a = lum(flatten(style.color, style.backgroundColor)) + 0.05;
            const b = lum(flatten(style.backgroundColor, style.backgroundColor)) + 0.05;
            return Number((Math.max(a, b) / Math.min(a, b)).toFixed(2));
          }),
        );
      })(),
    });
  })()`);
  const darkInfo = JSON.parse(dark);
  check('dark theme', darkInfo.bodyBg === 'rgb(7, 10, 18)', `body ${darkInfo.bodyBg}`);
  for (const [name, ratio] of Object.entries(darkInfo)) {
    if (typeof ratio !== 'number' || name === 'surface') continue;
    check('contrast (dark)', ratio >= 4.5, `${name} ${ratio}:1`);
  }
  check(
    'dark theme',
    darkInfo.chipActive === 'rgb(99, 102, 241)',
    `active chip fill ${darkInfo.chipActive}`,
  );

  const darkSize = await screenshot('preview-dark.png');
  check('screenshot', true, `preview-dark.png ${darkSize}`);

  // The bar again, in the theme it is actually looked at in. Same crop box as
  // the light one, so the two can be compared side by side.
  const darkBarShot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...barRect, scale: 2 },
  });
  writeFileSync(join(OUT_DIR, 'preview-chrome-dark.png'), Buffer.from(darkBarShot.data, 'base64'));
  check('screenshot', true, `preview-chrome-dark.png ${barRect.width}x${barRect.height}`);

  /* ── Console + exceptions ─────────────────────────────────────────────── */

  const problems = client.events
    .filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' &&
          ['error', 'warning'].includes(event.params?.type)),
    )
    .map((event) =>
      event.method === 'Runtime.exceptionThrown'
        ? event.params.exceptionDetails.text
        : `${event.params.type}: ${event.params.args.map((a) => a.value ?? a.description).join(' ')}`,
    );
  check('console', problems.length === 0, problems.join(' | ') || 'no errors or warnings');
}

main()
  .catch((error) => {
    failures.push(`fatal: ${error.message}`);
    console.error(`FAIL  fatal  (${error.message})`);
  })
  .finally(() => {
    client?.close();
    chrome.kill();
    console.log('');
    console.log(
      failures.length === 0
        ? 'All checks passed.'
        : `${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`,
    );
    process.exit(failures.length ? 1 : 0);
  });
