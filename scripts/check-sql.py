#!/usr/bin/env python3
"""Syntax-check the Supabase migrations with a real PostgreSQL parser.

There is no way to run PostgreSQL in CI here, so this is the cheapest guard
against a typo landing in a migration. It parses with the actual PostgreSQL
grammar (via `pglast`, which wraps libpg_query) rather than guessing.

It checks two things:
  1. every top-level statement parses
  2. every PL/pgSQL body parses — `parse_sql` treats those as opaque strings,
     so they are fed back through `parse_plpgsql_json` separately

Optional dependency:
    python -m venv .venv-sql
    .venv-sql/Scripts/pip install pglast      # Windows
    .venv-sql/bin/pip install pglast          # macOS / Linux

The script re-execs itself into `.venv-sql` (or `.venv`) when the Python that
launched it has no `pglast`, so `pnpm check:sql` works without any PATH
juggling.

Usage:
    python scripts/check-sql.py                      # all migrations, in order
    python scripts/check-sql.py path/to/file.sql     # one file

This proves the SQL *parses*. It cannot prove the trigger arithmetic adds up —
for that, run `supabase/tests/assertions.sql` against a real database.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Checked in this order. `.venv-sql` is the one the README's setup creates.
VENV_CANDIDATES = (".venv-sql", ".venv")


def venv_python() -> Path | None:
    """The interpreter of a local virtualenv, if one exists."""
    for name in VENV_CANDIDATES:
        for relative in ("Scripts/python.exe", "bin/python"):
            candidate = REPO_ROOT / name / relative
            if candidate.exists():
                return candidate
    return None


def ensure_pglast() -> None:
    """Re-run inside the local virtualenv when the outer Python lacks pglast.

    Without this, `pnpm check:sql` only works on a machine where pglast happens
    to be installed globally — which is nobody's machine, and not what the
    README tells you to set up. Delegating is cheaper than teaching every
    caller to type `.venv-sql/Scripts/python` first.
    """
    try:
        import pglast  # noqa: F401
    except ImportError:
        pass
    else:
        return

    interpreter = venv_python()
    if interpreter is not None and Path(sys.executable).resolve() != interpreter.resolve():
        # A child process rather than `os.execv`: on Windows `execv` rebuilds a
        # command line by joining argv with spaces and never quotes it, so a
        # path like `D:\\My App\\...` arrives at the child shredded.
        completed = subprocess.run(
            [str(interpreter), str(Path(__file__).resolve()), *sys.argv[1:]],
            check=False,
        )
        raise SystemExit(completed.returncode)

    print(
        "pglast is not installed.\n"
        "  python -m venv .venv-sql\n"
        "  .venv-sql/Scripts/pip install pglast   # Windows\n"
        "  .venv-sql/bin/pip install pglast       # macOS / Linux",
        file=sys.stderr,
    )
    raise SystemExit(2)


ensure_pglast()

from pglast import parser  # noqa: E402  (must follow the venv re-exec above)

DEFAULT_DIR = REPO_ROOT / "supabase" / "migrations"


def check_file(path: Path) -> list[str]:
    """Returns a list of human-readable failures. Empty means clean."""
    sql = path.read_text(encoding="utf-8")
    failures: list[str] = []

    # ── Pass 1: top-level statements ──────────────────────────────────────
    try:
        statements = parser.parse_sql(sql)
        print(f"  pass 1  parse_sql        {len(statements)} statements OK")
    except Exception as exc:  # noqa: BLE001
        failures.append(f"parse_sql: {exc}")
        print(f"  FAIL 1  parse_sql        {exc}")
        return failures  # nothing else is meaningful if this fails

    # ── Pass 2: PL/pgSQL bodies ───────────────────────────────────────────
    checked = 0
    for index, statement in enumerate(parser.split(sql), start=1):
        lowered = statement.lower()
        if "language plpgsql" not in lowered and not lowered.lstrip().startswith("do "):
            continue

        checked += 1
        try:
            parser.parse_plpgsql_json(statement)
        except Exception as exc:  # noqa: BLE001
            label = " ".join(statement.split())[:56]
            failures.append(f"statement #{index}: {exc}")
            print(f"  FAIL 2  plpgsql #{checked}       {exc}  ({label}…)")

    print(f"  pass 2  parse_plpgsql    {checked} body/bodies OK")

    return failures


def main() -> int:
    if len(sys.argv) > 1:
        targets = [Path(arg) for arg in sys.argv[1:]]
    else:
        targets = sorted(DEFAULT_DIR.glob("*.sql"))

    if not targets:
        print("No .sql files found.", file=sys.stderr)
        return 2

    total_failures = 0

    for path in targets:
        print(f"\n{path.relative_to(REPO_ROOT) if path.is_absolute() else path}")
        if not path.exists():
            print(f"  FAIL    file not found")
            total_failures += 1
            continue
        total_failures += len(check_file(path))

    print()
    if total_failures:
        print(f"RESULT: {total_failures} failure(s)")
        return 1

    print(f"RESULT: {len(targets)} file(s) parsed cleanly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
