import type { FailureKind } from '../domain/sync.js';

/**
 * Errors are classified once, at the point they are raised, into "retrying might help" and
 * "retrying cannot help". Everything downstream — backoff, dead-lettering, alerting — reads
 * that classification instead of re-inspecting status codes.
 *
 * Getting this split wrong is expensive in both directions. Retrying a permanent failure
 * burns the PCC rate budget for every tenant and hides a real defect behind a slowly growing
 * queue. Dead-lettering a transient failure hands an operator a chart that would have fixed
 * itself, and after a PCC incident there are thousands of them.
 */
export abstract class SyncError extends Error {
  abstract readonly kind: FailureKind;

  constructor(
    readonly code: string,
    message: string,
    /** Set when the upstream response asked us to wait a specific amount of time. */
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RetryableSyncError extends SyncError {
  readonly kind = 'retryable' as const;
}

export class PermanentSyncError extends SyncError {
  readonly kind = 'permanent' as const;
}

/**
 * HTTP status to failure kind.
 *
 * Two decisions worth calling out. A 401 is retryable exactly once in practice, because the
 * usual cause is an access token that expired between minting and use; the client refreshes
 * and retries, and a second 401 is raised as permanent by the client itself. A 403 is
 * permanent, because for PCC it means the organisation deactivated the application or a
 * three-legged consent was revoked — no amount of waiting fixes that, and it needs a human
 * and an alert rather than a retry loop.
 */
export function classifyHttpStatus(status: number): FailureKind {
  if (status === 408 || status === 425 || status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  return 'permanent';
}

export function isRetryable(error: unknown): boolean {
  return error instanceof SyncError && error.kind === 'retryable';
}

export type ClassifiedFailure = {
  kind: FailureKind;
  code: string;
  message: string;
  retryAfterMs: number | null;
};

/** Normalises anything thrown into the shape the dead-letter record needs. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof SyncError) {
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      retryAfterMs: error.retryAfterMs,
    };
  }

  if (error instanceof Error) {
    // Network-level faults surface as opaque Error subclasses with a code property.
    const code = (error as { code?: unknown }).code;
    const transient = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'EPIPE',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ]);
    const isTransient = typeof code === 'string' && transient.has(code);

    return {
      kind: isTransient ? 'retryable' : 'permanent',
      code: typeof code === 'string' ? code : error.name,
      message: error.message,
      retryAfterMs: null,
    };
  }

  return {
    kind: 'permanent',
    code: 'unknown_error',
    message: 'Non-error value thrown',
    retryAfterMs: null,
  };
}

export type BackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected so tests are deterministic. */
  random?: () => number;
};

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter rather than a fixed multiplier because the failures we retry are correlated by
 * construction: a PCC incident or a rate limit fails every in-flight task at once, and
 * without jitter they all come back in the same instant and trip the limit again. Spreading
 * each retry uniformly across its window is what breaks that lockstep.
 *
 * An explicit `Retry-After` always wins: guessing when the upstream has told us is rude and
 * counterproductive.
 */
export function backoffDelayMs(
  attempt: number,
  { baseDelayMs = 1_000, maxDelayMs = 10 * 60_000, random = Math.random }: BackoffOptions = {},
  retryAfterMs: number | null = null,
): number {
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  const exponentialWindow = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
  return Math.floor(random() * exponentialWindow);
}
