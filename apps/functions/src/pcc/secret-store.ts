import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { InMemorySecretStore, type SecretStore } from '@rehabalpha/pcc-client';

/**
 * Reads and writes OAuth material through Secret Manager.
 *
 * Firestore holds only the resource name; the ciphertext never enters the database, a backup export,
 * or a security rule evaluation. `write` exists because three-legged refresh tokens rotate on every
 * exchange, and dropping the new one strands the connection at the next refresh.
 */
export class GcpSecretStore implements SecretStore {
  constructor(private readonly client = new SecretManagerServiceClient()) {}

  async read(name: string): Promise<string> {
    const [version] = await this.client.accessSecretVersion({ name });
    const payload = version.payload?.data;
    if (payload === undefined || payload === null) {
      throw new Error(`Secret ${name} returned no payload`);
    }
    return typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
  }

  async write(name: string, value: string): Promise<string> {
    const parent = secretParentFromVersionName(name);
    const [version] = await this.client.addSecretVersion({
      parent,
      payload: { data: Buffer.from(value, 'utf8') },
    });
    return version.name ?? `${parent}/versions/latest`;
  }
}

function secretParentFromVersionName(name: string): string {
  const marker = '/versions/';
  const index = name.indexOf(marker);
  return index === -1 ? name : name.slice(0, index);
}

/** Emulator and tests: secrets are seeded in memory rather than fetched from GCP. */
export function createSecretStore(): SecretStore {
  if (process.env['FIRESTORE_EMULATOR_HOST'] !== undefined) {
    return new InMemorySecretStore({
      'projects/demo/secrets/pcc-oauth-client-secret/versions/latest': 'fixture-client-secret',
      'projects/demo/secrets/pcc-refresh-token/versions/3': 'fixture-refresh-token',
    });
  }
  return new GcpSecretStore();
}
