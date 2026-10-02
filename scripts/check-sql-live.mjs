#!/usr/bin/env node
/**
 * Executes the migrations against a real PostgreSQL — no Docker, no psql.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `scripts/check-sql.py` proves the SQL *parses*. That is not the same as it
 * *running*: `0002_transfers.sql` originally rewrote `get_monthly_summary` with
 * `create or replace`, which PostgreSQL rejects outright because the rewrite
 * changes the function's return type. The parser was happy. Execution was not.
 *
 * This script boots PGlite (PostgreSQL 16 compiled to WebAssembly), stands up
 * the handful of objects Supabase provides for free, applies every migration in
 * order, and then runs `supabase/tests/assertions.sql` — which drives the
 * balance trigger through insert / amount-edit / direction-flip / wallet-move /
 * delete and reports what it observed.
 *
 * ── What it is not ─────────────────────────────────────────────────────────
 * PGlite is not Supabase. It has no PostgREST, no GoTrue, and no extension
 * catalogue to speak of. Two things follow:
 *
 *   • `auth.users` / `auth.uid()` / the `anon` and `authenticated` roles are
 *     shimmed here. They are close enough to run the migrations, but this is a
 *     stand-in, not the real thing.
 *   • `pgcrypto` is unavailable, so the `create extension` line in `0001` is
 *     skipped. Nothing is lost: the only function the migrations take from it is
 *     `gen_random_uuid()`, which has been core since PostgreSQL 13.
 *
 * Run `supabase/tests/assertions.sql` against a real Supabase project before
 * trusting a release; treat this as the fast, offline first line of defence.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/check-sql-live.mjs
 *   node scripts/check-sql-live.mjs --verbose     # also dump the full report
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const ASSERTIONS_FILE = join(REPO_ROOT, 'supabase', 'tests', 'assertions.sql');

/**
 * PGlite normally comes from the workspace root (`pnpm install`). The `.tools`
 * tree is the fallback for environments where installing into the workspace is
 * not possible — it is a plain `npm install --prefix .tools @electric-sql/pglite`
 * and is gitignored.
 */
async function loadPGlite() {
  try {
    return await import('@electric-sql/pglite');
  } catch {
    // fall through
  }

  const toolsManifest = join(REPO_ROOT, '.tools', 'package.json');
  if (existsSync(toolsManifest)) {
    try {
      const entry = createRequire(toolsManifest).resolve('@electric-sql/pglite');
      return await import(pathToFileURL(entry).href);
    } catch {
      // fall through
    }
  }

  throw new Error(
    'PGlite is not installed.\n' +
      '  pnpm add -D -w @electric-sql/pglite\n' +
      '  # or, if the workspace install is blocked:\n' +
      '  npm install --prefix .tools @electric-sql/pglite',
  );
}

const VERBOSE = process.argv.includes('--verbose');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/**
 * The parts of a Supabase database the migrations assume are already there.
 * Kept deliberately close to the real shapes: `auth.users` carries the columns
 * GoTrue actually has, because `handle_new_user` hangs off an INSERT into it.
 */
const SUPABASE_SHIM = `
create schema if not exists auth;
create schema if not exists extensions;

create table if not exists auth.users (
  instance_id        uuid,
  id                 uuid primary key,
  aud                varchar(255) default 'authenticated',
  role               varchar(255) default 'authenticated',
  email              varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- Same definition Supabase ships: reads the JWT claim off the session setting.
create or replace function auth.uid()
returns uuid
language sql
stable
as $uid$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$uid$;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$roles$;

grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

/** Removes the one statement PGlite cannot run, and says so. */
function stripUnsupportedExtensions(sql) {
  const pattern = /^\s*create extension if not exists "pgcrypto"[^;]*;\s*$/gim;
  const matches = sql.match(pattern);
  if (!matches) return { sql, removed: 0 };
  return { sql: sql.replace(pattern, ''), removed: matches.length };
}

async function main() {
  console.log(bold('\nsara-wallet — live SQL check (PGlite, PostgreSQL compiled to WASM)\n'));

  const { PGlite } = await loadPGlite();
  const db = await PGlite.create();

  const version = await db.query('select version() as v');
  console.log(dim(`  ${version.rows[0].v.split(',')[0]}`));

  // ── Supabase shim ────────────────────────────────────────────────────────
  console.log(`\n${bold('Supabase shim')}`);
  await db.exec(SUPABASE_SHIM);
  console.log(`  ${green('ok')}   auth.users, auth.uid(), anon + authenticated roles`);

  const hasPgcrypto = (
    await db.query("select 1 from pg_available_extensions where name = 'pgcrypto'")
  ).rows.length > 0;

  // ── Migrations ───────────────────────────────────────────────────────────
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  console.log(`\n${bold('Migrations')}`);

  for (const name of files) {
    const path = join(MIGRATIONS_DIR, name);
    let sql = readFileSync(path, 'utf8');
    const notes = [];

    if (!hasPgcrypto) {
      const stripped = stripUnsupportedExtensions(sql);
      if (stripped.removed > 0) {
        sql = stripped.sql;
        notes.push('pgcrypto unavailable in PGlite — skipped (gen_random_uuid is core)');
      }
    }

    const started = Date.now();
    try {
      await db.exec(sql);
      const ms = Date.now() - started;
      console.log(`  ${green('ok')}   ${name} ${dim(`(${ms} ms)`)}`);
      for (const note of notes) console.log(`       ${yellow('note')} ${dim(note)}`);
    } catch (error) {
      console.log(`  ${red('FAIL')} ${name}`);
      console.log(`       ${red(error.message)}`);
      await db.close();
      return 1;
    }
  }

  // ── Assertions ───────────────────────────────────────────────────────────
  console.log(`\n${bold('Assertions')}`);

  const assertionSql = readFileSync(ASSERTIONS_FILE, 'utf8');
  let results;
  try {
    results = await db.exec(assertionSql);
  } catch (error) {
    console.log(`  ${red('FAIL')} ${relative(REPO_ROOT, ASSERTIONS_FILE)}`);
    console.log(`       ${red(error.message)}`);
    await db.close();
    return 1;
  }

  // The script ends with two result sets: the per-check report and the verdict.
  const sets = results.filter((result) => result.rows && result.rows.length > 0);
  const report = sets.find((result) => result.fields?.some((f) => f.name === 'label'));
  const verdict = sets.find((result) => result.fields?.some((f) => f.name === 'verdict'));

  if (!report || !verdict) {
    console.log(`  ${red('FAIL')} could not find the report — did the script change shape?`);
    await db.close();
    return 1;
  }

  const rows = report.rows;
  const width = Math.max(...rows.map((row) => String(row.label).length));

  if (VERBOSE) {
    console.log('');
    for (const row of rows) {
      const tag =
        row.result === 'PASS' ? green('PASS ') : row.result === 'FAIL' ? red('FAIL ') : dim('setup');
      const detail = row.observed ? dim(`  ${row.observed}`) : '';
      console.log(`  ${tag} ${String(row.label).padEnd(width)}${detail}`);
    }
  }

  const failures = rows.filter((row) => row.result === 'FAIL');
  const passed = rows.filter((row) => row.result === 'PASS').length;

  console.log('');
  if (failures.length === 0) {
    console.log(`  ${green(`${passed} assertions passed`)} ${dim('(nothing was committed — the script rolled back)')}`);
  } else {
    console.log(`  ${red(`${failures.length} of ${passed + failures.length} assertions FAILED`)}\n`);
    for (const row of failures) {
      console.log(`  ${red('×')} ${row.label}`);
      if (row.observed) console.log(`    ${dim(row.observed)}`);
    }
    console.log(`\n  ${dim('Re-run with --verbose for the full report.')}`);
  }

  const summary = verdict.rows[0];
  console.log(
    dim(
      `\n  ${summary.assertions} assertions · ${summary.passed} passed · ${summary.failed} failed · ` +
        `${summary.setup_steps} setup steps`,
    ),
  );
  console.log(`\n${bold(summary.verdict)}\n`);

  await db.close();
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`\n${red('Unexpected failure:')} ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
