#!/usr/bin/env node
/**
 * Verifies the Supabase project the app is actually pointed at.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 * Every offline check in this repo runs against PGlite or a fake client. None
 * of them can tell you that the *real* project has never been migrated, that an
 * env var still holds the placeholder from `.env.example`, or that `anon` can
 * read the ledger. All three produce the same symptom from the app's side: a
 * failure that looks like a code bug.
 *
 * The specific failure this was written for:
 *
 *     {"code":"PGRST205",
 *      "message":"Could not find the table 'public.transactions' in the schema cache"}
 *
 * That is PostgREST saying it has never seen the table — the migrations have not
 * been applied. Nothing in the client can fix it, and no amount of retrying will.
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 *   1. Config      — is every variable set, and is it still a placeholder?
 *   2. Keys        — does each key authenticate against the REST API?
 *   3. Schema      — does PostgREST's cache know about the tables the code uses?
 *   4. RLS         — is `anon` actually locked out of the ledger?
 *
 * ── Two keys, two jobs ─────────────────────────────────────────────────────
 * The schema listing uses the **service-role** key, because PostgREST filters
 * the OpenAPI document by the requesting role's privileges — and `anon` has no
 * table grants at all by design, so it would report an empty schema even on a
 * perfectly migrated database. The RLS check uses the **anon** key, which is the
 * role the shipped clients actually get.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/check-supabase.mjs
 *   node scripts/check-supabase.mjs --offline   # config checks only
 *
 * Exits 0 when the project is ready for the apps, 1 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

const offline = process.argv.includes('--offline');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  ${red('FAIL')}  ${message}`);
};
const ok = (message) => console.log(`  ${green('ok')}    ${message}`);
const warn = (message) => console.log(`  ${yellow('warn')}  ${message}`);
const info = (message) => console.log(`  ${dim('·')}     ${message}`);

/* -------------------------------------------------------------------------- */
/* Env                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A deliberately small `.env` reader. `process.loadEnvFile` would do, but it
 * cannot merge three files with an explicit precedence, and the whole point
 * here is to report on each file *separately* — a placeholder in one file and a
 * real key in another is exactly the bug that started this.
 */
function parseEnvFile(path) {
  const values = new Map();
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return values;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return values;
}

const ENV_FILES = [
  { path: '.env', keys: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] },
  { path: 'apps/mobile/.env', keys: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] },
  { path: 'apps/desktop/.env', keys: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] },
];

/**
 * Why a value is unusable, or `null` when it looks fine.
 *
 * The `truncated` case is not hypothetical: the repo shipped with
 * `EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` copied
 * straight out of `.env.example`, which authenticates as nobody.
 */
function describeKeyProblem(value) {
  if (!value) return 'empty';
  if (/\.\.\.\s*$/.test(value) || /x{8,}/i.test(value)) return 'still the placeholder';
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return 'not a JWT';
  if (value.length < 120) return `truncated (${value.length} chars, expected ~200)`;
  return null;
}

const loaded = new Map(
  ENV_FILES.map(({ path }) => [path, parseEnvFile(join(REPO_ROOT, path))]),
);

/* -------------------------------------------------------------------------- */
/* Expected objects, derived from the migrations                               */
/* -------------------------------------------------------------------------- */

/**
 * Read the names out of the migration files rather than hardcoding them, so
 * adding a table does not silently make this check lie.
 */
function expectedObjects() {
  const tables = new Set();

  let files = [];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
  } catch {
    return { tables: [] };
  }

  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    for (const match of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)/gi,
    )) {
      tables.add(match[1]);
    }
  }

  return { tables: [...tables].sort() };
}

/**
 * The RPCs the client code actually calls, found by scanning for `.rpc('name')`.
 *
 * Deliberately *not* derived from the migrations: those also define trigger
 * helpers (`set_updated_at`, `tg_transactions_apply_balance`, …) which return
 * `trigger` and are not callable over PostgREST at all. Requiring them would
 * make a healthy database look broken, and a verifier that cries wolf is worse
 * than no verifier.
 */
function requiredRpcs() {
  const names = new Set();
  const root = join(REPO_ROOT, 'packages', 'shared', 'src');

  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/\.rpc\(\s*['"]([a-z_][a-z0-9_]*)['"]/gi)) {
          names.add(match[1]);
        }
      }
    }
  };

  walk(root);
  return [...names].sort();
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

async function probe(url, key, { bearer = true } = {}) {
  const headers = { apikey: key };
  if (bearer) headers.Authorization = `Bearer ${key}`;

  try {
    const response = await fetch(url, { headers });
    return { status: response.status, body: await response.text() };
  } catch (cause) {
    return { status: null, body: `${cause.name}: ${cause.message}` };
  }
}

function asJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

console.log(`\n${bold('sara-wallet — Supabase project check')}\n`);

/* ── 1. Config ───────────────────────────────────────────────────────────── */

console.log(bold('Config'));

const rootEnv = loaded.get('.env');
const url = rootEnv.get('SUPABASE_URL') ?? rootEnv.get('EXPO_PUBLIC_SUPABASE_URL') ?? '';
const anonKey = rootEnv.get('SUPABASE_ANON_KEY') ?? '';
const serviceKey = rootEnv.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

for (const { path, keys } of ENV_FILES) {
  const values = loaded.get(path);
  if (values.size === 0) {
    warn(`${path} — not found`);
    continue;
  }

  const problems = [];
  for (const key of keys) {
    const value = values.get(key);
    if (value === undefined) continue;
    const problem = key.includes('URL')
      ? (!value ? 'empty' : /x{8,}/i.test(value) ? 'still the placeholder' : null)
      : describeKeyProblem(value);
    if (problem) problems.push(`${key} — ${problem}`);
  }

  if (problems.length === 0) {
    ok(`${path}`);
  } else {
    for (const problem of problems) fail(`${path}: ${problem}`);
  }
}

if (!url || /x{8,}/i.test(url)) {
  fail('SUPABASE_URL is not set — nothing else can be checked.');
  console.log(`\n${red('RESULT: 1 failure')}\n`);
  process.exit(1);
}

info(`project ${url}`);

if (offline) {
  console.log(failures ? `\n${red(`RESULT: ${failures} failure(s)`)}\n` : `\n${green('RESULT: config looks fine')}\n`);
  process.exit(failures ? 1 : 0);
}

/* ── 2. Keys ─────────────────────────────────────────────────────────────── */

console.log(`\n${bold('Keys')}`);

const keyProbes = [
  ['SUPABASE_ANON_KEY', anonKey],
  ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
];

const reachable = new Map();

for (const [name, key] of keyProbes) {
  if (!key) {
    warn(`${name} — not set, skipped`);
    continue;
  }

  const { status, body } = await probe(`${url}/rest/v1/wallets?select=id&limit=1`, key);
  const payload = asJson(body);

  if (status === null) {
    fail(`${name} — could not reach the project (${body})`);
  } else if (status === 401) {
    fail(`${name} — rejected by the API (${payload?.message ?? body.slice(0, 120)})`);
  } else if (status === 404 && payload?.code === 'PGRST205') {
    ok(`${name} — authenticates (the schema is missing, see below)`);
    reachable.set(name, true);
  } else if (status === 200 || status === 206) {
    ok(`${name} — authenticates, \`wallets\` is visible`);
    reachable.set(name, true);
  } else {
    warn(`${name} — HTTP ${status}: ${payload?.message ?? body.slice(0, 120)}`);
  }
}

/* ── 3. Schema cache ─────────────────────────────────────────────────────── */

console.log(`\n${bold('Schema cache')}`);

const { tables: expectedTables } = expectedObjects();
const expectedRpcs = requiredRpcs();
const schemaKey = serviceKey || anonKey;

const { status: specStatus, body: specBody } = await probe(`${url}/rest/v1/`, schemaKey);
const spec = asJson(specBody);

let liveTables = [];
let liveFunctions = [];

if (specStatus === null) {
  fail(`could not read the schema (${specBody})`);
} else if (!spec) {
  fail(`unexpected response from the REST root (HTTP ${specStatus})`);
} else {
  // The root path `/` is in `paths` too, and `''` is not a table.
  const paths = Object.keys(spec.paths ?? {});
  const isRpc = (path) => path.startsWith('/rpc/');
  const bare = (path) => path.replace(/^\/rpc\//, '').replace(/^\//, '');

  liveTables = paths
    .filter((path) => !isRpc(path) && bare(path) !== '')
    .map(bare)
    .sort();
  liveFunctions = paths.filter(isRpc).map(bare).sort();

  console.log(
    `  ${dim('·')}     PostgREST exposes ${liveTables.length} table(s), ${liveFunctions.length} function(s)`,
  );
}

if (liveTables.length === 0) {
  fail('PostgREST sees no tables at all — the migrations have never been applied.');
  console.log(
    `\n  ${bold('Fix:')} run ${bold('pnpm migrations:bundle')}, then paste\n` +
      `  ${relative(REPO_ROOT, join(REPO_ROOT, 'supabase', 'apply-all.sql')).replace(/\\/g, '/')}\n` +
      `  into Supabase Dashboard -> SQL Editor -> New query -> Run.\n` +
      `  Then re-run this check.`,
  );
} else {
  const missingTables = expectedTables.filter((table) => !liveTables.includes(table));
  const extraTables = liveTables.filter((table) => !expectedTables.includes(table));

  if (missingTables.length === 0) {
    ok(`tables present: ${expectedTables.join(', ')}`);
  } else {
    fail(`missing table(s): ${missingTables.join(', ')}`);
  }

  if (extraTables.length > 0) {
    info(`also exposed: ${extraTables.join(', ')}`);
  }

  const missingRpcs = expectedRpcs.filter((rpc) => !liveFunctions.includes(rpc));
  if (expectedRpcs.length === 0) {
    warn('no `.rpc(...)` calls found in packages/shared — nothing to check');
  } else if (missingRpcs.length === 0) {
    ok(`callable functions present: ${expectedRpcs.join(', ')}`);
  } else {
    fail(`missing callable function(s): ${missingRpcs.join(', ')}`);
  }

  const helpers = liveFunctions.filter((name) => !expectedRpcs.includes(name));
  if (helpers.length > 0) {
    info(`${helpers.length} trigger helper(s) also exposed: ${helpers.join(', ')}`);
  }
}

/* ── 4. RLS ──────────────────────────────────────────────────────────────── */

console.log(`\n${bold('Row Level Security')}`);

const walletsVisible = liveTables.includes('wallets');

if (!walletsVisible) {
  warn('skipped — `wallets` is not exposed yet');
} else if (!anonKey) {
  warn('skipped — no anon key');
} else {
  // No `Authorization` header: this is the anonymous role, which is what a
  // signed-out client gets. It must not be able to read the ledger.
  const { status, body } = await probe(`${url}/rest/v1/wallets?select=id`, anonKey, {
    bearer: false,
  });
  const payload = asJson(body);

  if (status === null) {
    fail(`could not reach the project (${body})`);
  } else if (status === 200 || status === 206) {
    // A 2xx is only acceptable when RLS filtered everything out. Anything else
    // means the ledger is readable without signing in.
    const rows = Array.isArray(payload) ? payload : [];
    if (rows.length === 0) {
      ok('anon is refused (`wallets` returned no rows)');
    } else {
      fail(`anon can READ ${rows.length} wallet row(s) — RLS is not protecting the table.`);
    }
  } else {
    // 401 / 403 / 404 — all mean PostgREST would not serve the table to `anon`,
    // which is exactly what `0001_init.sql` sets up by granting it nothing.
    ok(`anon is refused (HTTP ${status}: ${payload?.message ?? 'permission denied'})`);
  }
}

/* ── Verdict ─────────────────────────────────────────────────────────────── */

console.log();
if (failures > 0) {
  console.log(red(bold(`RESULT: ${failures} failure(s)`)));
  console.log('The apps will not work until these are resolved.\n');
  process.exit(1);
}

console.log(green(bold('RESULT: the project is ready for the apps')));
console.log(`${dim('Remaining manual step: create an account in the app, then confirm')}`);
console.log(`${dim('handle_new_user() gave it a Cash/MMK wallet.\n')}`);
