/**
 * Tiny validation helpers.
 *
 * Deliberately hand-rolled instead of pulling in zod: the shared package is
 * bundled into a mobile app, and every kilobyte of runtime dependency is paid
 * for twice (Metro bundle + Electron renderer bundle). The database has the
 * same rules as CHECK constraints, so these are the *first* line of defence,
 * not the only one.
 */

import { AppError } from './errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CURRENCY_RE = /^[A-Z]{3}$/;

export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppError(`\`${field}\` must be a valid UUID.`, 'validation_error', value);
  }
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertNonEmptyString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new AppError(`\`${field}\` is required.`, 'validation_error', value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AppError(`\`${field}\` cannot be empty.`, 'validation_error', value);
  }
  if (trimmed.length > maxLength) {
    throw new AppError(
      `\`${field}\` must be ${maxLength} characters or fewer.`,
      'validation_error',
      value,
    );
  }
  return trimmed;
}

export function assertOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new AppError(`\`${field}\` must be text.`, 'validation_error', value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new AppError(
      `\`${field}\` must be ${maxLength} characters or fewer.`,
      'validation_error',
      value,
    );
  }
  return trimmed;
}

export function assertCurrencyCode(value: unknown, field = 'currency'): string {
  if (typeof value !== 'string') {
    throw new AppError(`\`${field}\` is required.`, 'validation_error', value);
  }
  const upper = value.trim().toUpperCase();
  if (!CURRENCY_RE.test(upper)) {
    throw new AppError(
      `\`${field}\` must be a 3-letter ISO-4217 code (e.g. MMK, USD).`,
      'validation_error',
      value,
    );
  }
  return upper;
}

export function assertPositiveAmount(value: unknown, field = 'amount'): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new AppError(`\`${field}\` must be a number.`, 'validation_error', value);
  }
  if (amount <= 0) {
    throw new AppError(`\`${field}\` must be greater than zero.`, 'validation_error', value);
  }
  if (amount > 1_000_000_000_000) {
    throw new AppError(`\`${field}\` is unrealistically large.`, 'validation_error', value);
  }
  // numeric(18,2) — never send more precision than the column can hold.
  return Math.round(amount * 100) / 100;
}

export function assertNonNegativeAmount(value: unknown, field = 'amount'): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new AppError(`\`${field}\` must be a number.`, 'validation_error', value);
  }
  if (amount < 0) {
    throw new AppError(`\`${field}\` cannot be negative.`, 'validation_error', value);
  }
  return Math.round(amount * 100) / 100;
}

export function assertEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError('Email is required.', 'validation_error', value);
  }
  const email = value.trim().toLowerCase();
  // Intentionally permissive — the auth provider is the real authority.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new AppError('Please enter a valid email address.', 'validation_error', value);
  }
  return email;
}

export function assertPassword(value: unknown, minimumLength = 8): string {
  if (typeof value !== 'string') {
    throw new AppError('Password is required.', 'validation_error', value);
  }
  if (value.length < minimumLength) {
    throw new AppError(
      `Password must be at least ${minimumLength} characters.`,
      'weak_password',
      value,
    );
  }
  return value;
}

/** Accepts a `Date` or an ISO string; returns an ISO string for PostgREST. */
export function assertIsoDate(value: unknown, field = 'date'): string {
  if (value === undefined || value === null) return new Date().toISOString();

  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`\`${field}\` is not a valid date.`, 'validation_error', value);
  }
  return date.toISOString();
}
