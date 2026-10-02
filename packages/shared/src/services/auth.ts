/**
 * Authentication service.
 *
 * Thin, fully-typed wrapper over `supabase.auth`. Every function either
 * resolves with a mapped domain object or throws an `AppError` — no caller
 * ever has to inspect a `{ data, error }` tuple.
 */

import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';

import { getSupabase } from '../config/supabase';
import type {
  AppUser,
  AuthEvent,
  AuthSession,
  AuthStateChangeHandler,
  SignInInput,
  SignUpInput,
  SignUpResult,
} from '../types/auth';
import { AppError, toAppError } from '../utils/errors';
import { assertEmail, assertPassword, assertOptionalString } from '../utils/validate';

/** Minimum length enforced client-side; mirror it in the Supabase dashboard. */
export const MIN_PASSWORD_LENGTH = 8;

/* -------------------------------------------------------------------------- */
/* Mappers                                                                     */
/* -------------------------------------------------------------------------- */

/** Maps a Supabase `User` into the app's serialisable shape. */
export function mapUser(user: User | null | undefined): AppUser | null {
  if (!user) return null;

  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const displayName =
    typeof metadata.display_name === 'string'
      ? metadata.display_name
      : typeof metadata.full_name === 'string'
        ? metadata.full_name
        : null;

  return {
    id: user.id,
    email: user.email ?? null,
    displayName,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    metadata,
  };
}

/** Maps a Supabase `Session` into the app's serialisable shape. */
export function mapSession(session: Session | null | undefined): AuthSession | null {
  if (!session) return null;

  const user = mapUser(session.user);
  if (!user) return null;

  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
    tokenType: session.token_type,
    user,
  };
}

/** The event names supabase-js emits that we care about. */
const TRACKED_EVENTS: readonly AuthEvent[] = [
  'INITIAL_SESSION',
  'SIGNED_IN',
  'SIGNED_OUT',
  'TOKEN_REFRESHED',
  'USER_UPDATED',
  'PASSWORD_RECOVERY',
];

function isTrackedEvent(event: AuthChangeEvent): event is AuthEvent {
  return (TRACKED_EVENTS as readonly string[]).includes(event);
}

/* -------------------------------------------------------------------------- */
/* Sign up / in / out                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Creates an account.
 *
 * When the Supabase project has "Confirm email" enabled, no session is
 * returned — `needsEmailConfirmation` is `true` and the caller must show a
 * "check your inbox" state rather than navigating into the app.
 */
export async function signUp(input: SignUpInput): Promise<SignUpResult> {
  const email = assertEmail(input.email);
  const password = assertPassword(input.password, MIN_PASSWORD_LENGTH);
  const displayName = assertOptionalString(input.displayName, 'displayName', 60);

  try {
    const { data, error } = await getSupabase().auth.signUp({
      email,
      password,
      options: {
        data: displayName ? { display_name: displayName } : {},
      },
    });

    if (error) throw toAppError(error, 'We could not create your account.');

    const user = mapUser(data.user);
    const session = mapSession(data.session);

    // Supabase returns a user with an empty `identities` array when the email
    // is already taken, and a null session when confirmation is required.
    const alreadyRegistered =
      data.user !== null &&
      Array.isArray(data.user.identities) &&
      data.user.identities.length === 0;

    if (alreadyRegistered) {
      throw new AppError(
        'An account with that email already exists. Try signing in instead.',
        'email_taken',
      );
    }

    return {
      user,
      session,
      needsEmailConfirmation: session === null,
    };
  } catch (error) {
    throw toAppError(error, 'We could not create your account.');
  }
}

/** Signs in with email + password and returns the freshly created session. */
export async function signIn(input: SignInInput): Promise<AuthSession> {
  const email = assertEmail(input.email);
  const password = assertPassword(input.password, 1);

  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw toAppError(error, 'We could not sign you in.');

    const session = mapSession(data.session);
    if (!session) {
      throw new AppError(
        'Sign-in succeeded but no session was returned. Please try again.',
        'unknown_error',
      );
    }
    return session;
  } catch (error) {
    throw toAppError(error, 'We could not sign you in.');
  }
}

/** Signs out locally and revokes the refresh token server-side. */
export async function signOut(): Promise<void> {
  try {
    const { error } = await getSupabase().auth.signOut({ scope: 'global' });
    if (error) {
      // An already-missing session is not a failure worth surfacing.
      const message = error.message?.toLowerCase() ?? '';
      if (message.includes('session') && message.includes('missing')) return;
      throw toAppError(error, 'We could not sign you out.');
    }
  } catch (error) {
    throw toAppError(error, 'We could not sign you out.');
  }
}

/* -------------------------------------------------------------------------- */
/* Session access                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Reads the persisted session from local storage.
 *
 * `getSession()` is a local read — it does not hit the network, and it
 * transparently refreshes an expired access token when a refresh token is
 * available. Use `getCurrentUser()` when you need a server-verified identity.
 */
export async function getCustomSession(): Promise<AuthSession | null> {
  try {
    const { data, error } = await getSupabase().auth.getSession();
    if (error) throw toAppError(error, 'We could not read your session.');
    return mapSession(data.session);
  } catch (error) {
    throw toAppError(error, 'We could not read your session.');
  }
}

/** Server-verified user (`GET /auth/v1/user`). Costs a round trip. */
export async function getCurrentUser(): Promise<AppUser | null> {
  try {
    const { data, error } = await getSupabase().auth.getUser();
    if (error) {
      // A stale/absent token is a normal state, not an exception.
      if (error.status === 401) return null;
      throw toAppError(error, 'We could not read your profile.');
    }
    return mapUser(data.user);
  } catch (error) {
    throw toAppError(error, 'We could not read your profile.');
  }
}

/**
 * The user id of the current session, or a thrown `not_authenticated` error.
 * Used by the other services to stamp `user_id` on inserts.
 */
export async function requireUserId(): Promise<string> {
  const session = await getCustomSession();
  if (!session) {
    throw new AppError('You must be signed in to do that.', 'not_authenticated');
  }
  return session.user.id;
}

/**
 * Subscribes to auth changes.
 * Returns an unsubscribe function — always call it on unmount.
 *
 * NOTE: supabase-js runs this callback while holding its internal lock, so
 * never `await` another Supabase call directly inside the handler. Defer with
 * `setTimeout(..., 0)` or a microtask if you need to fetch afterwards.
 */
export function onAuthStateChange(handler: AuthStateChangeHandler): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((event, session) => {
    if (!isTrackedEvent(event)) return;
    handler(mapSession(session), event);
  });

  return () => {
    data.subscription.unsubscribe();
  };
}

/* -------------------------------------------------------------------------- */
/* Password management                                                         */
/* -------------------------------------------------------------------------- */

/** Sends a password-reset email. Resolves even for unknown addresses. */
export async function sendPasswordReset(email: string): Promise<void> {
  const normalised = assertEmail(email);
  const { error } = await getSupabase().auth.resetPasswordForEmail(normalised);
  if (error) throw toAppError(error, 'We could not send the reset email.');
}

/** Updates the password of the currently signed-in user. */
export async function updatePassword(newPassword: string): Promise<void> {
  const password = assertPassword(newPassword, MIN_PASSWORD_LENGTH);
  const { error } = await getSupabase().auth.updateUser({ password });
  if (error) throw toAppError(error, 'We could not update your password.');
}

/** Updates mutable profile fields. */
export async function updateProfile(input: {
  displayName?: string;
  currency?: string;
}): Promise<AppUser | null> {
  const displayName = assertOptionalString(input.displayName, 'displayName', 60);
  const { data, error } = await getSupabase().auth.updateUser({
    data: { ...(displayName ? { display_name: displayName } : {}) },
  });
  if (error) throw toAppError(error, 'We could not update your profile.');
  return mapUser(data.user);
}
