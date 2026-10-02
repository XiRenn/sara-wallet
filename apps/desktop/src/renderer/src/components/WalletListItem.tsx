import React from 'react';

import { formatCurrency, type Wallet } from '@wallet/shared';

import { IconPencil, IconTrash } from './Icons';
import { categoryStyle } from '../theme';

interface WalletListItemProps {
  wallet: Wallet;
  selected: boolean;
  onSelect: (walletId: string) => void;
  onRename: (wallet: Wallet) => void;
  onDelete: (wallet: Wallet) => void;
}

/**
 * A wallet row in the sidebar. The rename/delete buttons sit *beside* the row
 * button rather than inside it — nested buttons are invalid HTML and break
 * keyboard navigation.
 *
 * The avatar's colour comes from hashing the wallet name, the same way
 * category colours do, so a wallet keeps its colour across sessions without
 * anything being stored.
 */
export function WalletListItem({
  wallet,
  selected,
  onSelect,
  onRename,
  onDelete,
}: WalletListItemProps) {
  const initial = wallet.name.trim().charAt(0) || '?';

  return (
    <div className="wallet-item-wrap">
      <button
        type="button"
        className="wallet-item"
        aria-pressed={selected}
        onClick={() => onSelect(wallet.id)}
      >
        <span className="wallet-avatar" style={categoryStyle(wallet.name)} aria-hidden="true">
          {initial}
        </span>

        <span className="wallet-item-body">
          <span className="wallet-item-top">
            <span className="wallet-item-name">{wallet.name}</span>
            <span className="wallet-item-currency">{wallet.currency}</span>
          </span>
          <span className="wallet-item-balance">
            {formatCurrency(wallet.balance, wallet.currency)}
          </span>
        </span>
      </button>

      <div className="wallet-item-actions">
        <button
          type="button"
          className="icon-btn"
          title={`Rename ${wallet.name}`}
          aria-label={`Rename ${wallet.name}`}
          onClick={() => onRename(wallet)}
        >
          <IconPencil size={14} />
        </button>
        <button
          type="button"
          className="icon-btn is-danger"
          title={`Delete ${wallet.name}`}
          aria-label={`Delete ${wallet.name}`}
          onClick={() => onDelete(wallet)}
        >
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  );
}
