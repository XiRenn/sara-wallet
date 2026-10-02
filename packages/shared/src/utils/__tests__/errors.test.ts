import { describe, expect, it } from 'vitest';

import {
  AppError,
  ERROR_COPY,
  describeError,
  isAppError,
  toAppError,
  unwrap,
  type AppErrorCode,
} from '../errors';

const ALL_CODES: AppErrorCode[] = [
  'not_authenticated',
  'invalid_credentials',
  'email_taken',
  'weak_password',
  'email_not_confirmed',
  'not_found',
  'validation_error',
  'permission_denied',
  'network_error',
  'unknown_error',
];

describe('AppError', () => {
  it('defaults to unknown_error', () => {
    expect(new AppError('boom').code).toBe('unknown_error');
  });

  it('carries the code it was given', () => {
    expect(new AppError('boom', 'not_found').code).toBe('not_found');
  });

  it('is an Error', () => {
    expect(new AppError('boom')).toBeInstanceOf(Error);
  });

  it('survives instanceof — the reason setPrototypeOf is in the constructor', () => {
    // Without Object.setPrototypeOf this fails when the class is down-levelled
    // to ES5, which is exactly what Metro does for React Native.
    expect(new AppError('boom')).toBeInstanceOf(AppError);
  });

  it('names itself AppError', () => {
    expect(new AppError('boom').name).toBe('AppError');
  });

  it('keeps the original throwable for logging', () => {
    const cause = new Error('underlying');
    expect(new AppError('boom', 'unknown_error', cause).originalError).toBe(cause);
  });

  it('preserves the message', () => {
    expect(new AppError('Wallet not found.').message).toBe('Wallet not found.');
  });
});

describe('isAppError', () => {
  it('accepts an AppError', () => {
    expect(isAppError(new AppError('boom'))).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isAppError(new Error('boom'))).toBe(false);
  });

  it('rejects non-errors', () => {
    expect(isAppError('boom')).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ code: 'not_found' })).toBe(false);
  });
});

describe('toAppError — pass-through', () => {
  it('returns the same instance when already an AppError', () => {
    const original = new AppError('boom', 'not_found');
    expect(toAppError(original)).toBe(original);
  });

  it('does not rewrite a specific code to the fallback', () => {
    expect(toAppError(new AppError('x', 'permission_denied')).code).toBe('permission_denied');
  });
});

describe('toAppError — classification from the message', () => {
  it.each([
    ['Invalid login credentials', 'invalid_credentials'],
    ['Email not confirmed', 'email_not_confirmed'],
    ['User already registered', 'email_taken'],
    ['A user with this email address has already been registered', 'email_taken'],
    ['Password should be at least 6 characters', 'weak_password'],
    ['new row violates row-level security policy for table "wallets"', 'permission_denied'],
    ['permission denied for table wallets', 'permission_denied'],
    ['TypeError: Failed to fetch', 'network_error'],
    ['Network request failed', 'network_error'],
    ['JWT expired', 'not_authenticated'],
    ['session not found', 'not_authenticated'],
    ['JSON object requested, multiple (or no) rows returned', 'not_found'],
    ['new row violates check constraint "transactions_amount_positive"', 'validation_error'],
    ['duplicate key value violates unique constraint', 'email_taken'],
  ])('%s -> %s', (message, expected) => {
    expect(toAppError(new Error(message)).code).toBe(expected);
  });

  it('classifies a bare string throwable', () => {
    expect(toAppError('Invalid login credentials').code).toBe('invalid_credentials');
  });

  it('ignores an empty message and falls through to the fallback', () => {
    const result = toAppError(new Error(''), 'Boom.');
    expect(result.code).toBe('unknown_error');
    expect(result.message).toBe('Boom.');
  });
});

describe('toAppError — classification from the SQLSTATE', () => {
  it.each([
    ['42501', 'permission_denied'],
    ['23505', 'email_taken'],
    ['23503', 'validation_error'],
    ['23514', 'validation_error'],
    ['23502', 'validation_error'],
    ['PGRST116', 'not_found'],
    ['PGRST301', 'not_authenticated'],
  ])('code %s -> %s', (code, expected) => {
    expect(toAppError({ code, message: 'something happened' }).code).toBe(expected);
  });

  it('leaves an unknown SQLSTATE alone', () => {
    expect(toAppError({ code: '42P01', message: 'relation does not exist' }).code).toBe(
      'unknown_error',
    );
  });
});

describe('toAppError — classification from the HTTP status', () => {
  it.each([
    [401, 'not_authenticated'],
    [403, 'permission_denied'],
    [404, 'not_found'],
    [422, 'validation_error'],
    [409, 'email_taken'],
    [500, 'network_error'],
    [503, 'network_error'],
  ])('status %i -> %s', (status, expected) => {
    expect(toAppError({ status, message: 'x' }).code).toBe(expected);
  });

  it('prefers the message over the status when both are present', () => {
    // A 400 carrying "Invalid login credentials" is a credential failure, not
    // a generic validation failure.
    expect(toAppError({ status: 400, message: 'Invalid login credentials' }).code).toBe(
      'invalid_credentials',
    );
  });
});

describe('toAppError — shape handling', () => {
  it('appends a hint when Supabase supplies one', () => {
    const result = toAppError({ message: 'Column missing', hint: 'Did you mean "name"?' });
    expect(result.message).toBe('Column missing (Did you mean "name"?)');
  });

  it('ignores an empty hint', () => {
    expect(toAppError({ message: 'Column missing', hint: '   ' }).message).toBe('Column missing');
  });

  it('uses the fallback message when the error carries none', () => {
    expect(toAppError({}, 'Try again.').message).toBe('Try again.');
  });

  it('uses the default fallback for null / undefined', () => {
    expect(toAppError(null).message).toBe('Something went wrong. Please try again.');
    expect(toAppError(undefined).message).toBe('Something went wrong. Please try again.');
  });

  it('uses the default fallback for a number', () => {
    expect(toAppError(42).code).toBe('unknown_error');
  });

  it('keeps the original throwable attached', () => {
    const shaped = { message: 'x', code: '42501' };
    expect(toAppError(shaped).originalError).toBe(shaped);
  });
});

describe('unwrap', () => {
  it('returns the data on success', () => {
    expect(unwrap({ data: { id: 'abc' }, error: null }, 'nope')).toEqual({ id: 'abc' });
  });

  it('returns falsy data rather than treating it as missing', () => {
    expect(unwrap({ data: 0, error: null }, 'nope')).toBe(0);
    expect(unwrap({ data: '', error: null }, 'nope')).toBe('');
    expect(unwrap({ data: false, error: null }, 'nope')).toBe(false);
  });

  it('throws a mapped AppError when an error is present', () => {
    const thrown = (() => {
      try {
        unwrap({ data: null, error: { code: 'PGRST116', message: 'no rows' } }, 'nope');
        return null;
      } catch (error) {
        return error as AppError;
      }
    })();
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.code).toBe('not_found');
  });

  it('throws not_found when the data is null', () => {
    const thrown = (() => {
      try {
        unwrap({ data: null, error: null }, 'Wallet missing.');
        return null;
      } catch (error) {
        return error as AppError;
      }
    })();
    expect(thrown?.code).toBe('not_found');
    expect(thrown?.message).toBe('Wallet missing.');
  });

  it('uses the supplied message as the fallback for an unclassifiable error', () => {
    const thrown = (() => {
      try {
        unwrap({ data: null, error: {} }, 'Could not save.' );
        return null;
      } catch (error) {
        return error as AppError;
      }
    })();
    expect(thrown?.message).toBe('Could not save.');
  });
});

describe('ERROR_COPY', () => {
  it('has copy for every code', () => {
    for (const code of ALL_CODES) {
      expect(ERROR_COPY[code]).toBeTypeOf('string');
      expect(ERROR_COPY[code].length).toBeGreaterThan(0);
    }
  });

  it('covers exactly the declared codes', () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...ALL_CODES].sort());
  });
});

describe('describeError', () => {
  it('returns the specific copy for a mapped code', () => {
    expect(describeError(new AppError('raw detail', 'not_found'))).toBe(ERROR_COPY.not_found);
  });

  it('surfaces the raw message for validation errors — the user needs the detail', () => {
    expect(describeError(new AppError('Amount must be greater than zero.', 'validation_error'))).toBe(
      'Amount must be greater than zero.',
    );
  });

  it('surfaces the raw message for unknown errors', () => {
    expect(describeError(new AppError('Something odd.', 'unknown_error'))).toBe('Something odd.');
  });

  it('falls back to the generic copy when a validation error has no message', () => {
    expect(describeError(new AppError('', 'validation_error'))).toBe(ERROR_COPY.validation_error);
  });

  it('handles a raw string', () => {
    expect(describeError('network down')).toBe('network down');
  });

  it('handles an empty string with the generic copy', () => {
    expect(describeError('')).toBe(ERROR_COPY.unknown_error);
  });

  it('handles null', () => {
    expect(describeError(null)).toBe(ERROR_COPY.unknown_error);
  });

  it('never leaks an AppError code name into the copy', () => {
    for (const code of ALL_CODES) {
      expect(describeError(new AppError('x', code))).not.toContain(code);
    }
  });
});
