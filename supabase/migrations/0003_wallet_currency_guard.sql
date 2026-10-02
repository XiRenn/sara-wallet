-- ============================================================================
--  Personal Wallet — currency change guard
--  Target : Supabase (PostgreSQL 15+)
--  Usage  : Run AFTER 0002_transfers.sql. Safe to re-run.
--
--  Why
--  ---
--  `wallets.balance` is a bare numeric with no currency attached. Renaming a
--  wallet is harmless, but *changing its currency* reinterprets that number:
--  50,000 MMK silently becomes 50,000 USD, and nothing in the ledger records
--  that a conversion happened.
--
--  A wallet may only change currency while it is genuinely empty and has no
--  history. Past that point the operation is meaningless, so it is refused.
-- ============================================================================

create or replace function public.tg_wallets_guard_currency_change()
returns trigger
language plpgsql
as $$
begin
  -- The balance trigger also updates wallets; it never touches the currency,
  -- so this is a no-op for it.
  if new.currency is distinct from old.currency then

    if old.balance <> 0 then
      raise exception
        'Cannot change the currency of "%" while it holds a balance. Move the money out first.',
        old.name
        using errcode = 'check_violation';
    end if;

    if exists (select 1 from public.transactions t where t.wallet_id = old.id) then
      raise exception
        'Cannot change the currency of "%" because it already has transactions. Create a new wallet instead.',
        old.name
        using errcode = 'check_violation';
    end if;

  end if;

  return new;
end;
$$;

drop trigger if exists wallets_guard_currency_change on public.wallets;
create trigger wallets_guard_currency_change
  before update on public.wallets
  for each row execute function public.tg_wallets_guard_currency_change();


notify pgrst, 'reload schema';
