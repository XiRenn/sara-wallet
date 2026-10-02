-- ============================================================================
--  Personal Wallet — wallets.balance is not client-writable
--  Target : Supabase (PostgreSQL 15+)
--  Usage  : Run AFTER 0003_wallet_currency_guard.sql. Safe to re-run.
--
--  Why
--  ---
--  `wallets.balance` is derived from the ledger. The app is careful about this:
--  `updateWallet()` never sends the column, and the README says so in bold.
--
--  But that is a *client-side convention*, and Row Level Security does not
--  enforce conventions. The `wallets_update_own` policy permits UPDATE on every
--  column of your own row, `balance` included. So any client talking to
--  PostgREST directly — curl with the anon key and a real session token — can
--  simply:
--
--      PATCH /rest/v1/wallets?id=eq.<own wallet>   {"balance": 999999}
--
--  and the balance is now wrong forever, with nothing in the ledger to explain
--  it. `supabase/tests/assertions.sql` demonstrates exactly this.
--
--  Fix
--  ---
--  The balance trigger is the only legitimate writer, so it announces itself
--  with a transaction-local flag and the guard below requires it. Same pattern
--  as the transfer-cascade flag in 0002.
--
--  Note this guards UPDATE only. Creating a wallet with an `openingBalance` is
--  still a plain INSERT and remains allowed — that is a real feature, not a
--  loophole, and the ledger is correct from that moment on.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The one legitimate writer raises a flag
--    Recreated as plpgsql: a SQL-language body cannot call set_config.
--    Nothing depends on this function structurally (PL/pgSQL resolves calls at
--    run time), so dropping it first is safe and lets the language change.
-- ---------------------------------------------------------------------------
drop function if exists public.apply_wallet_delta(uuid, numeric);

create or replace function public.apply_wallet_delta(p_wallet_id uuid, p_delta numeric)
returns void
language plpgsql
as $$
begin
  -- Transaction-local (`true`), so it can never leak past this transaction or
  -- into another session.
  perform set_config('wallet.balance_write', 'on', true);

  update public.wallets
     set balance    = balance + p_delta,
         updated_at = now()
   where id = p_wallet_id;

  perform set_config('wallet.balance_write', 'off', true);
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Everyone else is refused
-- ---------------------------------------------------------------------------
create or replace function public.tg_wallets_guard_balance_write()
returns trigger
language plpgsql
as $$
begin
  -- `is distinct from` so a no-op write (sending back the same figure) is not
  -- treated as tampering.
  if new.balance is distinct from old.balance then
    if coalesce(current_setting('wallet.balance_write', true), 'off') <> 'on' then
      raise exception
        'wallets.balance is derived from the ledger and cannot be written directly. Record a transaction instead.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists wallets_guard_balance_write on public.wallets;
create trigger wallets_guard_balance_write
  before update on public.wallets
  for each row execute function public.tg_wallets_guard_balance_write();


notify pgrst, 'reload schema';
