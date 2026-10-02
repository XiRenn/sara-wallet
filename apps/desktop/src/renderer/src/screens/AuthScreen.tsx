import React, { useState } from 'react';

import type { SignInInput, SignUpInput } from '@wallet/shared';

import { IconAlert } from '../components/Icons';

interface AuthScreenProps {
  onSubmitSignIn: (input: SignInInput) => Promise<void>;
  onSubmitSignUp: (input: SignUpInput) => Promise<{ needsEmailConfirmation: boolean }>;
  isSubmitting: boolean;
  error: string | null;
  onClearError: () => void;
}

type Mode = 'signin' | 'signup';

const MIN_PASSWORD_LENGTH = 8;

export function AuthScreen({
  onSubmitSignIn,
  onSubmitSignUp,
  isSubmitting,
  error,
  onClearError,
}: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setLocalError(null);
    setConfirmationSent(false);
    onClearError();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    setConfirmationSent(false);

    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmedEmail)) {
      setLocalError('Enter a valid email address.');
      return;
    }
    if (mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password.length === 0) {
      setLocalError('Enter your password.');
      return;
    }

    try {
      if (mode === 'signin') {
        await onSubmitSignIn({ email: trimmedEmail, password });
      } else {
        const result = await onSubmitSignUp({
          email: trimmedEmail,
          password,
          displayName: displayName.trim() || undefined,
        });
        if (result.needsEmailConfirmation) {
          setConfirmationSent(true);
          setPassword('');
        }
      }
    } catch {
      // The hook already produced a user-facing message.
    }
  };

  const message = localError ?? error;

  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <div className="auth-brand">
          <div className="auth-logo" aria-hidden="true">
            S
          </div>
          <h1 className="auth-title">Sara Wallet</h1>
          <p className="auth-subtitle">
            {mode === 'signin'
              ? 'Sign in to see your balances.'
              : 'Create an account to start tracking.'}
          </p>
        </div>

        <div className="segmented">
          <button
            type="button"
            aria-pressed={mode === 'signin'}
            onClick={() => switchMode('signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={mode === 'signup'}
            onClick={() => switchMode('signup')}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {mode === 'signup' ? (
            <>
              <label className="label" htmlFor="auth-name">
                Name (optional)
              </label>
              <input
                id="auth-name"
                className="input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="e.g. Aung"
                maxLength={60}
                disabled={isSubmitting}
                autoComplete="name"
              />
            </>
          ) : null}

          <label className="label" htmlFor="auth-email">
            Email
          </label>
          <input
            id="auth-email"
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            disabled={isSubmitting}
          />

          <label className="label" htmlFor="auth-password">
            Password
          </label>
          <input
            id="auth-password"
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={
              mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters` : '••••••••'
            }
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            disabled={isSubmitting}
          />

          {message ? (
            <p className="field-error">
              <IconAlert size={15} />
              {message}
            </p>
          ) : null}

          {confirmationSent ? (
            <div className="notice">
              Almost there — open the confirmation link we just emailed you, then come
              back and sign in.
            </div>
          ) : null}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 24, minHeight: 44 }}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <span className="spinner" aria-hidden="true" />
            ) : mode === 'signin' ? (
              'Sign in'
            ) : (
              'Create account'
            )}
          </button>
        </form>

        <button
          type="button"
          className="link-btn auth-switch"
          onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin'
            ? "Don't have an account? Register"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
