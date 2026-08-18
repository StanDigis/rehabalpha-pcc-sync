import { createLogger, type Clock, type Logger, type PccConnection } from '@rehabalpha/core';
import { FakePccApi } from '@rehabalpha/pcc-client/testing';
import {
  DEFAULT_BASE_URL,
  DEFAULT_PATH_PREFIX,
  DEFAULT_TOKEN_URL,
  HttpPccTransport,
  PccClient,
  ThreeLeggedTokenProvider,
  TokenBucketRateLimiter,
  TwoLeggedTokenProvider,
  type PccApi,
  type SecretStore,
} from '@rehabalpha/pcc-client';
import type { FunctionsConfig } from '../config.js';

/**
 * Builds the PointClickCare client for one connection.
 *
 * `fixture` mode exists so a developer machine and CI never reach the real API by accident. In
 * production every task gets an HTTP transport backed by that connection's OAuth mode and the
 * shared client credentials in Secret Manager.
 */
export async function createPccApiForConnection(
  connection: PccConnection,
  input: {
    config: FunctionsConfig;
    secretStore: SecretStore;
    logger: Logger;
    clock?: Clock;
  },
): Promise<PccApi> {
  if (input.config.pccTransport === 'fixture') {
    return new FakePccApi();
  }

  const clientSecret = await input.secretStore.read(input.config.pccClientSecretName);
  const epochNow = () => (input.clock !== undefined ? Date.parse(input.clock.now()) : Date.now());

  const tokenProvider =
    connection.authMode === 'threeLegged'
      ? new ThreeLeggedTokenProvider({
          tokenUrl: input.config.pccTokenUrl ?? DEFAULT_TOKEN_URL,
          clientId: input.config.pccClientId,
          clientSecret,
          scopes: connection.scopes,
          refreshTokenSecretName: connection.credentialSecretName,
          secretStore: input.secretStore,
          logger: input.logger,
          now: epochNow,
        })
      : new TwoLeggedTokenProvider({
          tokenUrl: input.config.pccTokenUrl ?? DEFAULT_TOKEN_URL,
          clientId: input.config.pccClientId,
          clientSecret,
          scopes: connection.scopes,
          logger: input.logger,
          now: epochNow,
        });

  const transport = new HttpPccTransport({
    baseUrl: input.config.pccBaseUrl ?? DEFAULT_BASE_URL,
    pathPrefix: input.config.pccPathPrefix ?? DEFAULT_PATH_PREFIX,
    tokenProvider,
    rateLimiter: new TokenBucketRateLimiter({ capacity: 50, refillPerSecond: 10 }),
    logger: input.logger,
  });

  return new PccClient(transport, input.logger);
}

export function createServiceLogger(service: string): Logger {
  return createLogger({ service });
}
