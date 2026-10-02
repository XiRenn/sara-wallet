/**
 * Auth domain types.
 *
 * The app never leaks raw Supabase objects to the UI — everything is mapped
 * into these plain, serialisable shapes first. That keeps the Expo and the
 * Electron screens identical, and makes the auth surface mockable in tests.
 */

export interface AppUser {
  id: string;
  email: string | null;
  displayName: string | null;
  emailConfirmedAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  /** Raw `user_metadata`, escaped for rendering — never injected as HTML. */
  metadata: Record<string, unknown>;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds, or `null` when the provider did not supply an expiry. */
  expiresAt: number | null;
  tokenType: string;
  user: AppUser;
}

export interface SignUpInput {
  email: string;
  password: string;
  /** Optional friendly name stored in `user_metadata.display_name`. */
  displayName?: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignUpResult {
  user: AppUser | null;
  session: AuthSession | null;
  /**
   * `true` when the project requires email confirmation, meaning the caller
   * must show a "check your inbox" screen instead of entering the app.
   */
  needsEmailConfirmation: boolean;
}

/** The subset of Supabase auth events the app actually reacts to. */
export type AuthEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'PASSWORD_RECOVERY';

export type AuthStateChangeHandler = (
  session: AuthSession | null,
  event: AuthEvent,
) => void;

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';
