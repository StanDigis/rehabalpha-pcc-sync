import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  classifyFailure,
  classifyHttpStatus,
  isRetryable,
  PermanentSyncError,
  RetryableSyncError,
} from './errors.js';

describe('classifyHttpStatus', () => {
  it.each([408, 425, 429, 500, 502, 503, 504])('treats %i as worth retrying', (status) => {
    expect(classifyHttpStatus(status)).toBe('retryable');
  });

  it.each([400, 404, 409, 422])('treats %i as permanent', (status) => {
    expect(classifyHttpStatus(status)).toBe('permanent');
  });

  /**
   * For PCC a 403 means the organisation deactivated the application or a three-legged consent was
   * revoked. Waiting does not fix either, and retrying hides the fact that a tenant has gone dark
   * behind a queue that merely looks busy.
   */
  it('treats an authorisation failure as permanent so it reaches a human', () => {
    expect(classifyHttpStatus(403)).toBe('permanent');
  });
});

describe('classifyFailure', () => {
  it('passes a classified sync error through unchanged', () => {
    const error = new RetryableSyncError('pcc_rate_limited', 'Too many requests', 2_000);

    expect(classifyFailure(error)).toEqual({
      kind: 'retryable',
      code: 'pcc_rate_limited',
      message: 'Too many requests',
      retryAfterMs: 2_000,
    });
  });

  it('keeps a permanent classification permanent', () => {
    expect(classifyFailure(new PermanentSyncError('pcc_not_found', 'Gone')).kind).toBe('permanent');
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'])(
    'recognises %s as a transient network fault',
    (code) => {
      const error = Object.assign(new Error('socket'), { code });

      expect(classifyFailure(error)).toMatchObject({ kind: 'retryable', code });
    },
  );

  /**
   * The safe default for an unrecognised error is permanent. A programming mistake retried six times
   * with backoff is a defect that takes an hour to surface instead of a minute, and it burns the
   * tenant's rate budget on the way.
   */
  it('defaults an unrecognised error to permanent', () => {
    expect(classifyFailure(new TypeError('cannot read property of undefined'))).toMatchObject({
      kind: 'permanent',
      code: 'TypeError',
    });
  });

  it('copes with a thrown non-error', () => {
    expect(classifyFailure('just a string')).toEqual({
      kind: 'permanent',
      code: 'unknown_error',
      message: 'Non-error value thrown',
      retryAfterMs: null,
    });
  });
});

describe('isRetryable', () => {
  it('is true only for a retryable sync error', () => {
    expect(isRetryable(new RetryableSyncError('x', 'x'))).toBe(true);
    expect(isRetryable(new PermanentSyncError('x', 'x'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('honours an explicit Retry-After over its own guess', () => {
    expect(backoffDelayMs(1, { random: () => 0.99 }, 7_000)).toBe(7_000);
  });

  it('still caps a Retry-After that would park the task for hours', () => {
    expect(backoffDelayMs(1, { maxDelayMs: 60_000 }, 3_600_000)).toBe(60_000);
  });

  it('ignores a nonsensical Retry-After', () => {
    expect(backoffDelayMs(1, { random: () => 0 }, 0)).toBe(0);
    expect(backoffDelayMs(3, { baseDelayMs: 1_000, random: () => 1 }, -5)).toBe(4_000);
  });

  it('widens the window exponentially with the attempt number', () => {
    const window = (attempt: number) =>
      backoffDelayMs(attempt, { baseDelayMs: 1_000, random: () => 1 });

    expect([window(1), window(2), window(3), window(4)]).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('clamps the window at the ceiling', () => {
    expect(backoffDelayMs(30, { baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => 1 })).toBe(
      60_000,
    );
  });

  /**
   * Full jitter, not a fixed multiplier. The failures being retried are correlated by construction —
   * a PCC incident fails every in-flight task at once — and without jitter they all return in the
   * same instant and trip the limit again.
   */
  it('spreads retries across the whole window rather than bunching them', () => {
    const delays = Array.from({ length: 200 }, () => backoffDelayMs(5, { baseDelayMs: 1_000 }));
    const window = 16_000;

    expect(Math.min(...delays)).toBeLessThan(window * 0.25);
    expect(Math.max(...delays)).toBeGreaterThan(window * 0.75);
    expect(new Set(delays).size).toBeGreaterThan(100);
  });

  it('never returns a negative delay', () => {
    expect(backoffDelayMs(0, { random: () => 0 })).toBe(0);
  });
});
