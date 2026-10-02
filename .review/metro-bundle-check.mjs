/**
 * Waits for Metro, then asks it for the real Android bundle.
 *
 * Bundling is the only honest "can it run" test for the Expo app: it proves
 * every import resolves, including `@wallet/shared` straight from TypeScript
 * source through the Metro watchFolders / extraNodeModules setup. A monorepo
 * resolution failure shows up here and nowhere else — `tsc` cannot see it.
 *
 * Written as a script rather than a shell loop because the sandbox blocks the
 * `sleep` binary, and because `curl` needs `--noproxy '*'` on this machine.
 */

const STATUS = 'http://127.0.0.1:8081/status';
const BUNDLE =
  'http://127.0.0.1:8081/index.bundle?platform=android&dev=true&minify=false';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForMetro(attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(STATUS);
      const body = await response.text();
      if (body.includes('packager-status:running')) {
        return true;
      }
    } catch {
      // Not up yet.
    }
    await wait(2000);
  }
  return false;
}

const started = Date.now();
if (!(await waitForMetro())) {
  console.error('FAIL  Metro never reported packager-status:running');
  process.exit(1);
}
console.log(`ok    Metro is running (after ${((Date.now() - started) / 1000).toFixed(0)}s)`);

const bundleStart = Date.now();
const response = await fetch(BUNDLE);
const text = await response.text();
const seconds = ((Date.now() - bundleStart) / 1000).toFixed(1);

console.log(`      HTTP ${response.status} · ${text.length} bytes · ${seconds}s`);

if (response.status !== 200) {
  console.error('FAIL  the bundle did not build');
  console.error(text.slice(0, 2000));
  process.exit(1);
}

// A Metro error response is still HTTP 200 in some modes; a real bundle always
// carries these.
if (!text.includes('__d(function') && !text.includes('__BUNDLE_START_TIME__')) {
  console.error('FAIL  response is not a Metro bundle — probably an error payload');
  console.error(text.slice(0, 2000));
  process.exit(1);
}

// Prove the new screen actually made it in, rather than trusting the size.
const markers = ['DebtsScreen', 'SettleDebtSheet', 'No debts recorded', 'categoryColor'];
for (const marker of markers) {
  if (!text.includes(marker)) {
    console.error(`FAIL  "${marker}" is missing from the bundle`);
    process.exit(1);
  }
  console.log(`ok    bundle contains "${marker}"`);
}

console.log('PASS  the Android bundle builds and carries the debts screens');
