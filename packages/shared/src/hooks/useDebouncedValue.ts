/**
 * `useDebouncedValue` — delays a rapidly-changing value.
 *
 * The ledger search box is the reason this exists. Every keystroke would
 * otherwise be a fresh query, and the user pays for four of them before they
 * finish typing "coffee".
 *
 * The first value is returned immediately (no delay on mount) so a screen
 * that seeds the box from state does not flash empty.
 */

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }

    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
