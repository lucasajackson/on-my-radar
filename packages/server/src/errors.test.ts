/**
 * Reading a message off something that was thrown.
 *
 * These are the shapes `(err as Error).message` got wrong, and the reason that
 * cast is gone from six catch blocks. The last case is the one that mattered
 * most: it did not merely return the wrong string, it *threw a second error out
 * of the catch block*, so the error boundary stopped being one.
 */
import { describe, expect, it } from 'vitest';
import { errorBody } from './http.js';
import {
  errorMessage,
  errorName,
  isDatabaseBusy,
  isTransactionConflict,
  retryOnConflict,
} from './errors.js';

describe('errorMessage', () => {
  it('reads a real Error', () => {
    expect(errorMessage(new Error('the radar is gone'), 'fallback')).toBe('the radar is gone');
  });

  it('falls back for an Error with an empty message', () => {
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback');
  });

  it('reads a thrown string instead of discarding it', () => {
    // `(err as Error).message` was `undefined` here, so the actual words were
    // dropped at the one moment somebody wanted them.
    expect(errorMessage('connection reset', 'fallback')).toBe('connection reset');
  });

  it('reads a plain object that carries a message, as several libraries throw', () => {
    expect(errorMessage({ message: 'quota exceeded' }, 'fallback')).toBe('quota exceeded');
  });

  it('falls back rather than throwing on null, undefined and non-objects', () => {
    // The defect. `(null as unknown as Error).message` throws a TypeError from
    // *inside* the catch block, which escapes the handler: `guard` returned no
    // tool result at all, and `deliverWebhook` skipped `noteFailure` so the
    // sender's only diagnostic still read as though delivery had succeeded.
    expect(() => errorMessage(null, 'fallback')).not.toThrow();
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
    expect(errorMessage(42, 'fallback')).toBe('fallback');
    expect(errorMessage({ message: 7 }, 'fallback')).toBe('fallback');
  });
});

describe('errorName', () => {
  it('names a real Error, including a subclass', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError');
  });

  it('reads the name off an object without one being an Error', () => {
    // The shape `AbortSignal.timeout` produces, which `oidc.ts` branches on to
    // tell "the SSO server is slow" apart from "the SSO server is unreachable".
    expect(errorName({ name: 'TimeoutError' })).toBe('TimeoutError');
  });

  it('is null rather than a throw for null and undefined', () => {
    expect(() => errorName(null)).not.toThrow();
    expect(errorName(null)).toBeNull();
    expect(errorName(undefined)).toBeNull();
  });
});

describe('a deadlock or serialization failure', () => {
  // Drizzle wraps the driver's error: the SQLSTATE sits on `cause`.
  const victim = (code: string) => Object.assign(new Error('failed query'), { cause: { code } });

  it('is a transaction conflict, and answers 503 rather than 500', () => {
    for (const code of ['40P01', '40001']) {
      expect(isTransactionConflict(victim(code))).toBe(true);
      expect(isDatabaseBusy(victim(code))).toBe(true);
      expect(errorBody(victim(code))).toMatchObject({
        status: 503,
        body: { error: { code: 'database_busy' } },
      });
    }
    expect(isTransactionConflict(victim('23505'))).toBe(false);
    expect(errorBody(victim('23505')).status).toBe(500);
  });

  it('runs a rolled-back transaction once more, and no more than once', async () => {
    let runs = 0;
    await expect(
      retryOnConflict(async () => {
        runs += 1;
        if (runs === 1) throw victim('40P01');
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(runs).toBe(2);

    runs = 0;
    await expect(
      retryOnConflict(async () => {
        runs += 1;
        throw victim('40001');
      }),
    ).rejects.toMatchObject({ cause: { code: '40001' } });
    expect(runs).toBe(2);

    runs = 0;
    await expect(
      retryOnConflict(async () => {
        runs += 1;
        throw victim('23505');
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(runs).toBe(1);
  });
});
