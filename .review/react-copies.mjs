/**
 * Counts the React copies that actually made it into the Android bundle.
 *
 * This is the check that was missing. A monorepo can build a perfectly valid
 * bundle containing **two** Reacts, and Metro reports nothing — the failure only
 * appears at runtime, as `Cannot read property 'useState' of null`, because the
 * hooks in one copy register a dispatcher the renderer in the other never set.
 *
 * React's development build carries `ReactVersion = '<x.y.z>'`, so the version
 * markers in the bundle are a direct read of how many copies were inlined.
 */

const BUNDLE =
  'http://127.0.0.1:8081/index.bundle?platform=android&dev=true&minify=false';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForMetro(attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const body = await (await fetch('http://127.0.0.1:8081/status')).text();
      if (body.includes('packager-status:running')) return true;
    } catch {
      // Not up yet.
    }
    await wait(2000);
  }
  return false;
}

if (!(await waitForMetro())) {
  console.error('FAIL  Metro never reported packager-status:running');
  process.exit(1);
}

const started = Date.now();
const response = await fetch(BUNDLE);
const text = await response.text();
console.log(`bundle: HTTP ${response.status} · ${text.length} bytes · ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (response.status !== 200) {
  console.error('FAIL  the bundle did not build');
  console.error(text.slice(0, 2000));
  process.exit(1);
}

// `ReactVersion` is assigned once per inlined copy of React.
const versionMatches = [...text.matchAll(/ReactVersion\s*=\s*["'](\d+\.\d+\.\d+)["']/g)].map(
  (m) => m[1],
);
const counts = new Map();
for (const version of versionMatches) counts.set(version, (counts.get(version) ?? 0) + 1);

console.log(`\nReact copies in the bundle (${versionMatches.length} version marker(s)):`);
for (const [version, count] of [...counts].sort()) {
  console.log(`  ${version}  ×${count}`);
}

// A React Native renderer is also detectable: it is what sets the dispatcher.
const hasRenderer = text.includes('react-native/Libraries/Renderer');
console.log(`renderer module present: ${hasRenderer}`);

console.log('');
if (versionMatches.length === 0) {
  console.error('FAIL  no React found in the bundle at all');
  process.exit(1);
}
if (counts.size > 1) {
  console.error(`FAIL  ${counts.size} different React versions inlined — hooks will throw`);
  process.exit(1);
}
console.log(`PASS  exactly one React in the bundle (${[...counts.keys()][0]})`);
