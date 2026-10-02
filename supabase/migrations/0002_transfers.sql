-- ============================================================================
--  Personal Wallet — wallet-to-wallet transfers
--  Target : Supabase (PostgreSQL 15+)
--  Usage  : Run AFTER 0001_init.sql. Safe to re-run (idempotent).
--
--  Why this needs its own migration
--  --------------------------------
--  A transfer is two ledger rows that must both exist or neither. Recording it
--  as two independent client inserts can half-fail: the money leaves one wallet
--  and never arrives in the other, with no error to show for it. So the pair is
--  written inside a single function call — one transaction, one outcome.
--
--  Both legs carry the same `transfer_group_id`, which is what lets the app
--  treat them as one unit (and hide the "edit" action for them).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Link column
-- ---------------------------------------------------------------------------
alter table public.transactions
  add column if not exists transfer_group_id uuid;

comment on column public.transactions.transfer_group_id is
  'Non-null when this row is one leg of a wallet-to-wallet transfer. Both legs share the value.';

-- Partial index: transfers are a minority of rows, so keep the index small.
create index if not exists transactions_transfer_group_idx
  on public.transactions (transfer_group_id)
  where transfer_group_id is not null;


-- ---------------------------------------------------------------------------
-- 2. A transfer is edited as a unit, never leg by leg
--    Changing one leg would leave the pair unbalanced, and the balances with
--    it. The client must delete the transfer and record a new one.
-- ---------------------------------------------------------------------------
create or replace function public.tg_transactions_block_transfer_leg_edit()
returns trigger
language plpgsql
as $$
begin
  if old.transfer_group_id is not null then
    raise exception
      'This row is one leg of a transfer. Delete the transfer and record a new one instead of editing it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_block_transfer_leg_edit on public.transactions;
create trigger transactions_block_transfer_leg_edit
  before update on public.transactions
  for each row execute function public.tg_transactions_block_transfer_leg_edit();


-- ---------------------------------------------------------------------------
-- 3. Deleting either leg deletes the whole transfer
--    The sibling delete re-enters this trigger, so a transaction-local flag
--    stops the recursion. Each sibling still fires the balance trigger, so the
--    two wallets are put back exactly where they started.
-- ---------------------------------------------------------------------------
create or replace function public.tg_transactions_cascade_transfer_delete()
returns trigger
language plpgsql
as $$
begin
  if old.transfer_group_id is null then
    return old;
  end if;

  -- Already cascading from the other leg — let this row go quietly.
  if coalesce(current_setting('wallet.transfer_cascade', true), 'off') = 'on' then
    return old;
  end if;

  perform set_config('wallet.transfer_cascade', 'on', true);

  delete from public.transactions
   where transfer_group_id = old.transfer_group_id
     and id <> old.id;

  perform set_config('wallet.transfer_cascade', 'off', true);

  return old;
end;
$$;

drop trigger if exists transactions_cascade_transfer_delete on public.transactions;
create trigger transactions_cascade_transfer_delete
  before delete on public.transactions
  for each row execute function public.tg_transactions_cascade_transfer_delete();


-- ---------------------------------------------------------------------------
-- 4. The transfer itself
-- ---------------------------------------------------------------------------
create or replace function public.transfer_between_wallets(
  p_from_wallet_id uuid,
  p_to_wallet_id   uuid,
  p_amount         numeric,
  p_note           text        default null,
  p_date           timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id       uuid := auth.uid();
  v_group         uuid := gen_random_uuid();
  v_from_currency text;
  v_to_currency   text;
  v_when          timestamptz := coalesce(p_date, now());
begin
  if v_user_id is null then
    raise exception 'You must be signed in to transfer between wallets.'
      using errcode = '42501';
  end if;

  if p_from_wallet_id is null or p_to_wallet_id is null then
    raise exception 'Both wallets are required.' using errcode = 'check_violation';
  end if;

  if p_from_wallet_id = p_to_wallet_id then
    raise exception 'Choose two different wallets.' using errcode = 'check_violation';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'The transfer amount must be greater than zero.'
      using errcode = 'check_violation';
  end if;

  -- RLS already scopes these lookups to auth.uid(); the explicit predicate
  -- just makes the intent readable.
  select w.currency into v_from_currency
    from public.wallets w
   where w.id = p_from_wallet_id and w.user_id = v_user_id;

  if v_from_currency is null then
    raise exception 'Source wallet not found.' using errcode = 'no_data_found';
  end if;

  select w.currency into v_to_currency
    from public.wallets w
   where w.id = p_to_wallet_id and w.user_id = v_user_id;

  if v_to_currency is null then
    raise exception 'Destination wallet not found.' using errcode = 'no_data_found';
  end if;

  -- Converting between currencies needs an exchange rate. Assuming 1:1 would
  -- quietly invent money, so refuse instead.
  if v_from_currency <> v_to_currency then
    raise exception
      'Cannot transfer between % and % — cross-currency transfers need an exchange rate, which this app does not model yet.',
      v_from_currency, v_to_currency
      using errcode = 'check_violation';
  end if;

  -- Both rows land together. The balance trigger applies -amount to the source
  -- and +amount to the destination in the same transaction.
  insert into public.transactions
    (wallet_id, user_id, type, amount, category, note, date, transfer_group_id)
  values
    (p_from_wallet_id, v_user_id, 'EXPENSE', p_amount, 'Transfer', p_note, v_when, v_group),
    (p_to_wallet_id,   v_user_id, 'INCOME',  p_amount, 'Transfer', p_note, v_when, v_group);

  return v_group;
end;
$$;

grant execute on function public.transfer_between_wallets(uuid, uuid, numeric, text, timestamptz)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Transfers are neither income nor expense
--
--    Without this, moving 50,000 MMK from Cash to Bank would show up as
--    50,000 of income *and* 50,000 of expense, and the month would look twice
--    as busy as it was. They are reported separately as `transfer_volume`.
--
--    NOTE: this rewrite adds an output column, which changes the function's
--    return type. `create or replace` refuses to do that ("cannot change return
--    type of existing function"), so the 0001 version has to be dropped first.
--    Dropping takes the EXECUTE grant with it, which is why the grant is
--    re-issued below.
-- ---------------------------------------------------------------------------
drop function if exists public.get_monthly_summary(uuid, date);

create or replace function public.get_monthly_summary(
  p_wallet_id uuid default null,
  p_month     date default null
)
returns table (
  income            numeric,
  expense           numeric,
  net               numeric,
  transaction_count bigint,
  transfer_volume   numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', coalesce(p_month, current_date))                        as start_at,
      date_trunc('month', coalesce(p_month, current_date)) + interval '1 month'   as end_at
  ),
  scoped as (
    select t.*
      from public.transactions t
      cross join bounds b
     where t.user_id = auth.uid()
       and t.date >= b.start_at
       and t.date <  b.end_at
       and (p_wallet_id is null or t.wallet_id = p_wallet_id)
  )
  select
    -- Only real income counts. Transfer legs are excluded on purpose.
    coalesce(sum(case when transfer_group_id is null and type = 'INCOME'  then amount else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when transfer_group_id is null and type = 'EXPENSE' then amount else 0 end), 0)::numeric(18, 2),
    coalesce(sum(case when transfer_group_id is null and type = 'INCOME'  then amount
                      when transfer_group_id is null and type = 'EXPENSE' then -amount
                      else 0 end), 0)::numeric(18, 2),
    -- Every ledger row in range, transfers included.
    count(*)::bigint,
    -- Money that left this wallet by transfer. For the all-wallets view this is
    -- the total moved, because each transfer contributes exactly one EXPENSE leg.
    coalesce(sum(case when transfer_group_id is not null and type = 'EXPENSE' then amount else 0 end), 0)::numeric(18, 2)
  from scoped;
$$;

grant execute on function public.get_monthly_summary(uuid, date) to authenticated;


notify pgrst, 'reload schema';
