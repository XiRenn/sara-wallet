-- ============================================================================
--  Personal Wallet — schema, indexes, business logic and Row Level Security
--  Target : Supabase (PostgreSQL 15+)
--  Usage  : Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
--           or `supabase db push` if you use the Supabase CLI.
--  Note   : This script is idempotent. Running it twice is safe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
--    gen_random_uuid() is built into PostgreSQL 13+, but pgcrypto is created
--    here so the script also works on older Supabase projects.
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto" with schema extensions;


-- ---------------------------------------------------------------------------
-- 1. Enum types
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'transaction_type' and n.nspname = 'public'
  ) then
    create type public.transaction_type as enum ('INCOME', 'EXPENSE');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- 2.1 wallets ---------------------------------------------------------------
create table if not exists public.wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  name        text        not null,
  currency    text        not null default 'MMK',
  balance     numeric(18, 2) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint wallets_name_length  check (char_length(btrim(name)) between 1 and 80),
  constraint wallets_currency_iso check (currency ~ '^[A-Z]{3}$')
);

comment on table  public.wallets            is 'A single money container owned by one auth user.';
comment on column public.wallets.balance    is 'Derived from transactions. Maintained by tg_transactions_apply_balance — never write it from the client.';

-- 2.2 transactions ----------------------------------------------------------
create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  wallet_id   uuid        not null references public.wallets (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  type        public.transaction_type not null,
  amount      numeric(18, 2) not null,
  category    text        not null default 'General',
  note        text,
  date        timestamptz not null default now(),
  created_at  timestamptz not null default now(),

  constraint transactions_amount_positive check (amount > 0),
  constraint transactions_category_length check (char_length(btrim(category)) between 1 and 60),
  constraint transactions_note_length     check (note is null or char_length(note) <= 500)
);

comment on table  public.transactions        is 'Immutable-ish ledger rows. INCOME increases the wallet balance, EXPENSE decreases it.';
comment on column public.transactions.amount is 'Always a positive magnitude. The direction is carried by `type`.';
comment on column public.transactions.date   is 'When the money actually moved. Defaults to now() but can be back-dated.';


-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
create index if not exists wallets_user_id_idx
  on public.wallets (user_id);

create index if not exists transactions_user_id_idx
  on public.transactions (user_id);

create index if not exists transactions_wallet_id_idx
  on public.transactions (wallet_id);

-- Standalone date index: powers "latest activity" and range scans.
create index if not exists transactions_date_idx
  on public.transactions (date desc);

-- Composite indexes: the exact shapes every app query uses.
--   where user_id = auth.uid()            order by date desc
--   where wallet_id = $1 and date >= ..   order by date desc
create index if not exists transactions_user_date_idx
  on public.transactions (user_id, date desc);

create index if not exists transactions_wallet_date_idx
  on public.transactions (wallet_id, date desc);

-- Category breakdown charts.
create index if not exists transactions_user_category_idx
  on public.transactions (user_id, category);


-- ---------------------------------------------------------------------------
-- 4. Helper functions
-- ---------------------------------------------------------------------------

-- 4.1 keep updated_at honest ------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists wallets_set_updated_at on public.wallets;
create trigger wallets_set_updated_at
  before update on public.wallets
  for each row execute function public.set_updated_at();


-- 4.2 a transaction may only reference a wallet the caller owns -------------
create or replace function public.tg_transactions_assert_owner()
returns trigger
language plpgsql
as $$
declare
  v_owner uuid;
begin
  -- RLS on public.wallets applies here, so a forged wallet_id belonging to
  -- somebody else simply resolves to NULL and the write is rejected.
  select w.user_id into v_owner
  from public.wallets w
  where w.id = new.wallet_id;

  if v_owner is null then
    raise exception 'Wallet % does not exist or is not owned by the current user.', new.wallet_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.user_id is distinct from v_owner then
    raise exception 'transactions.user_id must match the owner of wallet %.', new.wallet_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists transactions_assert_owner on public.transactions;
create trigger transactions_assert_owner
  before insert or update of wallet_id, user_id on public.transactions
  for each row execute function public.tg_transactions_assert_owner();


-- 4.3 keep wallets.balance in sync with the ledger --------------------------
create or replace function public.apply_wallet_delta(p_wallet_id uuid, p_delta numeric)
returns void
language sql
as $$
  update public.wallets
     set balance    = balance + p_delta,
         updated_at = now()
   where id = p_wallet_id;
$$;

create or replace function public.tg_transactions_apply_balance()
returns trigger
language plpgsql
as $$
declare
  v_signed numeric(18, 2);
begin
  if tg_op = 'INSERT' then
    v_signed := case when new.type = 'INCOME' then new.amount else -new.amount end;
    perform public.apply_wallet_delta(new.wallet_id, v_signed);
    return new;

  elsif tg_op = 'DELETE' then
    -- Undo the row that is going away.
    v_signed := case when old.type = 'INCOME' then -old.amount else old.amount end;
    perform public.apply_wallet_delta(old.wallet_id, v_signed);
    return old;

  else
    -- UPDATE: undo the old effect, then apply the new one.
    -- Moving a transaction between wallets is handled by touching both sides.
    if old.wallet_id = new.wallet_id then
      v_signed :=
          (case when new.type = 'INCOME' then new.amount else -new.amount end)
        - (case when old.type = 'INCOME' then old.amount else -old.amount end);
      perform public.apply_wallet_delta(new.wallet_id, v_signed);
    else
      perform public.apply_wallet_delta(
        old.wallet_id,
        case when old.type = 'INCOME' then -old.amount else old.amount end
      );
      perform public.apply_wallet_delta(
        new.wallet_id,
        case when new.type = 'INCOME' then new.amount else -new.amount end
      );
    end if;
    return new;
  end if;
end;
$$;

drop trigger if exists transactions_apply_balance on public.transactions;
create trigger transactions_apply_balance
  after insert or update or delete on public.transactions
  for each row execute function public.tg_transactions_apply_balance();


-- 4.4 give every new signup a starting wallet -------------------------------
--     security definer so it can write during the auth.users insert, when
--     auth.uid() is not yet set.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.wallets (user_id, name, currency, balance)
  values (new.id, 'Cash', 'MMK', 0);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- 5. Reporting RPC
--    Server-side aggregation so the client never has to download a month of
--    rows just to add them up.
-- ---------------------------------------------------------------------------
create or replace function public.get_monthly_summary(
  p_wallet_id uuid default null,
  p_month     date default null
)
returns table (
  income            numeric,
  expense           numeric,
  net               numeric,
  transaction_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', coalesce(p_month, current_date))            as start_at,
      date_trunc('month', coalesce(p_month, current_date)) + interval '1 month' as end_at
  )
  select
    coalesce(sum(case when t.type = 'INCOME'  then t.amount else 0 end), 0)::numeric(18, 2) as income,
    coalesce(sum(case when t.type = 'EXPENSE' then t.amount else 0 end), 0)::numeric(18, 2) as expense,
    coalesce(sum(case when t.type = 'INCOME'  then t.amount else -t.amount end), 0)::numeric(18, 2) as net,
    count(*)::bigint as transaction_count
  from public.transactions t
  cross join bounds b
  where t.user_id = auth.uid()
    and t.date >= b.start_at
    and t.date <  b.end_at
    and (p_wallet_id is null or t.wallet_id = p_wallet_id);
$$;

grant execute on function public.get_monthly_summary(uuid, date) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.wallets      enable row level security;
alter table public.transactions enable row level security;

-- 6.1 wallets ---------------------------------------------------------------
drop policy if exists "wallets_select_own" on public.wallets;
create policy "wallets_select_own"
  on public.wallets for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "wallets_insert_own" on public.wallets;
create policy "wallets_insert_own"
  on public.wallets for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "wallets_update_own" on public.wallets;
create policy "wallets_update_own"
  on public.wallets for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "wallets_delete_own" on public.wallets;
create policy "wallets_delete_own"
  on public.wallets for delete
  to authenticated
  using (auth.uid() = user_id);

-- 6.2 transactions ----------------------------------------------------------
drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own"
  on public.transactions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "transactions_insert_own" on public.transactions;
create policy "transactions_insert_own"
  on public.transactions for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.wallets w
      where w.id = wallet_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "transactions_update_own" on public.transactions;
create policy "transactions_update_own"
  on public.transactions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.wallets w
      where w.id = wallet_id and w.user_id = auth.uid()
    )
  );

drop policy if exists "transactions_delete_own" on public.transactions;
create policy "transactions_delete_own"
  on public.transactions for delete
  to authenticated
  using (auth.uid() = user_id);

-- 6.3 table privileges ------------------------------------------------------
-- RLS filters rows; GRANTs decide whether the role may touch the table at all.
-- `anon` deliberately gets nothing — every read requires a real session.
grant select, insert, update, delete on public.wallets      to authenticated;
grant select, insert, update, delete on public.transactions to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Ask PostgREST to pick up the new shape immediately
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
