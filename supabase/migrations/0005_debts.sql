-- ============================================================================
--  sara-wallet — Accounts Payable / Accounts Receivable
--  Target : Supabase (PostgreSQL 15+)
--  Usage  : Run AFTER 0004_guard_balance_writes.sql. Safe to re-run.
--
--  ── The model ─────────────────────────────────────────────────────────────
--  A debt is an *obligation*, not a cash movement. When a friend lends you
--  50,000 MMK, nothing has left or entered any wallet — so recording the debt
--  writes no ledger row and moves no balance. Treating it as income would
--  invent money that is not in your pocket.
--
--  Settling one *is* a cash movement, so it *is* a ledger row: an INCOME for a
--  receivable (they paid you) and an EXPENSE for a payable (you paid them).
--  `transactions.debt_id` links that row back to the debt.
--
--  There is deliberately no separate `settlements` table. A settlement row plus
--  a transaction would be two records of one event, and the two would drift.
--  One row, one truth.
--
--  Outstanding is therefore **derived, never stored**:
--
--      outstanding = principal - sum(settlements)
--
--  exposed by the `debt_balances` view. A stored column would be a second
--  source of truth for the same fact, and `wallets.balance` already showed
--  where that leads — see the guard in 0004.
--
--  ── Direction ─────────────────────────────────────────────────────────────
--    RECEIVABLE  somebody owes the user  → settled by an INCOME  (money in)
--    PAYABLE     the user owes somebody  → settled by an EXPENSE (money out)
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Direction enum
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'debt_direction' and n.nspname = 'public'
  ) then
    create type public.debt_direction as enum ('RECEIVABLE', 'PAYABLE');
  end if;
end
$$;

comment on type public.debt_direction is
  'RECEIVABLE: somebody owes the user. PAYABLE: the user owes somebody.';


-- ---------------------------------------------------------------------------
-- 2. debts
-- ---------------------------------------------------------------------------
create table if not exists public.debts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  direction    public.debt_direction not null,
  counterparty text        not null,
  currency     text        not null default 'MMK',
  principal    numeric(18, 2) not null,
  note         text,
  issued_on    date        not null default current_date,
  due_on       date,
  -- Set when a debt is retired without being paid in full — a write-off, or a
  -- negotiated "let's call it even". NULL means the debt is still open, and
  -- `outstanding` is what decides whether it is finished.
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint debts_counterparty_length
    check (char_length(btrim(counterparty)) between 1 and 80),
  constraint debts_currency_iso
    check (currency ~ '^[A-Z]{3}$'),
  constraint debts_principal_positive
    check (principal > 0),
  constraint debts_note_length
    check (note is null or char_length(note) <= 500),
  -- A due date before the issue date is a typo, not a business case.
  constraint debts_due_after_issue
    check (due_on is null or due_on >= issued_on)
);

comment on table  public.debts            is 'A money obligation: either somebody owes the user (RECEIVABLE) or the user owes somebody (PAYABLE).';
comment on column public.debts.principal  is 'The original amount owed. Never changes as settlements land — outstanding is derived.';
comment on column public.debts.closed_at  is 'Set when the debt is retired without being paid in full. NULL while it is open.';
comment on column public.debts.due_on     is 'Optional. A past due date on an open debt is what the UI shows as overdue.';


-- ---------------------------------------------------------------------------
-- 3. Link settlements to the debt they settle
--
--    `on delete set null`, not `cascade`: the settlement was a real movement of
--    real money, so deleting the debt record must not erase it from the ledger.
--    The row survives as an ordinary transaction.
-- ---------------------------------------------------------------------------
alter table public.transactions
  add column if not exists debt_id uuid references public.debts (id) on delete set null;

comment on column public.transactions.debt_id is
  'Non-null when this row settles a debt. INCOME settles a RECEIVABLE, EXPENSE settles a PAYABLE.';

-- A row cannot be both one leg of a transfer and a debt settlement.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.conname = 'transactions_debt_or_transfer'
      and t.relname = 'transactions'
      and n.nspname = 'public'
  ) then
    alter table public.transactions
      add constraint transactions_debt_or_transfer
      check (debt_id is null or transfer_group_id is null);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
create index if not exists debts_user_id_idx
  on public.debts (user_id);

create index if not exists debts_user_direction_idx
  on public.debts (user_id, direction);

-- Open debts with a due date are what the "overdue" badge scans for.
create index if not exists debts_open_due_idx
  on public.debts (user_id, due_on)
  where closed_at is null;

-- Partial: settlements are a minority of ledger rows.
create index if not exists transactions_debt_id_idx
  on public.transactions (debt_id)
  where debt_id is not null;


-- ---------------------------------------------------------------------------
-- 5. updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists debts_set_updated_at on public.debts;
create trigger debts_set_updated_at
  before update on public.debts
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 6. A settlement must actually match the debt it settles
--
--    Same lesson as 0004: RLS cannot express "this column must agree with that
--    row". The `transactions_insert_own` policy checks that the *wallet* is
--    yours; nothing stops a client posting an INCOME against a payable — which
--    invents money out of a debt you still owe — or settling a 1,000 debt
--    three times over. That rule can only live in a trigger.
-- ---------------------------------------------------------------------------
create or replace function public.tg_transactions_validate_debt_link()
returns trigger
language plpgsql
as $$
declare
  -- `%type` rather than a spelled-out type: these track the columns they come
  -- from, so a later widening of `principal` cannot leave this function
  -- silently truncating.
  v_direction       public.debts.direction%type;
  v_currency        public.debts.currency%type;
  v_principal       public.debts.principal%type;
  v_closed_at       public.debts.closed_at%type;
  v_wallet_currency public.wallets.currency%type;
  v_expected        public.transactions.type%type;
  v_paid            public.transactions.amount%type;
begin
  if new.debt_id is null then
    return new;
  end if;

  -- `for update` serialises concurrent settlements of the same debt. Without
  -- it two inserts can both read "500 outstanding" and both pass the
  -- overpayment check below, leaving the debt over-paid.
  --
  -- RLS applies to this lookup, so a debt belonging to somebody else simply
  -- resolves to NULL and the write is refused.
  select d.direction, d.currency, d.principal, d.closed_at
    into v_direction, v_currency, v_principal, v_closed_at
    from public.debts d
   where d.id = new.debt_id
     for update;

  if v_direction is null then
    raise exception 'Debt % does not exist or is not owned by the current user.', new.debt_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_closed_at is not null then
    raise exception 'That debt is already closed.'
      using errcode = 'check_violation';
  end if;

  -- They owe you → you receive. You owe them → you pay. Anything else would
  -- make the ledger disagree with the obligation.
  v_expected := case when v_direction = 'RECEIVABLE' then 'INCOME' else 'EXPENSE' end;

  if new.type <> v_expected then
    -- Phrased so the ledger type always follows "of type": "a INCOME row" is
    -- what a bare article before `new.type` produces, and `new.type` is an enum
    -- whose members all begin with a vowel.
    raise exception
      'A % must be settled with a ledger row of type %, but the row given was %.',
      case when v_direction = 'RECEIVABLE' then 'receivable' else 'payable' end,
      v_expected,
      new.type
      using errcode = 'check_violation';
  end if;

  -- `transactions` carries no currency of its own — it is the wallet's. Settling
  -- a THB debt from an MMK wallet would need an exchange rate, which this app
  -- does not model, so it is refused rather than assumed 1:1.
  select w.currency into v_wallet_currency
    from public.wallets w
   where w.id = new.wallet_id;

  if v_wallet_currency is distinct from v_currency then
    raise exception
      'This debt is in %. Settle it from a % wallet — cross-currency settlement needs an exchange rate.',
      v_currency, v_currency
      using errcode = 'check_violation';
  end if;

  -- Everything already posted against this debt, excluding the row being
  -- written (a no-op on INSERT, where new.id is brand new).
  select coalesce(sum(t.amount), 0) into v_paid
    from public.transactions t
   where t.debt_id = new.debt_id
     and t.id <> new.id;

  if v_paid + new.amount > v_principal then
    raise exception
      'That would settle % of a % debt. % is still outstanding.',
      v_paid + new.amount, v_principal, v_principal - v_paid
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists transactions_validate_debt_link on public.transactions;
create trigger transactions_validate_debt_link
  before insert or update of debt_id, amount, type, wallet_id on public.transactions
  for each row execute function public.tg_transactions_validate_debt_link();


-- ---------------------------------------------------------------------------
-- 7. A debt cannot be edited out from under its settlements
--
--    Lowering the principal below what has already been paid, or re-denominating
--    the debt, would silently reinterpret money that has really moved.
-- ---------------------------------------------------------------------------
create or replace function public.tg_debts_guard_edits()
returns trigger
language plpgsql
as $$
declare
  v_paid numeric(18, 2);
begin
  -- The common case is a rename, a note edit or a due-date change. Skip the
  -- aggregate entirely for those.
  if new.principal  is not distinct from old.principal
     and new.currency is not distinct from old.currency
     and new.direction is not distinct from old.direction then
    return new;
  end if;

  select coalesce(sum(t.amount), 0) into v_paid
    from public.transactions t
   where t.debt_id = new.id;

  if v_paid > 0 and new.direction is distinct from old.direction then
    raise exception
      'This debt already has % settled against it, so its direction cannot change. Delete it and record a new one.',
      v_paid
      using errcode = 'check_violation';
  end if;

  if v_paid > 0 and new.currency is distinct from old.currency then
    raise exception
      'This debt already has % settled against it, so its currency cannot change. Delete it and record a new one.',
      v_paid
      using errcode = 'check_violation';
  end if;

  if new.principal < v_paid then
    raise exception
      '% has already been settled against this debt, so the principal cannot be lowered below that.',
      v_paid
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists debts_guard_edits on public.debts;
create trigger debts_guard_edits
  before update on public.debts
  for each row execute function public.tg_debts_guard_edits();


-- ---------------------------------------------------------------------------
-- 8. The read model
--
--    `security_invoker = true` is load-bearing. A view without it runs with the
--    *owner's* privileges and bypasses the RLS on the tables underneath, which
--    would hand every signed-in user everybody else's debts. With it, the
--    policies on `debts` and `transactions` apply as the caller.
--
--    Dropped and recreated rather than `create or replace`: the column list is
--    still moving, and `create or replace view` refuses to change it. The drop
--    takes the GRANT with it, so the grant is re-issued below.
-- ---------------------------------------------------------------------------
drop view if exists public.debt_balances;

create view public.debt_balances
with (security_invoker = true)
as
select
  d.id,
  d.user_id,
  d.direction,
  d.counterparty,
  d.currency,
  d.principal,
  d.note,
  d.issued_on,
  d.due_on,
  d.closed_at,
  d.created_at,
  d.updated_at,
  -- `filter` rather than a CASE so a debt with no settlements still reports 0
  -- instead of NULL.
  coalesce(sum(t.amount) filter (where t.id is not null), 0)::numeric(18, 2) as settled,
  greatest(d.principal - coalesce(sum(t.amount) filter (where t.id is not null), 0), 0)::numeric(18, 2)
    as outstanding
from public.debts d
left join public.transactions t on t.debt_id = d.id
-- `d.id` is the primary key, so every other `d.*` column is functionally
-- dependent on it and needs no aggregate of its own.
group by d.id;

comment on view public.debt_balances is
  'A debt with its derived `settled` and `outstanding` figures. The only read path for debts.';

grant select on public.debt_balances to authenticated;


-- ---------------------------------------------------------------------------
-- 9. AP / AR totals
--
--    Grouped by currency for the same reason `WalletTotals` is: adding 50,000
--    MMK to 50,000 THB produces a number that means nothing.
-- ---------------------------------------------------------------------------
create or replace function public.get_debt_totals()
returns table (
  currency               text,
  receivable_outstanding numeric,
  payable_outstanding    numeric,
  receivable_overdue     numeric,
  payable_overdue        numeric,
  open_count             bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    b.currency,
    coalesce(sum(case when b.direction = 'RECEIVABLE' then b.outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when b.direction = 'PAYABLE'    then b.outstanding else 0 end), 0)::numeric(18, 2),
    -- Overdue is a property of an open debt past its due date, not a separate
    -- record — so it is a filter over the same rows, never a stored flag.
    coalesce(sum(case when b.direction = 'RECEIVABLE' and b.due_on < current_date then b.outstanding else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when b.direction = 'PAYABLE'    and b.due_on < current_date then b.outstanding else 0 end), 0)::numeric(18, 2),
    count(*)::bigint
  from public.debt_balances b
  where b.closed_at is null
    and b.outstanding > 0
  group by b.currency
  order by b.currency;
$$;

grant execute on function public.get_debt_totals() to authenticated;


-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.debts enable row level security;

drop policy if exists "debts_select_own" on public.debts;
create policy "debts_select_own"
  on public.debts for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "debts_insert_own" on public.debts;
create policy "debts_insert_own"
  on public.debts for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "debts_update_own" on public.debts;
create policy "debts_update_own"
  on public.debts for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "debts_delete_own" on public.debts;
create policy "debts_delete_own"
  on public.debts for delete
  to authenticated
  using (auth.uid() = user_id);

-- RLS filters rows; GRANTs decide whether the role may touch the table at all.
-- `anon` gets nothing, here as everywhere else.
grant select, insert, update, delete on public.debts to authenticated;


-- ---------------------------------------------------------------------------
-- 11. Ask PostgREST to pick up the new shape immediately
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
