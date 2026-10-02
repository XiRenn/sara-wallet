import React, { useEffect, useRef } from 'react';

import { IconAlert } from './Icons';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /** A request is in flight — both buttons lock and Escape is ignored. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Destructive-action confirmation.
 *
 * `window.confirm` would work, but inside Electron it renders as an OS-level
 * modal that ignores the app's theme, blocks the renderer process, and cannot
 * be styled. This keeps the last step of a delete inside the app.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus lands on the safe button, not the destructive one.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <span className="confirm-icon" aria-hidden="true">
          <IconAlert size={21} />
        </span>

        <h2 className="dialog-title" id="confirm-dialog-title">
          {title}
        </h2>
        <p className="confirm-message">{message}</p>

        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-destructive"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
