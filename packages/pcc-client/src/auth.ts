import { PermanentSyncError, RetryableSyncError, type Logger } from '@rehabalpha/core';
import { z } from 'zod';

/**
 * Credentials never live in Firestore. A Firestore read, a backup export or one over-broad
 * security rule would otherwise be enough to walk out with an organisation's PCC access. The
 * connection document stores a Secret Manager resource name; this port resolves it.
 *
 * `write` exists because three-legged refresh tokens rotate: PCC may return a new refresh
 * token on every exchange, and dropping it strands the connection at the next refresh.
 */
export interface SecretStore {
  read(name: string): Promise<string>;
  write(name: string, value: string): Promise<string>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(seed)) {
      this.values.set(name, value);
    }
  }

  async read(name: string): Promise<string> {
    const value = this.values.get(name);
    if (value === undefined) {
      throw new PermanentSyncError('secret_not_found', `No secret stored under ${name}`);
    }
    return value;
  }

  async write(name: string, value: string): Promise<string> {
    this.values.set(name, value);
    return `${name}/versions/latest`;
  }
}

export type AccessToken = {
  value: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: readonly string[];
};

export interface TokenProvider {
  get(): Promise<AccessToken>;
  /** Called after a 401 so the next attempt mints a fresh token instead of replaying the stale one. */
  invalidate(): void;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const errorResponseSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/**
 * Refresh this many milliseconds before nominal expiry.
 *
 * A token that expires mid-flight produces a 401 that looks like an authorisation problem, and
 * an operator investigating a burst of them will reasonably suspect revoked consent. Renewing
 * early costs one extra token exchange per hour and removes a whole class of misleading alert.
 */
const EXPIRY_SKEW_MS = 60_000;

export type TokenExchange = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  logger: Logger;
};

async function exchange(
  body: URLSearchParams,
  { tokenUrl, clientId, clientSecret, fetchImpl = fetch, logger }: TokenExchange,
): Promise<z.infer<typeof tokenResponseSchema>> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  const text = await response.text();

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(safeJsonParse(text));
    const code = parsed.success
      ? (parsed.data.error ?? 'token_exchange_failed')
      : 'token_exchange_failed';

    logger.warn('PCC token exchange failed', { status: response.status, code });

    // `invalid_grant` on a refresh means the delegation is gone: the PCC user revoked it, their
    // account was disabled, or the refresh token aged out. Retrying cannot recover it, and
    // treating it as transient would hide a connection that needs a human to re-authorise.
    if (code === 'invalid_grant' || response.status === 400 || response.status === 403) {
      throw new PermanentSyncError(
        'pcc_authorization_revoked',
        `PCC refused the credential exchange (${code})`,
      );
    }

    if (response.status === 401) {
      throw new PermanentSyncError(
        'pcc_credentials_rejected',
        'PCC rejected the client credentials',
      );
    }

    throw new RetryableSyncError(
      'token_exchange_unavailable',
      `PCC token endpoint returned ${response.status}`,
      readRetryAfterMs(response),
    );
  }

  return tokenResponseSchema.parse(safeJsonParse(text));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function readRetryAfterMs(response: { headers: Headers }): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Caches a token and collapses concurrent refreshes into one exchange.
 *
 * Without the single-flight guard, a burst of queued tasks waking up against an expired token
 * fires one exchange per task. That is a self-inflicted spike against the endpoint most likely
 * to rate-limit us, at the exact moment we are trying to recover.
 */
abstract class CachingTokenProvider implements TokenProvider {
  private cached: AccessToken | null = null;
  private inFlight: Promise<AccessToken> | null = null;

  protected constructor(private readonly now: () => number = Date.now) {}

  protected abstract mint(): Promise<AccessToken>;

  async get(): Promise<AccessToken> {
    const cached = this.cached;
    if (cached !== null && cached.expiresAt - EXPIRY_SKEW_MS > this.now()) {
      return cached;
    }

    this.inFlight ??= this.mint()
      .then((token) => {
        this.cached = token;
        return token;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export type TwoLeggedOptions = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * System-to-system credentials: no PCC user is involved and the sync runs unattended.
 * Operationally the simplest mode, and the one where a leaked secret exposes the entire
 * organisation — which is why the secret is only ever read from Secret Manager and never
 * logged, cached to disk, or included in an error message.
 */
export class TwoLeggedTokenProvider extends CachingTokenProvider {
  constructor(private readonly options: TwoLeggedOptions) {
    super(options.now);
  }

  protected async mint(): Promise<AccessToken> {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.options.scopes.length > 0) {
      body.set('scope', this.options.scopes.join(' '));
    }

    const response = await exchange(body, {
      tokenUrl: this.options.tokenUrl,
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      logger: this.options.logger,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    return toAccessToken(response, this.options.scopes, this.options.now?.() ?? Date.now());
  }
}

export type ThreeLeggedOptions = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Secret Manager name holding the current refresh token for this connection. */
  refreshTokenSecretName: string;
  secretStore: SecretStore;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * User-delegated access. PointClickCare has been moving marketplace partners onto this model,
 * and it changes the integration's failure modes in ways that have to be designed for rather
 * than discovered:
 *
 *   - Access is bounded by what the authorising PCC user may see, so an incomplete census can
 *     be a permissions artefact rather than a bug. The reconciliation report has to be able to
 *     say "this is all we were shown", not just "this is everything".
 *   - Consent is revocable at any moment, and revocation arrives as a 403 or an
 *     `invalid_grant`, not as a notification. The connection is marked disconnected and an
 *     operator is alerted; the sync must not sit in a retry loop pretending it is transient.
 *   - Refresh tokens rotate, so a successful exchange has to persist the new one before the
 *     old one is discarded.
 */
export class ThreeLeggedTokenProvider extends CachingTokenProvider {
  constructor(private readonly options: ThreeLeggedOptions) {
    super(options.now);
  }

  protected async mint(): Promise<AccessToken> {
    const refreshToken = await this.options.secretStore.read(this.options.refreshTokenSecretName);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await exchange(body, {
      tokenUrl: this.options.tokenUrl,
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      logger: this.options.logger,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    if (response.refresh_token !== undefined && response.refresh_token !== refreshToken) {
      await this.options.secretStore.write(
        this.options.refreshTokenSecretName,
        response.refresh_token,
      );
      this.options.logger.info('Rotated PCC refresh token', {
        secretName: this.options.refreshTokenSecretName,
      });
    }

    return toAccessToken(response, this.options.scopes, this.options.now?.() ?? Date.now());
  }
}

function toAccessToken(
  response: z.infer<typeof tokenResponseSchema>,
  requestedScopes: readonly string[],
  now: number,
): AccessToken {
  // PCC is not obliged to return `expires_in`. Assuming a short life is the safe default: a
  // premature refresh costs one request, whereas assuming a long life produces 401 storms.
  const lifetimeSeconds = response.expires_in ?? 300;

  return {
    value: response.access_token,
    expiresAt: now + lifetimeSeconds * 1000,
    scopes: response.scope !== undefined ? response.scope.split(' ') : requestedScopes,
  };
}

/** Fixed token, for fixture-backed local runs and tests. */
export class StaticTokenProvider implements TokenProvider {
  constructor(
    private readonly token = 'fixture-access-token',
    private readonly scopes: readonly string[] = [],
  ) {}

  async get(): Promise<AccessToken> {
    return { value: this.token, expiresAt: Date.now() + 3_600_000, scopes: this.scopes };
  }

  invalidate(): void {}
}
