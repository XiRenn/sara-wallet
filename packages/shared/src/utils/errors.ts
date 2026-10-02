/**
 * A single error type for the whole monorepo.
 *
 * Supabase throws/returns a zoo of shapes (`AuthError`, `PostgrestError`,
 * `TypeError: Failed to fetch`, plain strings). Every service funnels failures
 * through `toAppError()` so the UI only ever has to switch on `error.code`.
 */

export type AppErrorCode =
  | 'not_authenticated'
  | 'invalid_credentials'
  | 'email_taken'
  | 'weak_password'
  | 'email_not_confirmed'
  | 'not_found'
  | 'validation_error'
  | 'permission_denied'
  | 'network_error'
  | 'unknown_error';

export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Original throwable, kept for logging. Never rendered to the user. */
  readonly originalError: unknown;

  constructor(
    message: string,
    code: AppErrorCode = 'unknown_error',
    originalError?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.originalError = originalError;

    // Required so `instanceof AppError` survives the ES5 down-level target
    // that Metro/Babel uses for React Native.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Structural view of the error objects Supabase hands back. */
interface SupabaseLikeError {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  name?: unknown;
  details?: unknown;
  hint?: unknown;
}

const MESSAGE_MAP: Array<[RegExp, AppErrorCode]> = [
  [/invalid login credentials/i, 'invalid_credentials'],
  [/email not confirmed/i, 'email_not_confirmed'],
  [/user already registered|already been registered|already exists/i, 'email_taken'],
  [/password should be at least|weak password|password is too short/i, 'weak_password'],
  [/row-level security|permission denied|not authorized/i, 'permission_denied'],
  [/failed to fetch|network request failed|networkerror|load failed/i, 'network_error'],
  [/jwt expired|invalid claim|not authenticated|session (missing|not found)/i, 'not_authenticated'],
  // PostgREST's `.single()` failure — PGRST116. The SQLSTATE switch below
  // catches it when a `code` is present; this covers message-only shapes.
  [/multiple \(or no\) rows returned/i, 'not_found'],
  [/no rows|0 rows|not found/i, 'not_found'],
  [/violates check constraint|violates not-null|invalid input/i, 'validation_error'],
  [/duplicate key value/i, 'email_taken'],
];

function readMessage(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function classify(error: SupabaseLikeError): AppErrorCode {
  const message = readMessage(error.message) ?? '';
  const name = readMessage(error.name) ?? '';
  const code = readMessage(error.code) ?? '';

  for (const [pattern, mapped] of MESSAGE_MAP) {
    if (pattern.test(message) || pattern.test(name)) return mapped;
  }

  // PostgreSQL SQLSTATEs that reach the client verbatim.
  switch (code) {
    case '42501':
      return 'permission_denied';
    case '23505':
      return 'email_taken';
    case '23503':
    case '23514':
    case '23502':
      return 'validation_error';
    case 'PGRST116':
      return 'not_found';
    case 'PGRST301':
      return 'not_authenticated';
    default:
      break;
  }

  if (error.status === 401) return 'not_authenticated';
  if (error.status === 403) return 'permission_denied';
  if (error.status === 404) return 'not_found';
  if (error.status === 422) return 'validation_error';
  if (error.status === 409) return 'email_taken';
  if (typeof error.status === 'number' && error.status >= 500) return 'network_error';

  return 'unknown_error';
}

/** Normalises anything throwable into an `AppError`. */
export function toAppError(
  error: unknown,
  fallbackMessage = 'Something went wrong. Please try again.',
): AppError {
  if (isAppError(error)) return error;

  const asString = readMessage(error);
  if (asString) return new AppError(asString, classify({ message: asString }), error);

  if (error && typeof error === 'object') {
    const shaped = error as SupabaseLikeError;
    const message = readMessage(shaped.message) ?? fallbackMessage;
    const hint = readMessage(shaped.hint);
    return new AppError(
      hint ? `${message} (${hint})` : message,
      classify(shaped),
      error,
    );
  }

  return new AppError(fallbackMessage, 'unknown_error', error);
}

/** Convenience for throwing on a `{ data, error }` Supabase result. */
export function unwrap<T>(
  result: { data: T | null; error: unknown },
  fallbackMessage: string,
): T {
  if (result.error) throw toAppError(result.error, fallbackMessage);
  if (result.data === null || result.data === undefined) {
    throw new AppError(fallbackMessage, 'not_found', result);
  }
  return result.data;
}

/** Human-readable text for the codes the UI shows as toasts/inline errors. */
export const ERROR_COPY: Record<AppErrorCode, string> = {
  not_authenticated: 'Your session has expired. Please sign in again.',
  invalid_credentials: 'That email and password combination is not right.',
  email_taken: 'An account with that email already exists.',
  weak_password: 'Please choose a password with at least 8 characters.',
  email_not_confirmed: 'Confirm your email address before signing in.',
  not_found: 'We could not find what you were looking for.',
  validation_error: 'Please check the details you entered.',
  permission_denied: 'You do not have permission to do that.',
  network_error: 'Network problem. Check your connection and try again.',
  unknown_error: 'Something went wrong. Please try again.',
};

/** Friendly, non-leaky message for an arbitrary error. */
export function describeError(error: unknown): string {
  const appError = isAppError(error) ? error : null;
  if (appError) {
    const copy = ERROR_COPY[appError.code];
    // Prefer our own copy for the generic buckets, the raw message otherwise.
    return appError.code === 'unknown_error' || appError.code === 'validation_error'
      ? appError.message || copy
      : copy;
  }
  return readMessage(error) ?? ERROR_COPY.unknown_error;
}
