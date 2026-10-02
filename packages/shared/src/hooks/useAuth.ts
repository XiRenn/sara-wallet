/**
 * `useAuth` — session state for both apps.
 *
 * Boot sequence:
 *   1. read the persisted session once (`getSession` is a local read)
 *   2. subscribe to live auth events
 *   3. flip `status` from `'loading'` to authenticated/unauthenticated
 *
 * The subscription callback only sets state. supabase-js fires it while
 * holding its internal lock, so awaiting another Supabase call inside it would
 * deadlock — the callback stays synchronous on purpose.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getCustomSession,
  onAuthStateChange,
  signIn as signInService,
  signOut as signOutService,
  signUp as signUpService,
} from '../services/auth';
import type {
  AppUser,
  AuthSession,
  AuthStatus,
  SignInInput,
  SignUpInput,
} from '../types/auth';
import { describeError } from '../utils/errors';

export interface SignUpOutcome {
  /** `true` when the project requires email confirmation first. */
  needsEmailConfirmation: boolean;
}

export interface UseAuthResult {
  user: AppUser | null;
  session: AuthSession | null;
  status: AuthStatus;
  /** User-facing message for the last failure, or `null`. */
  error: string | null;
  /** `true` while a sign-in / sign-up / sign-out request is in flight. */
  isSubmitting: boolean;
  signIn: (input: SignInInput) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<SignUpOutcome>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): UseAuthResult {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Guards every async `setState` against an unmounted component.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // 1. Hydrate from storage.
    let cancelled = false;
    void (async () => {
      try {
        const restored = await getCustomSession();
        if (cancelled || !mountedRef.current) return;
        setSession(restored);
        setStatus(restored ? 'authenticated' : 'unauthenticated');
      } catch (cause) {
        if (cancelled || !mountedRef.current) return;
        // A corrupt/expired blob must not trap the user on a spinner.
        setError(describeError(cause));
        setSession(null);
        setStatus('unauthenticated');
      }
    })();

    // 2. Follow live changes.
    const unsubscribe = onAuthStateChange((nextSession) => {
      if (!mountedRef.current) return;
      setSession(nextSession);
      setStatus(nextSession ? 'authenticated' : 'unauthenticated');
      if (nextSession) setError(null);
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (input: SignInInput) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const next = await signInService(input);
      if (!mountedRef.current) return;
      setSession(next);
      setStatus('authenticated');
    } catch (cause) {
      if (mountedRef.current) setError(describeError(cause));
      throw cause;
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  }, []);

  const signUp = useCallback(async (input: SignUpInput): Promise<SignUpOutcome> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await signUpService(input);
      if (!mountedRef.current) {
        return { needsEmailConfirmation: result.needsEmailConfirmation };
      }
      setSession(result.session);
      setStatus(result.session ? 'authenticated' : 'unauthenticated');
      return { needsEmailConfirmation: result.needsEmailConfirmation };
    } catch (cause) {
      if (mountedRef.current) setError(describeError(cause));
      throw cause;
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await signOutService();
      if (!mountedRef.current) return;
      setSession(null);
      setStatus('unauthenticated');
    } catch (cause) {
      if (mountedRef.current) setError(describeError(cause));
      throw cause;
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    user: session?.user ?? null,
    session,
    status,
    error,
    isSubmitting,
    signIn,
    signUp,
    signOut,
    clearError,
  };
}
