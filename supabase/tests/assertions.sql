-- ============================================================================
--  sara-wallet — migration self-check
--  Target : Supabase (PostgreSQL 15+), run AFTER 0001 + 0002 + 0003
--  Usage  : Supabase Dashboard -> SQL Editor -> New query -> paste the whole
--           file -> Run. Read the "verdict" row in the last result set.
--
--  ── Why this file exists ──────────────────────────────────────────────────
--  `scripts/check-sql.py` proves the migrations *parse*. It cannot prove the
--  balance trigger adds up. Docker was unavailable in the environment these
--  migrations were written in, so the trigger arithmetic — the single most
--  important piece of business logic in the project — has never been executed.
--  This script is the cheapest way to close that gap: it runs the real thing
--  against a real database and reports what it observed.
--
--  ── How it stays safe ─────────────────────────────────────────────────────
--  Everything happens inside `begin; ... rollback;`. Two throwaway auth users
--  and a handful of wallets are created and then discarded. Running this
--  against a live project leaves no trace, and it is safe to run repeatedly.
--
--  ── What it does NOT cover ────────────────────────────────────────────────
--  Row Level Security is asserted *structurally* (policies exist, target
--  `authenticated`, `anon` holds no grants) rather than by simulating a
--  signed-in session, because the script runs as the SQL Editor's role. The
--  behavioural RLS tests live in the app's integration tests.
--
--  This is a plain-SQL script, not a pgTAP file — `supabase test db` will not
--  pick it up, and it is not meant to be run that way.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Harness
-- ---------------------------------------------------------------------------
do $harness$
begin
  -- `on commit drop` means the rollback at the end always clears this, but the
  -- explicit drop keeps a re-run in the same session safe even if a previous
  -- attempt was interrupted.
  drop table if exists _assert_results;

  create temporary table _assert_results (
    n        serial primary key,
    result   text not null,   -- PASS | FAIL | SETUP
    label    text not null,
    observed text
  ) on commit drop;
end
$harness$;

-- Records a boolean assertion. `p_observed` is shown whether it passes or not,
-- so a green run is still evidence rather than a bare "ok".
create or replace function pg_temp.check(p_ok boolean, p_label text, p_observed text default null)
returns void
language plpgsql
as $fn$
begin
  insert into _assert_results (result, label, observed)
  values (case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end, p_label, p_observed);
end
$fn$;

-- Runs a setup statement. Success is logged as SETUP (not an assertion), so the
-- verdict only counts real checks. Failure is logged as FAIL and does not abort
-- the run — the statement is rolled back to its own savepoint, so you still get
-- the rest of the report instead of a bare error and nothing else.
create or replace function pg_temp.run(p_sql text, p_label text)
returns void
language plpgsql
as $fn$
begin
  begin
    execute p_sql;
    insert into _assert_results (result, label) values ('SETUP', p_label);
  exception when others then
    insert into _assert_results (result, label, observed)
    values ('FAIL', p_label, format('SQLSTATE %s — %s', sqlstate, sqlerrm));
  end;
end
$fn$;

-- Asserts that a statement is refused. `p_expect_code` is the SQLSTATE the
-- migration promises; `p_expect_message` is a substring of the error text.
create or replace function pg_temp.expect_error(
  p_sql             text,
  p_label           text,
  p_expect_code     text default null,
  p_expect_message  text default null
)
returns void
language plpgsql
as $fn$
declare
  v_code text;
  v_msg  text;
begin
  begin
    execute p_sql;
    insert into _assert_results (result, label, observed)
    values ('FAIL', p_label, 'no error was raised — the guard is missing or not firing');
  exception when others then
    v_code := sqlstate;
    v_msg  := sqlerrm;
    insert into _assert_results (result, label, observed)
    values (
      case
        when p_expect_code is not null and p_expect_code <> v_code then 'FAIL'
        when p_expect_message is not null and v_msg not like '%' || p_expect_message || '%' then 'FAIL'
        else 'PASS'
      end,
      p_label,
      format('SQLSTATE %s — %s', v_code, v_msg)
    );
  end;
end
$fn$;

create or replace function pg_temp.balance(p_wallet uuid)
returns numeric
language sql
stable
as $fn$ select balance from public.wallets where id = p_wallet $fn$;

-- ── RLS helpers ────────────────────────────────────────────────────────────
-- These switch to a real role (`authenticated` / `anon`) for one statement, so
-- the policies are actually exercised rather than merely inspected. The role is
-- always reset before returning, because `_assert_results` belongs to the SQL
-- Editor's role and the switched role cannot write to it.

-- Asserts a statement is REFUSED for the given role.
create or replace function pg_temp.rls_denies(
  p_role        text,
  p_sub         uuid,
  p_sql         text,
  p_label       text,
  p_expect_code text default null
)
returns void
language plpgsql
as $fn$
declare
  v_code text;
  v_msg  text;
  v_rows integer;
begin
  perform set_config(
    'request.jwt.claims',
    case when p_sub is null then '' else format('{"sub":"%s","role":"%s"}', p_sub, p_role) end,
    true
  );

  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    get diagnostics v_rows = row_count;
  exception when others then
    v_code := sqlstate;
    v_msg  := sqlerrm;
  end;

  execute 'reset role';

  insert into _assert_results (result, label, observed)
  values (
    case
      when v_code is null then 'FAIL'
      when p_expect_code is not null and v_code <> p_expect_code then 'FAIL'
      else 'PASS'
    end,
    p_label,
    case
      when v_code is null then format('the statement was ALLOWED (%s row(s)) — the guard is missing', v_rows)
      else format('SQLSTATE %s — %s', v_code, v_msg)
    end
  );
end
$fn$;

-- Asserts a statement SUCCEEDS for `authenticated` and affects N rows. Row
-- count is how RLS filters UPDATE/DELETE: a row the policy hides simply is not
-- there, so zero rows affected is the correct, silent outcome.
create or replace function pg_temp.rls_allows(
  p_sub         uuid,
  p_sql         text,
  p_label       text,
  p_expect_rows integer
)
returns void
language plpgsql
as $fn$
declare
  v_code text;
  v_msg  text;
  v_rows integer := -1;
begin
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', p_sub), true);

  begin
    execute 'set local role authenticated';
    execute p_sql;
    get diagnostics v_rows = row_count;
  exception when others then
    v_code := sqlstate;
    v_msg  := sqlerrm;
  end;

  execute 'reset role';

  insert into _assert_results (result, label, observed)
  values (
    case
      when v_code is not null then 'FAIL'
      when v_rows <> p_expect_rows then 'FAIL'
      else 'PASS'
    end,
    p_label,
    case
      when v_code is not null then format('SQLSTATE %s — %s', v_code, v_msg)
      else format('%s row(s) affected, expected %s', v_rows, p_expect_rows)
    end
  );
end
$fn$;

-- Asserts a `select count(*)` returns N for `authenticated`.
create or replace function pg_temp.rls_count(
  p_sub    uuid,
  p_sql    text,
  p_label  text,
  p_expect integer
)
returns void
language plpgsql
as $fn$
declare
  v_code  text;
  v_msg   text;
  v_count integer := -1;
begin
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', p_sub), true);

  begin
    execute 'set local role authenticated';
    execute p_sql into v_count;
  exception when others then
    v_code := sqlstate;
    v_msg  := sqlerrm;
  end;

  execute 'reset role';

  insert into _assert_results (result, label, observed)
  values (
    case
      when v_code is not null then 'FAIL'
      when v_count is distinct from p_expect then 'FAIL'
      else 'PASS'
    end,
    p_label,
    case
      when v_code is not null then format('SQLSTATE %s — %s', v_code, v_msg)
      else format('counted %s, expected %s', v_count, p_expect)
    end
  );
end
$fn$;

-- Creates an auth.users row, supplying every NOT NULL column that has no
-- default so this survives GoTrue schema drift. `handle_new_user` then fires
-- and gives the user a starting wallet — which is itself one of the assertions.
create or replace function pg_temp.make_user(p_id uuid)
returns void
language plpgsql
as $fn$
declare
  v_cols text;
  v_vals text;
  v_col  record;
  v_val  text;
begin
  for v_col in
    select c.column_name, c.udt_name
      from information_schema.columns c
     where c.table_schema = 'auth'
       and c.table_name   = 'users'
       and c.is_nullable  = 'NO'
       and c.column_default is null
       and c.is_generated <> 'ALWAYS'
       and c.identity_generation is null
       and c.column_name not in ('id', 'email')
     order by c.ordinal_position
  loop
    v_val := case
      when v_col.udt_name = 'uuid'                                            then 'gen_random_uuid()'
      when v_col.udt_name in ('timestamptz', 'timestamp', 'date', 'time')      then 'now()'
      when v_col.udt_name = 'bool'                                            then 'false'
      when v_col.udt_name in ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8') then '0'
      when v_col.udt_name in ('json', 'jsonb')                                then quote_literal('{}') || '::' || v_col.udt_name
      when v_col.udt_name like '\_%'                                          then quote_literal('{}') || '::' || v_col.udt_name
      else quote_literal('')
    end;
    v_cols := concat_ws(', ', v_cols, quote_ident(v_col.column_name));
    v_vals := concat_ws(', ', v_vals, v_val);
  end loop;

  execute format(
    'insert into auth.users (id, email%s) values (%L, %L%s)',
    case when v_cols is null then '' else ', ' || v_cols end,
    p_id,
    'wallet-check-' || replace(p_id::text, '-', '') || '@example.test',
    case when v_vals is null then '' else ', ' || v_vals end
  );
end
$fn$;


-- ---------------------------------------------------------------------------
-- 1. Everything else
-- ---------------------------------------------------------------------------
do $main$
declare
  -- Throwaway principals. Deterministic so a re-run is identical.
  v_user    uuid := '20000000-0000-4000-8000-000000000001';
  v_other   uuid := '20000000-0000-4000-8000-000000000002';

  -- Throwaway wallets. `v_cash` is created by the signup trigger, so it is
  -- looked up rather than declared.
  v_cash    uuid;
  v_bank    uuid := '10000000-0000-4000-8000-000000000001';
  v_savings uuid := '10000000-0000-4000-8000-000000000002';
  v_temp    uuid := '10000000-0000-4000-8000-000000000003';
  v_usd     uuid := '10000000-0000-4000-8000-000000000004';
  v_zero    uuid := '10000000-0000-4000-8000-000000000005';

  -- Throwaway ledger rows.
  v_t1 uuid := '00000000-0000-4000-8000-000000000001';
  v_t2 uuid := '00000000-0000-4000-8000-000000000002';
  v_t3 uuid := '00000000-0000-4000-8000-000000000003';
  v_t4 uuid := '00000000-0000-4000-8000-000000000004';
  v_t5 uuid := '00000000-0000-4000-8000-000000000005';
  v_t6 uuid := '00000000-0000-4000-8000-000000000006';
  v_t7 uuid := '00000000-0000-4000-8000-000000000007';
  v_t8 uuid := '00000000-0000-4000-8000-000000000008';

  v_group   uuid;
  v_summary record;
  v_leg     uuid;
  v_before  timestamptz;
  v_after   timestamptz;
  v_other_wallet uuid;
  v_expected     integer;
begin

  -- ═════════════════════════════════════════════════════════════════════════
  -- A. Structure — RLS, grants, triggers, indexes
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.check(
    (select relrowsecurity from pg_class where oid = 'public.wallets'::regclass),
    'RLS is enabled on public.wallets');

  perform pg_temp.check(
    (select relrowsecurity from pg_class where oid = 'public.transactions'::regclass),
    'RLS is enabled on public.transactions');

  perform pg_temp.check(
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'wallets') = 4,
    'wallets has exactly 4 policies (select/insert/update/delete)',
    format('found %s', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'wallets')));

  perform pg_temp.check(
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'transactions') = 4,
    'transactions has exactly 4 policies (select/insert/update/delete)',
    format('found %s', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'transactions')));

  perform pg_temp.check(
    (select bool_and('authenticated'::name = any(roles) and array_length(roles, 1) = 1)
       from pg_policies where schemaname = 'public'),
    'every policy targets the authenticated role and nothing else',
    (select string_agg(distinct roles::text, ', ') from pg_policies where schemaname = 'public'));

  -- INSERT policies carry `with_check` and no `qual`; UPDATE policies carry
  -- both. A policy that names auth.uid() in neither would be wide open.
  perform pg_temp.check(
    (select bool_and(
              coalesce(qual, '')       like '%auth.uid()%'
           or coalesce(with_check, '') like '%auth.uid()%')
       from pg_policies where schemaname = 'public'),
    'every policy predicate is pinned to auth.uid()',
    format('%s of %s policies reference auth.uid()',
           (select count(*) from pg_policies
             where schemaname = 'public'
               and (coalesce(qual, '') like '%auth.uid()%'
                 or coalesce(with_check, '') like '%auth.uid()%')),
           (select count(*) from pg_policies where schemaname = 'public')));

  -- `anon` holding no grants is the whole reason a leaked anon key is harmless.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    perform pg_temp.check(
      not has_table_privilege('anon', 'public.wallets', 'select')
      and not has_table_privilege('anon', 'public.wallets', 'insert')
      and not has_table_privilege('anon', 'public.transactions', 'select')
      and not has_table_privilege('anon', 'public.transactions', 'insert'),
      'anon has no privileges on either table');
  else
    perform pg_temp.check(false, 'anon role exists',
      'the anon role is missing — is this a Supabase database?');
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- NB: `has_table_privilege` with a comma-separated list returns true when
    -- *any* of the listed privileges is held, so each one is asked for
    -- separately. A single combined call would pass on SELECT alone.
    perform pg_temp.check(
      has_table_privilege('authenticated', 'public.wallets', 'select')
      and has_table_privilege('authenticated', 'public.wallets', 'insert')
      and has_table_privilege('authenticated', 'public.wallets', 'update')
      and has_table_privilege('authenticated', 'public.wallets', 'delete')
      and has_table_privilege('authenticated', 'public.transactions', 'select')
      and has_table_privilege('authenticated', 'public.transactions', 'insert')
      and has_table_privilege('authenticated', 'public.transactions', 'update')
      and has_table_privilege('authenticated', 'public.transactions', 'delete'),
      'authenticated holds select/insert/update/delete on both tables');
  end if;

  perform pg_temp.check(
    (select count(*) from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'wallets_user_id_idx',
          'transactions_user_id_idx',
          'transactions_wallet_id_idx',
          'transactions_date_idx',
          'transactions_user_date_idx',
          'transactions_wallet_date_idx',
          'transactions_user_category_idx',
          'transactions_transfer_group_idx')) = 8,
    'all 8 indexes from the migrations exist',
    (select string_agg(indexname, ', ' order by indexname)
       from pg_indexes where schemaname = 'public' and indexname like '%_idx'));

  perform pg_temp.check(
    (select count(*) from pg_trigger
      where not tgisinternal
        and tgname in (
          'wallets_set_updated_at',
          'wallets_guard_currency_change',
          'transactions_assert_owner',
          'transactions_apply_balance',
          'transactions_block_transfer_leg_edit',
          'transactions_cascade_transfer_delete',
          'on_auth_user_created')) = 7,
    'all 7 triggers from the migrations exist',
    (select string_agg(tgname, ', ' order by tgname) from pg_trigger where not tgisinternal));

  -- The 0001 -> 0002 rewrite of get_monthly_summary changed its return type.
  -- `information_schema.columns` covers tables and views only — function OUT
  -- parameters live in pg_proc, so that is what has to be read here.
  perform pg_temp.check(
    (select (select count(*) from unnest(p.proargnames) as a(n)
              where a.n in ('income', 'expense', 'net', 'transaction_count', 'transfer_volume')) = 5
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_monthly_summary'),
    'get_monthly_summary exposes 5 columns including transfer_volume',
    (select pg_get_function_result(p.oid)
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_monthly_summary'));


  -- ═════════════════════════════════════════════════════════════════════════
  -- B. Signup
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$select pg_temp.make_user(%L)$q$, v_user),
    'create test user A');

  perform pg_temp.run(
    format($q$select pg_temp.make_user(%L)$q$, v_other),
    'create test user B');

  select id into v_cash
    from public.wallets where user_id = v_user and name = 'Cash';

  perform pg_temp.check(
    (select count(*) from public.wallets where user_id = v_user) = 1,
    'handle_new_user gives a new signup exactly one wallet',
    format('wallets for user A: %s',
           (select count(*) from public.wallets where user_id = v_user)));

  perform pg_temp.check(
    v_cash is not null
    and (select currency from public.wallets where id = v_cash) = 'MMK'
    and (select balance from public.wallets where id = v_cash) = 0,
    'the starting wallet is "Cash", MMK, balance 0',
    (select format('name=%s currency=%s balance=%s', name, currency, balance)
       from public.wallets where id = v_cash));

  perform pg_temp.run(
    format($q$select set_config('request.jwt.claims', %L, true)$q$,
           format('{"sub":"%s","role":"authenticated"}', v_user)),
    'sign in as test user A (set request.jwt.claims)');


  -- ═════════════════════════════════════════════════════════════════════════
  -- C. The balance trigger
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$insert into public.wallets (id, user_id, name, currency, balance)
              values (%L, %L, 'Bank', 'MMK', 0)$q$, v_bank, v_user),
    'create wallet Bank');

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'INCOME', 1000, 'Salary', now())$q$, v_t1, v_cash, v_user),
    'INSERT INCOME 1000 into Cash');
  perform pg_temp.check(pg_temp.balance(v_cash) = 1000,
    'INCOME raises the balance by its amount',
    format('cash = %s (expected 1000)', pg_temp.balance(v_cash)));

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'EXPENSE', 250, 'Food', now())$q$, v_t2, v_cash, v_user),
    'INSERT EXPENSE 250 into Cash');
  perform pg_temp.check(pg_temp.balance(v_cash) = 750,
    'EXPENSE lowers the balance by its amount',
    format('cash = %s (expected 750)', pg_temp.balance(v_cash)));

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'INCOME', 500, 'Refund', now())$q$, v_t3, v_bank, v_user),
    'INSERT INCOME 500 into Bank');
  perform pg_temp.check(pg_temp.balance(v_bank) = 500,
    'a second wallet keeps its own balance',
    format('bank = %s (expected 500)', pg_temp.balance(v_bank)));

  -- Editing the amount: only the difference may be applied.
  perform pg_temp.run(
    format($q$update public.transactions set amount = 1200 where id = %L$q$, v_t1),
    'UPDATE T1 amount 1000 -> 1200');
  perform pg_temp.check(pg_temp.balance(v_cash) = 950,
    'changing the amount applies only the delta (+200), not the whole new amount',
    format('cash = %s (expected 950)', pg_temp.balance(v_cash)));

  -- Flipping the direction must undo the old effect before applying the new one.
  perform pg_temp.run(
    format($q$update public.transactions set type = 'EXPENSE' where id = %L$q$, v_t1),
    'UPDATE T1 INCOME -> EXPENSE');
  perform pg_temp.check(pg_temp.balance(v_cash) = -1450,
    'flipping INCOME to EXPENSE reverses the old effect and applies the new one',
    format('cash = %s (expected -1450)', pg_temp.balance(v_cash)));

  perform pg_temp.run(
    format($q$update public.transactions set type = 'INCOME' where id = %L$q$, v_t1),
    'UPDATE T1 EXPENSE -> INCOME (back)');
  perform pg_temp.check(pg_temp.balance(v_cash) = 950,
    'flipping back restores the original balance',
    format('cash = %s (expected 950)', pg_temp.balance(v_cash)));

  -- Moving a row between wallets must touch both sides.
  perform pg_temp.run(
    format($q$update public.transactions set wallet_id = %L where id = %L$q$, v_bank, v_t2),
    'UPDATE T2 wallet_id Cash -> Bank');
  perform pg_temp.check(
    pg_temp.balance(v_cash) = 1200 and pg_temp.balance(v_bank) = 250,
    'moving a transaction to another wallet debits one and credits the other',
    format('cash = %s (expected 1200), bank = %s (expected 250)',
           pg_temp.balance(v_cash), pg_temp.balance(v_bank)));

  perform pg_temp.run(
    format($q$update public.transactions set wallet_id = %L where id = %L$q$, v_cash, v_t2),
    'UPDATE T2 wallet_id Bank -> Cash (back)');
  perform pg_temp.check(
    pg_temp.balance(v_cash) = 950 and pg_temp.balance(v_bank) = 500,
    'moving it back restores both wallets',
    format('cash = %s (expected 950), bank = %s (expected 500)',
           pg_temp.balance(v_cash), pg_temp.balance(v_bank)));

  -- Deleting must undo the row exactly.
  perform pg_temp.run(
    format($q$delete from public.transactions where id = %L$q$, v_t3),
    'DELETE T3 (INCOME 500 on Bank)');
  perform pg_temp.check(pg_temp.balance(v_bank) = 0,
    'deleting an INCOME row takes the money back out',
    format('bank = %s (expected 0)', pg_temp.balance(v_bank)));

  perform pg_temp.run(
    format($q$delete from public.transactions where id = %L$q$, v_t1),
    'DELETE T1 (INCOME 1200 on Cash)');
  perform pg_temp.check(pg_temp.balance(v_cash) = -250,
    'deleting an edited row reverses its current value, not its original one',
    format('cash = %s (expected -250)', pg_temp.balance(v_cash)));

  perform pg_temp.run(
    format($q$delete from public.transactions where id = %L$q$, v_t2),
    'DELETE T2 (EXPENSE 250 on Cash)');
  perform pg_temp.check(
    pg_temp.balance(v_cash) = 0 and pg_temp.balance(v_bank) = 0,
    'after deleting everything both wallets are back to zero',
    format('cash = %s, bank = %s', pg_temp.balance(v_cash), pg_temp.balance(v_bank)));

  perform pg_temp.check(
    (select count(*) from public.transactions where user_id = v_user) = 0,
    'every ledger row is gone',
    format('%s rows remain', (select count(*) from public.transactions where user_id = v_user)));


  -- ═════════════════════════════════════════════════════════════════════════
  -- D. Opening balance, and the updated_at trigger
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$insert into public.wallets (id, user_id, name, currency, balance)
              values (%L, %L, 'Savings', 'MMK', 5000)$q$, v_savings, v_user),
    'create wallet Savings with an opening balance of 5000');

  perform pg_temp.check(pg_temp.balance(v_savings) = 5000,
    'the opening balance survives — the trigger only ever applies deltas',
    format('savings = %s (expected 5000)', pg_temp.balance(v_savings)));

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'INCOME', 100, 'Interest', now())$q$, v_t5, v_savings, v_user),
    'INSERT INCOME 100 into Savings');
  perform pg_temp.check(pg_temp.balance(v_savings) = 5100,
    'a transaction on top of an opening balance adds correctly',
    format('savings = %s (expected 5100)', pg_temp.balance(v_savings)));

  -- `now()` is `transaction_timestamp()`, so it is *constant* for the whole
  -- transaction — a same-transaction "did updated_at move?" check can never
  -- observe a bump, no matter how long the test runs. Back-dating the column
  -- with the trigger switched off, then letting the trigger fire, is what
  -- actually proves the trigger does its job.
  perform pg_temp.run(
    $q$alter table public.wallets disable trigger wallets_set_updated_at$q$,
    'disable wallets_set_updated_at so updated_at can be back-dated');
  perform pg_temp.run(
    format($q$update public.wallets set updated_at = now() - interval '1 day' where id = %L$q$, v_savings),
    'back-date updated_at by one day');
  perform pg_temp.run(
    $q$alter table public.wallets enable trigger wallets_set_updated_at$q$,
    're-enable wallets_set_updated_at');

  select updated_at into v_before from public.wallets where id = v_savings;
  perform pg_temp.run(
    format($q$update public.wallets set name = 'Savings pot' where id = %L$q$, v_savings),
    'rename the Savings wallet');
  select updated_at into v_after from public.wallets where id = v_savings;

  perform pg_temp.check(v_after > v_before,
    'wallets_set_updated_at refreshes updated_at on update',
    format('before = %s, after = %s', v_before, v_after));

  perform pg_temp.check(pg_temp.balance(v_savings) = 5100,
    'renaming a wallet leaves the balance alone',
    format('savings = %s (expected 5100)', pg_temp.balance(v_savings)));


  -- ═════════════════════════════════════════════════════════════════════════
  -- E. Transfers
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'INCOME', 1000, 'Salary', now())$q$, v_t4, v_cash, v_user),
    'INSERT INCOME 1000 into Cash (transfer starting point)');
  perform pg_temp.check(pg_temp.balance(v_cash) = 1000,
    'Cash is funded for the transfer tests',
    format('cash = %s (expected 1000)', pg_temp.balance(v_cash)));

  begin
    v_group := public.transfer_between_wallets(v_cash, v_bank, 400, 'Move to bank');
    perform pg_temp.check(true, 'transfer_between_wallets returns a group id',
      format('group = %s', v_group));
  exception when others then
    perform pg_temp.check(false, 'transfer_between_wallets returns a group id',
      format('SQLSTATE %s — %s', sqlstate, sqlerrm));
  end;

  perform pg_temp.check(
    pg_temp.balance(v_cash) = 600 and pg_temp.balance(v_bank) = 400,
    'a transfer debits the source and credits the destination',
    format('cash = %s (expected 600), bank = %s (expected 400)',
           pg_temp.balance(v_cash), pg_temp.balance(v_bank)));

  perform pg_temp.check(
    (select count(*) from public.transactions where transfer_group_id = v_group) = 2,
    'a transfer writes exactly two ledger rows',
    format('%s rows carry the group id',
           (select count(*) from public.transactions where transfer_group_id = v_group)));

  perform pg_temp.check(
    (select bool_and(category = 'Transfer') from public.transactions where transfer_group_id = v_group),
    'both legs are categorised as "Transfer"',
    (select string_agg(category, ', ') from public.transactions where transfer_group_id = v_group));

  perform pg_temp.check(
    (select count(*) from public.transactions where transfer_group_id = v_group and type = 'EXPENSE') = 1
    and (select count(*) from public.transactions where transfer_group_id = v_group and type = 'INCOME') = 1,
    'the pair is one EXPENSE leg and one INCOME leg',
    -- `type` is the transaction_type enum, and string_agg wants text — there is
    -- no implicit enum -> text cast, so this has to be explicit.
    (select string_agg(type::text, ', ' order by type::text)
       from public.transactions where transfer_group_id = v_group));

  -- Refusals.
  perform pg_temp.expect_error(
    format($q$select public.transfer_between_wallets(%L, %L, 0)$q$, v_cash, v_bank),
    'a zero-amount transfer is refused', '23514');

  perform pg_temp.expect_error(
    format($q$select public.transfer_between_wallets(%L, %L, -50)$q$, v_cash, v_bank),
    'a negative-amount transfer is refused', '23514');

  perform pg_temp.expect_error(
    format($q$select public.transfer_between_wallets(%L, %L, 10)$q$, v_cash, v_cash),
    'a transfer to the same wallet is refused', '23514', 'two different wallets');

  -- The migration raises with `errcode = 'no_data_found'`, whose SQLSTATE is
  -- P0002 — not 02000, which is the older `no_data` condition.
  perform pg_temp.expect_error(
    format($q$select public.transfer_between_wallets(%L, %L, 10)$q$, v_cash, v_usd),
    'a transfer from a wallet that does not exist is refused', 'P0002');

  perform pg_temp.run(
    format($q$insert into public.wallets (id, user_id, name, currency, balance)
              values (%L, %L, 'Dollars', 'USD', 0)$q$, v_usd, v_user),
    'create an empty USD wallet');

  perform pg_temp.expect_error(
    format($q$select public.transfer_between_wallets(%L, %L, 10)$q$, v_cash, v_usd),
    'a cross-currency transfer is refused rather than assuming 1:1', '23514', 'exchange rate');

  perform pg_temp.check(
    pg_temp.balance(v_cash) = 600 and pg_temp.balance(v_usd) = 0,
    'a refused transfer moves no money at all',
    format('cash = %s, usd = %s', pg_temp.balance(v_cash), pg_temp.balance(v_usd)));

  -- A transfer is edited as a unit.
  select id into v_leg from public.transactions
   where transfer_group_id = v_group and type = 'EXPENSE';

  perform pg_temp.expect_error(
    format($q$update public.transactions set amount = 1 where id = %L$q$, v_leg),
    'editing one leg of a transfer is refused', '23514', 'leg of a transfer');

  -- Reporting.
  select * into v_summary from public.get_monthly_summary(null, null);
  perform pg_temp.check(
    v_summary.income = 1100 and v_summary.expense = 0 and v_summary.net = 1100,
    'transfer legs are excluded from income / expense / net',
    format('income = %s (expected 1100), expense = %s (expected 0), net = %s (expected 1100)',
           v_summary.income, v_summary.expense, v_summary.net));

  perform pg_temp.check(
    v_summary.transfer_volume = 400,
    'the transfer is reported separately as transfer_volume',
    format('transfer_volume = %s (expected 400)', v_summary.transfer_volume));

  perform pg_temp.check(
    v_summary.transaction_count = 4,
    'transaction_count still counts the transfer legs',
    format('transaction_count = %s (expected 4)', v_summary.transaction_count));

  -- Cash holds the INCOME 1000 plus the EXPENSE leg of the transfer, so the
  -- count includes both even though only one of them is real income.
  select * into v_summary from public.get_monthly_summary(v_cash, null);
  perform pg_temp.check(
    v_summary.income = 1000 and v_summary.expense = 0 and v_summary.transaction_count = 2
    and v_summary.transfer_volume = 400,
    'the per-wallet summary scopes to the source wallet',
    format('income = %s, expense = %s, count = %s, transfer_volume = %s',
           v_summary.income, v_summary.expense, v_summary.transaction_count, v_summary.transfer_volume));

  -- Bank holds only the INCOME leg. Transfer legs are excluded from income, and
  -- transfer_volume counts EXPENSE legs only — so both figures are zero even
  -- though the wallet does have a row in the month.
  select * into v_summary from public.get_monthly_summary(v_bank, null);
  perform pg_temp.check(
    v_summary.income = 0 and v_summary.expense = 0 and v_summary.transaction_count = 1
    and v_summary.transfer_volume = 0,
    'the per-wallet summary scopes to the destination wallet',
    format('income = %s, expense = %s, count = %s, transfer_volume = %s',
           v_summary.income, v_summary.expense, v_summary.transaction_count, v_summary.transfer_volume));

  -- Deleting one leg removes the whole transfer and restores both wallets.
  perform pg_temp.run(
    format($q$delete from public.transactions where id = %L$q$, v_leg),
    'DELETE one leg of the transfer');

  perform pg_temp.check(
    (select count(*) from public.transactions where transfer_group_id = v_group) = 0,
    'deleting one leg deletes its sibling too',
    format('%s rows still carry the group id',
           (select count(*) from public.transactions where transfer_group_id = v_group)));

  perform pg_temp.check(
    pg_temp.balance(v_cash) = 1000 and pg_temp.balance(v_bank) = 0,
    'deleting a transfer puts both wallets back where they started',
    format('cash = %s (expected 1000), bank = %s (expected 0)',
           pg_temp.balance(v_cash), pg_temp.balance(v_bank)));

  select * into v_summary from public.get_monthly_summary(null, null);
  perform pg_temp.check(
    v_summary.income = 1100 and v_summary.transfer_volume = 0 and v_summary.transaction_count = 2,
    'the summary drops the transfer once it is deleted',
    format('income = %s, transfer_volume = %s, count = %s',
           v_summary.income, v_summary.transfer_volume, v_summary.transaction_count));

  -- An anonymous caller must not be able to transfer.
  perform pg_temp.run(
    $q$select set_config('request.jwt.claims', '', true)$q$,
    'sign out (clear request.jwt.claims)');

  perform pg_temp.expect_error(
    format($q$select public.transfer_between_wallets(%L, %L, 10)$q$, v_cash, v_bank),
    'a transfer with no session is refused', '42501');

  perform pg_temp.run(
    format($q$select set_config('request.jwt.claims', %L, true)$q$,
           format('{"sub":"%s","role":"authenticated"}', v_user)),
    'sign back in as test user A');


  -- ═════════════════════════════════════════════════════════════════════════
  -- F. The currency-change guard
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$update public.wallets set currency = 'USD' where id = %L$q$, v_savings),
    'changing the currency of a wallet that holds a balance is refused',
    '23514', 'holds a balance');

  perform pg_temp.run(
    format($q$update public.wallets set currency = 'MMK' where id = %L$q$, v_cash),
    're-setting the same currency is allowed');

  perform pg_temp.check(
    (select currency from public.wallets where id = v_cash) = 'MMK',
    'a no-op currency update leaves the wallet untouched',
    (select currency from public.wallets where id = v_cash));

  perform pg_temp.run(
    format($q$insert into public.wallets (id, user_id, name, currency, balance)
              values (%L, %L, 'Petty cash', 'USD', 0)$q$, v_temp, v_user),
    'create an empty USD wallet');

  perform pg_temp.run(
    format($q$update public.wallets set currency = 'THB' where id = %L$q$, v_temp),
    'an empty wallet with no history may change currency');

  perform pg_temp.check(
    (select currency from public.wallets where id = v_temp) = 'THB',
    'the currency change actually landed',
    (select currency from public.wallets where id = v_temp));

  -- Balance zero but history present — still refused.
  perform pg_temp.run(
    format($q$insert into public.wallets (id, user_id, name, currency, balance)
              values (%L, %L, 'Round trip', 'MMK', 0)$q$, v_zero, v_user),
    'create a wallet for the zero-balance-with-history case');

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'INCOME', 100, 'Test', now())$q$, v_t6, v_zero, v_user),
    'INSERT INCOME 100 into it');
  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'EXPENSE', 100, 'Test', now())$q$, v_t7, v_zero, v_user),
    'INSERT EXPENSE 100 into it');

  perform pg_temp.check(pg_temp.balance(v_zero) = 0,
    'the round-trip wallet nets to zero',
    format('zero wallet = %s', pg_temp.balance(v_zero)));

  perform pg_temp.expect_error(
    format($q$update public.wallets set currency = 'USD' where id = %L$q$, v_zero),
    'a wallet with history may not change currency even at a zero balance',
    '23514', 'already has transactions');


  -- ═════════════════════════════════════════════════════════════════════════
  -- G. CHECK constraints
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date)
              values (%L, %L, 'INCOME', 0, 'Bad', now())$q$, v_cash, v_user),
    'a zero-amount transaction is rejected by the CHECK constraint', '23514');

  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date)
              values (%L, %L, 'EXPENSE', -5, 'Bad', now())$q$, v_cash, v_user),
    'a negative-amount transaction is rejected — the sign lives in `type`', '23514');

  perform pg_temp.expect_error(
    format($q$insert into public.wallets (user_id, name, currency, balance)
              values (%L, 'Lowercase', 'mmk', 0)$q$, v_user),
    'a lowercase currency code is rejected by the ISO CHECK constraint', '23514');

  perform pg_temp.expect_error(
    format($q$insert into public.wallets (user_id, name, currency, balance)
              values (%L, '', 'MMK', 0)$q$, v_user),
    'an empty wallet name is rejected', '23514');

  perform pg_temp.expect_error(
    format($q$insert into public.wallets (user_id, name, currency, balance)
              values (%L, %L, 'MMK', 0)$q$, v_user, repeat('x', 81)),
    'an 81-character wallet name is rejected', '23514');


  -- ═════════════════════════════════════════════════════════════════════════
  -- H. Ownership guard
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date)
              values (%L, %L, 'INCOME', 10, 'Forged', now())$q$, v_cash, v_other),
    'a transaction cannot be attached to somebody else''s wallet',
    '23514', 'must match the owner');

  perform pg_temp.check(
    (select count(*) from public.transactions where user_id = v_other) = 0,
    'the forged transaction was not written',
    format('%s rows belong to user B', (select count(*) from public.transactions where user_id = v_other)));

  perform pg_temp.check(
    (select count(*) from public.wallets where user_id = v_other) = 1,
    'user B still has only their own starting wallet',
    format('%s wallets for user B', (select count(*) from public.wallets where user_id = v_other)));


  -- ═════════════════════════════════════════════════════════════════════════
  -- I. Row Level Security, exercised rather than inspected
  --
  -- Section A proves the policies are *declared* correctly. This section proves
  -- they actually *do* something: every statement below runs as the
  -- `authenticated` role with a real JWT subject, so `auth.uid()` resolves and
  -- RLS applies. Nothing here would fail if the policies were merely absent.
  -- ═════════════════════════════════════════════════════════════════════════
  select id into v_other_wallet from public.wallets where user_id = v_other;

  -- Visibility -------------------------------------------------------------
  select count(*) into v_expected from public.wallets where user_id = v_user;
  perform pg_temp.rls_count(
    v_user,
    'select count(*) from public.wallets',
    'user A sees exactly their own wallets and nobody else''s',
    v_expected);

  perform pg_temp.rls_count(
    v_user,
    format('select count(*) from public.wallets where id = %L', v_other_wallet),
    'user A cannot see user B''s wallet',
    0);

  perform pg_temp.rls_count(
    v_other,
    format('select count(*) from public.transactions where wallet_id = %L', v_cash),
    'user B cannot see user A''s transactions',
    0);

  -- Writing into somebody else's wallet ------------------------------------
  -- These come back as 23503, not the 42501 you would expect from an RLS
  -- violation: BEFORE ROW triggers run before the policy's WITH CHECK, and
  -- `tg_transactions_assert_owner` looks the wallet up — a lookup RLS scopes to
  -- the caller, so it resolves to NULL and the trigger refuses first. Either
  -- layer stopping it is fine; the trigger just gets there sooner.
  perform pg_temp.rls_denies(
    'authenticated',
    v_user,
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date)
              values (%L, %L, 'INCOME', 10, 'Forged', now())$q$, v_other_wallet, v_other),
    'user A cannot insert a transaction into user B''s wallet',
    '23503');

  perform pg_temp.rls_denies(
    'authenticated',
    v_user,
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date)
              values (%L, %L, 'INCOME', 10, 'Forged', now())$q$, v_other_wallet, v_user),
    'user A cannot claim user B''s wallet by writing their own user_id',
    '23503');

  -- RLS filters rather than errors on UPDATE/DELETE: a hidden row is simply
  -- not there, so the statement succeeds having matched nothing.
  perform pg_temp.rls_allows(
    v_user,
    format($q$update public.wallets set name = 'Renamed' where id = %L$q$, v_cash),
    'user A can rename their own wallet',
    1);

  perform pg_temp.rls_allows(
    v_user,
    format($q$update public.wallets set name = 'Stolen' where id = %L$q$, v_other_wallet),
    'user A cannot rename user B''s wallet',
    0);

  perform pg_temp.rls_allows(
    v_user,
    format($q$delete from public.wallets where id = %L$q$, v_other_wallet),
    'user A cannot delete user B''s wallet',
    0);

  perform pg_temp.check(
    (select name from public.wallets where id = v_other_wallet) = 'Cash',
    'user B''s wallet is untouched by user A''s attempts',
    (select name from public.wallets where id = v_other_wallet));

  -- The derived column -----------------------------------------------------
  -- `wallets_update_own` permits UPDATE on every column of your own row, and
  -- `balance` is one of them. The service layer never sends it, but that is a
  -- client-side convention — anything talking to PostgREST directly can set it,
  -- and then the balance disagrees with the ledger forever.
  perform pg_temp.rls_denies(
    'authenticated',
    v_user,
    format($q$update public.wallets set balance = 999999 where id = %L$q$, v_cash),
    'a client cannot write wallets.balance directly',
    '23514');

  perform pg_temp.check(
    pg_temp.balance(v_cash) = 1000,
    'the attempted balance write changed nothing',
    format('cash = %s (expected 1000)', pg_temp.balance(v_cash)));

  -- ...and the legitimate path still works, so the guard has not broken the
  -- trigger it exists to protect.
  perform pg_temp.rls_allows(
    v_user,
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date)
              values (%L, %L, %L, 'INCOME', 100, 'Guard check', now())$q$,
           v_t8, v_cash, v_user),
    'a client can still record a real transaction',
    1);

  perform pg_temp.check(
    pg_temp.balance(v_cash) = 1100,
    'the ledger trigger still moves the balance with the guard in place',
    format('cash = %s (expected 1100)', pg_temp.balance(v_cash)));

  -- anon -------------------------------------------------------------------
  perform pg_temp.rls_denies(
    'anon',
    null,
    'select count(*) from public.wallets',
    'anon cannot read wallets at all',
    '42501');

  perform pg_temp.rls_denies(
    'anon',
    null,
    'select count(*) from public.transactions',
    'anon cannot read transactions at all',
    '42501');

end
$main$;


-- ---------------------------------------------------------------------------
-- 1b. Accounts Payable / Receivable (0005_debts.sql)
--
--     The settlement guard is the whole reason this migration exists: it is the
--     only place that can stop a client posting an INCOME against a payable —
--     which would conjure money out of a debt you still owe — or settling the
--     same 50,000 three times over. RLS cannot express either rule, so every
--     one of them is driven for real below.
--
--     A separate block from `$main$` so the debt fixtures stay self-contained;
--     `_assert_results` and the `pg_temp` helpers are session-scoped, so the
--     report still collects everything in one place.
-- ---------------------------------------------------------------------------
do $debts$
declare
  v_u1 uuid := '30000000-0000-4000-8000-000000000001';
  v_u2 uuid := '30000000-0000-4000-8000-000000000002';

  -- Both created by the `handle_new_user` signup trigger.
  v_cash  uuid;
  v_cash2 uuid;
  v_thb_wallet uuid := '11000000-0000-4000-8000-000000000001';

  -- u1's obligations.
  v_recv   uuid := '40000000-0000-4000-8000-000000000001';  -- overdue receivable
  v_pay    uuid := '40000000-0000-4000-8000-000000000002';
  v_thb_d  uuid := '40000000-0000-4000-8000-000000000003';
  v_closed uuid := '40000000-0000-4000-8000-000000000004';
  v_del    uuid := '40000000-0000-4000-8000-000000000006';

  -- u2's obligation — must stay invisible to u1 and vice versa.
  v_other  uuid := '40000000-0000-4000-8000-000000000007';

  -- Settlement ledger rows.
  v_s1 uuid := '00000000-0000-4000-8000-000000000101';
  v_s2 uuid := '00000000-0000-4000-8000-000000000102';
  v_s3 uuid := '00000000-0000-4000-8000-000000000103';
  v_s4 uuid := '00000000-0000-4000-8000-000000000104';
  v_s5 uuid := '00000000-0000-4000-8000-000000000105';

  v_row record;
begin
  perform pg_temp.make_user(v_u1);
  perform pg_temp.make_user(v_u2);

  select w.id into v_cash  from public.wallets w where w.user_id = v_u1 and w.name = 'Cash';
  select w.id into v_cash2 from public.wallets w where w.user_id = v_u2 and w.name = 'Cash';

  -- ═════════════════════════════════════════════════════════════════════════
  -- A. Structure
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.check(
    (select relrowsecurity from pg_class where oid = 'public.debts'::regclass),
    'RLS is enabled on public.debts');

  perform pg_temp.check(
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'debts') = 4,
    'debts has exactly 4 policies (select/insert/update/delete)',
    format('found %s', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'debts')));

  if exists (select 1 from pg_roles where rolname = 'anon') then
    perform pg_temp.check(
      not has_table_privilege('anon', 'public.debts', 'select')
      and not has_table_privilege('anon', 'public.debts', 'insert'),
      'anon holds no privileges on public.debts');
  end if;

  perform pg_temp.check(
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions'
               and column_name = 'debt_id'),
    'transactions.debt_id exists');

  -- A view without `security_invoker` runs as its owner and bypasses the RLS
  -- underneath it — which would publish every user''s debts to every user.
  perform pg_temp.check(
    coalesce((select array_to_string(c.reloptions, ',') from pg_class c
               where c.oid = 'public.debt_balances'::regclass), '') like '%security_invoker=true%',
    'debt_balances is a security_invoker view, so RLS applies to the caller',
    coalesce((select array_to_string(c.reloptions, ',') from pg_class c
               where c.oid = 'public.debt_balances'::regclass), '(no reloptions)'));

  perform pg_temp.check(
    exists (select 1 from pg_constraint c
             join pg_class t on t.oid = c.conrelid
            where c.conname = 'transactions_debt_or_transfer' and t.relname = 'transactions'),
    'a ledger row cannot be both a transfer leg and a debt settlement');

  -- ═════════════════════════════════════════════════════════════════════════
  -- B. Recording a debt moves no money
  -- ═════════════════════════════════════════════════════════════════════════
  -- `issued_on` is passed explicitly: it defaults to `current_date`, and
  -- `debts_due_after_issue` requires `due_on >= issued_on`, so back-dating only
  -- `due_on` would violate the constraint this fixture is meant to sit under.
  perform pg_temp.run(
    format($q$insert into public.debts (id, user_id, direction, counterparty, currency, principal, issued_on, due_on)
              values (%L, %L, 'RECEIVABLE', 'Ko Aung', 'MMK', 50000, current_date - 20, current_date - 10)$q$,
           v_recv, v_u1),
    'INSERT receivable 50,000 from Ko Aung, 10 days overdue');

  perform pg_temp.run(
    format($q$insert into public.debts (id, user_id, direction, counterparty, currency, principal, due_on)
              values (%L, %L, 'PAYABLE', 'Daw Hla', 'MMK', 30000, current_date + 10)$q$,
           v_pay, v_u1),
    'INSERT payable 30,000 to Daw Hla');

  perform pg_temp.run(
    format($q$insert into public.debts (id, user_id, direction, counterparty, currency, principal)
              values (%L, %L, 'RECEIVABLE', 'Nok', 'THB', 1000)$q$, v_thb_d, v_u1),
    'INSERT receivable 1,000 THB from Nok');

  perform pg_temp.run(
    format($q$insert into public.debts (id, user_id, direction, counterparty, currency, principal, closed_at)
              values (%L, %L, 'PAYABLE', 'Shop', 'MMK', 5000, now())$q$, v_closed, v_u1),
    'INSERT an already-closed payable');

  perform pg_temp.run(
    format($q$insert into public.debts (id, user_id, direction, counterparty, currency, principal)
              values (%L, %L, 'RECEIVABLE', 'Ko Zaw', 'MMK', 4000)$q$, v_del, v_u1),
    'INSERT receivable 4,000 from Ko Zaw');

  perform pg_temp.run(
    format($q$insert into public.debts (id, user_id, direction, counterparty, currency, principal)
              values (%L, %L, 'RECEIVABLE', 'Someone Else', 'MMK', 99000)$q$, v_other, v_u2),
    'INSERT a receivable belonging to the other user');

  perform pg_temp.check(pg_temp.balance(v_cash) = 0,
    'recording a debt does not touch any wallet balance',
    format('cash = %s (expected 0)', pg_temp.balance(v_cash)));

  perform pg_temp.check(
    (select outstanding = 50000 and settled = 0 from public.debt_balances where id = v_recv),
    'a fresh debt reports settled = 0 and outstanding = principal',
    (select format('settled = %s, outstanding = %s', settled, outstanding)
       from public.debt_balances where id = v_recv));

  perform pg_temp.check(
    (select count(*) from public.debt_balances where id = v_recv) = 1,
    'debt_balances exposes the debt through the view');

  -- ═════════════════════════════════════════════════════════════════════════
  -- C. A settlement must match the direction of the debt
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, 'INCOME', 1000, 'Debt collection', now(), %L)$q$,
           v_cash, v_u1, v_pay),
    'an INCOME cannot settle a payable — that would invent money',
    '23514', 'but the row given was INCOME');

  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, 'EXPENSE', 1000, 'Debt payment', now(), %L)$q$,
           v_cash, v_u1, v_recv),
    'an EXPENSE cannot settle a receivable',
    '23514', 'but the row given was EXPENSE');

  -- ═════════════════════════════════════════════════════════════════════════
  -- D. A settlement is real money, and moves exactly once
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, %L, 'INCOME', 20000, 'Debt collection', now(), %L)$q$,
           v_s1, v_cash, v_u1, v_recv),
    'INSERT a 20,000 part-settlement of the receivable');

  perform pg_temp.check(pg_temp.balance(v_cash) = 20000,
    'settling a receivable raises the wallet balance by the settlement',
    format('cash = %s (expected 20000)', pg_temp.balance(v_cash)));

  perform pg_temp.check(
    (select settled = 20000 and outstanding = 30000 from public.debt_balances where id = v_recv),
    'a part-settlement moves settled and outstanding by the same amount',
    (select format('settled = %s, outstanding = %s', settled, outstanding)
       from public.debt_balances where id = v_recv));

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, %L, 'INCOME', 30000, 'Debt collection', now(), %L)$q$,
           v_s2, v_cash, v_u1, v_recv),
    'INSERT the remaining 30,000');

  perform pg_temp.check(pg_temp.balance(v_cash) = 50000,
    'the final instalment lands the balance exactly on the principal',
    format('cash = %s (expected 50000)', pg_temp.balance(v_cash)));

  perform pg_temp.check(
    (select outstanding = 0 and settled = 50000 from public.debt_balances where id = v_recv),
    'a fully settled debt reports outstanding = 0',
    (select format('settled = %s, outstanding = %s', settled, outstanding)
       from public.debt_balances where id = v_recv));

  -- ═════════════════════════════════════════════════════════════════════════
  -- E. Overpayment is refused
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, 'EXPENSE', 30001, 'Debt payment', now(), %L)$q$,
           v_cash, v_u1, v_pay),
    'paying more than the debt is refused',
    '23514', 'is still outstanding');

  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, 'INCOME', 1, 'Debt collection', now(), %L)$q$,
           v_cash, v_u1, v_recv),
    'settling an already-settled debt is refused',
    '23514', 'is still outstanding');

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, %L, 'EXPENSE', 10000, 'Debt payment', now(), %L)$q$,
           v_s3, v_cash, v_u1, v_pay),
    'INSERT a legitimate 10,000 part-payment of the payable');

  perform pg_temp.check(
    (select outstanding = 20000 from public.debt_balances where id = v_pay)
      and pg_temp.balance(v_cash) = 40000,
    'settling a payable lowers the wallet balance and the outstanding alike',
    format('cash = %s, outstanding = %s', pg_temp.balance(v_cash),
           (select outstanding from public.debt_balances where id = v_pay)));

  -- ═════════════════════════════════════════════════════════════════════════
  -- F. Cross-currency settlement is refused, not assumed 1:1
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, 'INCOME', 1000, 'Debt collection', now(), %L)$q$,
           v_cash, v_u1, v_thb_d),
    'a THB debt cannot be settled from an MMK wallet',
    '23514', 'cross-currency settlement');

  -- Positive control: the guard refuses the wrong currency, not every currency.
  perform pg_temp.run(
    format($q$insert into public.wallets (id, user_id, name, currency, balance)
              values (%L, %L, 'Thai', 'THB', 0)$q$, v_thb_wallet, v_u1),
    'CREATE a THB wallet for the positive control');

  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, %L, 'INCOME', 1000, 'Debt collection', now(), %L)$q$,
           v_s4, v_thb_wallet, v_u1, v_thb_d),
    'SETTLE the THB debt from the THB wallet');

  perform pg_temp.check(pg_temp.balance(v_thb_wallet) = 1000,
    'the same settlement succeeds once the currency matches',
    format('thb = %s (expected 1000)', pg_temp.balance(v_thb_wallet)));

  -- ═════════════════════════════════════════════════════════════════════════
  -- G. A closed debt accepts nothing further
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, 'EXPENSE', 100, 'Debt payment', now(), %L)$q$,
           v_cash, v_u1, v_closed),
    'a closed debt cannot be settled again',
    '23514', 'already closed');

  -- ═════════════════════════════════════════════════════════════════════════
  -- H. Deleting a settlement undoes both sides
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$delete from public.transactions where id = %L$q$, v_s1),
    'DELETE the 20,000 part-settlement');

  perform pg_temp.check(pg_temp.balance(v_cash) = 20000,
    'deleting a settlement reverses the balance it moved',
    format('cash = %s (expected 20000)', pg_temp.balance(v_cash)));

  -- v_recv is back to 20,000 outstanding: the 50,000 principal less the
  -- 30,000 that is still settled.
  perform pg_temp.check(
    (select outstanding = 20000 from public.debt_balances where id = v_recv),
    'deleting a settlement restores the outstanding figure',
    (select format('outstanding = %s (expected 20000)', outstanding)
       from public.debt_balances where id = v_recv));

  -- ═════════════════════════════════════════════════════════════════════════
  -- I. Deleting a debt keeps the money it moved on the ledger
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.run(
    format($q$insert into public.transactions (id, wallet_id, user_id, type, amount, category, date, debt_id)
              values (%L, %L, %L, 'INCOME', 4000, 'Debt collection', now(), %L)$q$,
           v_s5, v_cash, v_u1, v_del),
    'SETTLE the 4,000 receivable in full');

  perform pg_temp.run(
    format($q$delete from public.debts where id = %L$q$, v_del),
    'DELETE the debt record');

  perform pg_temp.check(
    (select debt_id is null from public.transactions where id = v_s5),
    'deleting a debt unlinks its settlements instead of erasing them',
    format('debt_id = %s (expected null)',
           (select coalesce(debt_id::text, 'null') from public.transactions where id = v_s5)));

  perform pg_temp.check(pg_temp.balance(v_cash) = 24000,
    'the money the deleted debt moved stays moved',
    format('cash = %s (expected 24000)', pg_temp.balance(v_cash)));

  -- ═════════════════════════════════════════════════════════════════════════
  -- J. A debt cannot be edited out from under its settlements
  --    (v_pay carries a 10,000 settlement by this point.)
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$update public.debts set principal = 5000 where id = %L$q$, v_pay),
    'the principal cannot be lowered below what is already settled',
    '23514', 'cannot be lowered');

  perform pg_temp.expect_error(
    format($q$update public.debts set direction = 'RECEIVABLE' where id = %L$q$, v_pay),
    'a settled debt cannot change direction',
    '23514', 'direction cannot change');

  perform pg_temp.expect_error(
    format($q$update public.debts set currency = 'THB' where id = %L$q$, v_pay),
    'a settled debt cannot change currency',
    '23514', 'currency cannot change');

  -- Positive control: the guard is about money, not about editing.
  perform pg_temp.run(
    format($q$update public.debts set counterparty = 'Daw Hla (shop)', note = 'rice' where id = %L$q$, v_pay),
    'RENAME a settled debt and add a note');

  perform pg_temp.check(
    (select counterparty = 'Daw Hla (shop)' and note = 'rice' from public.debts where id = v_pay),
    'renaming and annotating a settled debt is still allowed',
    (select format('counterparty = %s, note = %s', counterparty, note)
       from public.debts where id = v_pay));

  perform pg_temp.check(
    (select principal = 30000 from public.debts where id = v_pay),
    'a refused principal edit left the stored value untouched',
    (select format('principal = %s (expected 30000)', principal) from public.debts where id = v_pay));

  -- ═════════════════════════════════════════════════════════════════════════
  -- K. A ledger row cannot be both a transfer leg and a settlement
  --    (EXPENSE against the payable so the direction guard passes and the
  --    CHECK constraint is the only thing that can reject this row.)
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.expect_error(
    format($q$insert into public.transactions (wallet_id, user_id, type, amount, category, date, debt_id, transfer_group_id)
              values (%L, %L, 'EXPENSE', 100, 'Transfer', now(), %L, gen_random_uuid())$q$,
           v_cash, v_u1, v_pay),
    'a row cannot be both a transfer leg and a debt settlement',
    '23514', 'transactions_debt_or_transfer');

  -- ═════════════════════════════════════════════════════════════════════════
  -- L. RLS keeps one user''s debts out of another''s reach
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.rls_count(
    v_u2,
    $q$select count(*) from public.debts where counterparty = 'Ko Aung'$q$,
    'another user cannot see my debts at all',
    0);

  perform pg_temp.rls_count(
    v_u2,
    $q$select count(*) from public.debt_balances where counterparty = 'Ko Aung'$q$,
    'the debt_balances view does not leak across users',
    0);

  perform pg_temp.rls_count(
    v_u2,
    $q$select count(*) from public.debts$q$,
    'another user sees only their own debt',
    1);

  perform pg_temp.rls_allows(
    v_u2,
    format($q$delete from public.debts where id = %L$q$, v_pay),
    'another user cannot delete my debt',
    0);

  perform pg_temp.rls_denies(
    'anon',
    null,
    'select count(*) from public.debts',
    'anon cannot read debts at all',
    '42501');

  -- ═════════════════════════════════════════════════════════════════════════
  -- M. get_debt_totals — grouped by currency, split by direction
  --
  --    u1 at this point: MMK receivable 20,000 (Ko Aung, 10 days overdue),
  --    MMK payable 20,000 (Daw Hla, due in 10 days). The THB receivable is
  --    fully settled, the 5,000 payable is closed, and Ko Zaw's debt is gone —
  --    all three must be absent from the totals.
  -- ═════════════════════════════════════════════════════════════════════════
  perform pg_temp.rls_count(
    v_u1,
    $q$select coalesce((select receivable_outstanding from public.get_debt_totals() where currency = 'MMK'), -1)::int$q$,
    'get_debt_totals sums open MMK receivables',
    20000);

  perform pg_temp.rls_count(
    v_u1,
    $q$select coalesce((select payable_outstanding from public.get_debt_totals() where currency = 'MMK'), -1)::int$q$,
    'get_debt_totals sums open MMK payables',
    20000);

  perform pg_temp.rls_count(
    v_u1,
    $q$select coalesce((select receivable_overdue from public.get_debt_totals() where currency = 'MMK'), -1)::int$q$,
    'an open debt past its due date is reported as overdue',
    20000);

  perform pg_temp.rls_count(
    v_u1,
    $q$select coalesce((select payable_overdue from public.get_debt_totals() where currency = 'MMK'), -1)::int$q$,
    'a payable that is not yet due is not overdue',
    0);

  perform pg_temp.rls_count(
    v_u1,
    $q$select count(*) from public.get_debt_totals()$q$,
    'a fully settled currency drops out of the totals entirely',
    1);

  perform pg_temp.rls_count(
    v_u2,
    $q$select coalesce(sum(receivable_outstanding), -1)::int from public.get_debt_totals()$q$,
    'get_debt_totals is scoped to the caller',
    99000);

end
$debts$;


-- ---------------------------------------------------------------------------
-- 2. Report
-- ---------------------------------------------------------------------------
select n, result, label, observed
  from _assert_results
 order by n;

select
  count(*) filter (where result in ('PASS', 'FAIL')) as assertions,
  count(*) filter (where result = 'PASS')            as passed,
  count(*) filter (where result = 'FAIL')            as failed,
  count(*) filter (where result = 'SETUP')           as setup_steps,
  case
    when count(*) filter (where result = 'FAIL') = 0
      then 'ALL CHECKS PASSED'
    else 'FAILURES PRESENT — see the rows marked FAIL above'
  end                                                as verdict
  from _assert_results;

-- Nothing above is kept.
rollback;
