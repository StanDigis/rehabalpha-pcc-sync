import {
  createLogger,
  createMemorySink,
  PermanentSyncError,
  RetryableSyncError,
} from '@rehabalpha/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { HttpPccTransport } from './transport.js';
import type { AccessToken, TokenProvider } from './auth.js';

const bodySchema = z.object({ patientId: z.string() });

class CountingTokenProvider implements TokenProvider {
  invalidations = 0;
  private generation = 0;

  async get(): Promise<AccessToken> {
    return {
      value: `token-${this.generation}`,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    };
  }

  invalidate(): void {
    this.invalidations += 1;
    this.generation += 1;
  }
}

type ScriptedResponse = { status: number; body?: unknown; headers?: Record<string, string> };

function scriptedFetch(responses: ScriptedResponse[]) {
  const requests: Request[] = [];

  const implementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input instanceof Request ? input : String(input), init));

    const next = responses.shift();
    if (next === undefined) throw new Error('scriptedFetch ran out of responses');

    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  });

  return { implementation: implementation as unknown as typeof fetch, requests };
}

function createTransport(
  fetchImpl: typeof fetch,
  overrides: Partial<{ maxAttempts: number }> = {},
) {
  const { sink, entries } = createMemorySink();
  const tokenProvider = new CountingTokenProvider();
  const sleep = vi.fn(async () => undefined);

  const transport = new HttpPccTransport({
    baseUrl: 'https://connect.example.test',
    pathPrefix: '/api/public/preview1',
    tokenProvider,
    rateLimiter: new TokenBucketRateLimiter({ capacity: 100, refillPerSecond: 100 }),
    logger: createLogger({ service: 'test' }, sink),
    fetchImpl,
    sleep,
    // Fixed so the assertions on delay are exact rather than a range.
    random: () => 0.5,
    maxAttempts: overrides.maxAttempts ?? 4,
  });

  return { transport, entries, tokenProvider, sleep };
}

describe('HttpPccTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a bearer token and resolves the route template', async () => {
    const { implementation, requests } = scriptedFetch([
      { status: 200, body: { patientId: '1001' } },
    ]);
    const { transport } = createTransport(implementation);

    const result = await transport.request(
      { route: 'patient', params: { orgUuid: 'org-1', patientId: '1001' } },
      bodySchema,
    );

    expect(result).toEqual({ patientId: '1001' });
    expect(requests[0]!.url).toBe(
      'https://connect.example.test/api/public/preview1/org/org-1/patients/1001',
    );
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer token-0');
  });

  it('percent-encodes path parameters so an opaque id cannot address another resource', async () => {
    const { implementation, requests } = scriptedFetch([{ status: 200, body: { patientId: 'x' } }]);
    const { transport } = createTransport(implementation);

    await transport.request(
      { route: 'patient', params: { orgUuid: 'org-1', patientId: '../facs/99' } },
      bodySchema,
    );

    // The separator is what matters: with `/` escaped the value stays a single path segment, so a
    // traversal sequence in an upstream id cannot climb out of `/patients/` and address a facility.
    // `.` is left as-is because it is legal in a segment and harmless without a separator.
    expect(requests[0]!.url).toContain('/patients/..%2Ffacs%2F99');
    expect(requests[0]!.url).not.toContain('/facs/99');
    expect(new URL(requests[0]!.url).pathname.split('/').at(-1)).toBe('..%2Ffacs%2F99');
  });

  it('retries a rate-limited response and honours Retry-After', async () => {
    const { implementation } = scriptedFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { patientId: '1001' } },
    ]);
    const { transport, sleep } = createTransport(implementation);

    await transport.request(
      { route: 'patient', params: { orgUuid: 'org-1', patientId: '1001' } },
      bodySchema,
    );

    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it('gives up on a retryable failure once the attempt budget is spent', async () => {
    const { implementation } = scriptedFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { transport } = createTransport(implementation, { maxAttempts: 3 });

    await expect(
      transport.request(
        { route: 'patient', params: { orgUuid: 'org-1', patientId: '1001' } },
        bodySchema,
      ),
    ).rejects.toBeInstanceOf(RetryableSyncError);
  });

  it('does not retry a forbidden response, because revoked access will not heal', async () => {
    const { implementation } = scriptedFetch([{ status: 403 }]);
    const { transport, sleep } = createTransport(implementation);

    await expect(
      transport.request(
        { route: 'coverages', params: { orgUuid: 'org-1', patientId: '1001' } },
        bodySchema,
      ),
    ).rejects.toMatchObject({ code: 'pcc_access_forbidden' });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('refreshes the token once on 401, then treats a repeat as an authorisation failure', async () => {
    const { implementation, requests } = scriptedFetch([
      { status: 401 },
      { status: 200, body: { patientId: '1001' } },
    ]);
    const { transport, tokenProvider } = createTransport(implementation);

    await transport.request(
      { route: 'patient', params: { orgUuid: 'org-1', patientId: '1001' } },
      bodySchema,
    );

    expect(tokenProvider.invalidations).toBe(1);
    expect(requests[1]!.headers.get('authorization')).toBe('Bearer token-1');

    const second = scriptedFetch([{ status: 401 }, { status: 401 }]);
    const retryTransport = createTransport(second.implementation);

    await expect(
      retryTransport.transport.request(
        { route: 'patient', params: { orgUuid: 'org-1', patientId: '1001' } },
        bodySchema,
      ),
    ).rejects.toBeInstanceOf(PermanentSyncError);
  });

  it('classifies an unparseable body as a permanent failure rather than retrying it', async () => {
    const implementation = vi.fn(
      async () => new Response('<html>gateway</html>', { status: 200 }),
    ) as unknown as typeof fetch;
    const { transport } = createTransport(implementation);

    await expect(
      transport.request(
        { route: 'patient', params: { orgUuid: 'org-1', patientId: '1001' } },
        bodySchema,
      ),
    ).rejects.toMatchObject({ code: 'pcc_invalid_json' });
  });

  /**
   * The resolved URL contains a PCC patient identifier. Logging it would scatter identifiers
   * across a log sink that is usually not treated as a PHI store, so the transport logs the
   * route template instead. This asserts that, because it is the kind of property that quietly
   * regresses the first time someone adds a debug line.
   */
  it('logs the route template and never the resolved patient identifier', async () => {
    const { implementation } = scriptedFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, body: { patientId: 'PATIENT-SECRET-42' } },
    ]);
    const { transport, entries } = createTransport(implementation);

    await transport.request(
      { route: 'patient', params: { orgUuid: 'org-1', patientId: 'PATIENT-SECRET-42' } },
      bodySchema,
    );

    const serialised = JSON.stringify(entries);
    expect(serialised).toContain('"route":"patient"');
    expect(serialised).not.toContain('PATIENT-SECRET-42');
  });
});
