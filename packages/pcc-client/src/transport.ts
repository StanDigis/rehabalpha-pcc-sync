import {
  backoffDelayMs,
  classifyHttpStatus,
  PermanentSyncError,
  RetryableSyncError,
  type Logger,
} from '@rehabalpha/core';
import type { z } from 'zod';
import { buildPath, type PccRouteName } from './endpoints.js';
import { readRetryAfterMs, type TokenProvider } from './auth.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';

export type PccRequest = {
  route: PccRouteName;
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  method?: 'GET' | 'POST';
  body?: unknown;
};

export interface PccTransport {
  request<T>(request: PccRequest, schema: z.ZodType<T>): Promise<T>;
}

export type HttpTransportOptions = {
  baseUrl: string;
  pathPrefix: string;
  tokenProvider: TokenProvider;
  rateLimiter: TokenBucketRateLimiter;
  logger: Logger;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  requestTimeoutMs?: number;
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class HttpPccTransport implements PccTransport {
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: HttpTransportOptions) {
    this.maxAttempts = options.maxAttempts ?? 4;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  }

  async request<T>(request: PccRequest, schema: z.ZodType<T>): Promise<T> {
    const path = buildPath(request.route, request.params ?? {});
    const url = new URL(`${this.options.pathPrefix}${path}`, this.options.baseUrl);

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let authRetried = false;

    for (let attempt = 1; ; attempt += 1) {
      await this.options.rateLimiter.acquire();

      const token = await this.options.tokenProvider.get();
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: request.method ?? 'GET',
          headers: {
            authorization: `Bearer ${token.value}`,
            accept: 'application/json',
            ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (cause) {
        // A timeout or socket fault is transient by nature. It is raised as retryable so the
        // caller's retry budget, not an ad-hoc catch block, decides how long to keep trying.
        const error = new RetryableSyncError(
          'pcc_transport_error',
          `PCC request to ${request.route} did not complete`,
          null,
          { cause },
        );
        if (attempt >= this.maxAttempts) throw error;
        await this.waitBeforeRetry(attempt, null, request.route, 'transport');
        continue;
      }

      const durationMs = Date.now() - startedAt;

      // Only the route template is logged, never the resolved path: the resolved path carries
      // the PCC patient id, which is an identifier we are obliged not to scatter through logs.
      this.options.logger.debug('PCC request completed', {
        route: request.route,
        method: request.method ?? 'GET',
        status: response.status,
        attempt,
        durationMs,
      });

      if (response.ok) {
        return schema.parse(await parseJsonBody(response, request.route));
      }

      // An access token that expired between minting and use looks identical to a rejected
      // credential. Discarding the cached token and retrying once distinguishes them: a second
      // 401 is a real authorisation failure and is raised as permanent.
      if (response.status === 401 && !authRetried) {
        authRetried = true;
        this.options.tokenProvider.invalidate();
        continue;
      }

      const kind = classifyHttpStatus(response.status);
      const retryAfterMs = readRetryAfterMs(response);

      if (kind === 'permanent' || attempt >= this.maxAttempts) {
        throw await this.toError(response, request.route, kind, retryAfterMs);
      }

      await this.waitBeforeRetry(attempt, retryAfterMs, request.route, String(response.status));
    }
  }

  private async waitBeforeRetry(
    attempt: number,
    retryAfterMs: number | null,
    route: PccRouteName,
    cause: string,
  ): Promise<void> {
    const delayMs = backoffDelayMs(attempt, { random: this.random }, retryAfterMs);
    this.options.logger.warn('Retrying PCC request', { route, attempt, delayMs, cause });
    await this.sleep(delayMs);
  }

  private async toError(
    response: Response,
    route: PccRouteName,
    kind: 'retryable' | 'permanent',
    retryAfterMs: number | null,
  ): Promise<Error> {
    // Upstream error bodies occasionally echo request data back, so the body is never carried
    // into the message. Status and route are enough to act on, and the correlation id in the
    // log line is how an operator finds the specific request.
    const message = `PCC ${route} responded ${response.status}`;
    const code =
      response.status === 403
        ? 'pcc_access_forbidden'
        : response.status === 404
          ? 'pcc_not_found'
          : response.status === 429
            ? 'pcc_rate_limited'
            : `pcc_http_${response.status}`;

    return kind === 'retryable'
      ? new RetryableSyncError(code, message, retryAfterMs)
      : new PermanentSyncError(code, message, retryAfterMs);
  }
}

async function parseJsonBody(response: Response, route: PccRouteName): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new PermanentSyncError('pcc_invalid_json', `PCC ${route} returned a non-JSON body`);
  }
}
