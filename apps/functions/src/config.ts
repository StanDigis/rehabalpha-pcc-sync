/**
 * Runtime configuration read from environment variables.
 *
 * Nothing here is secret. Credentials live in Secret Manager and are referenced by name from the
 * connection document; putting them in env vars would put them in deploy logs and function configs.
 */
export type FunctionsConfig = {
  projectId: string;
  region: string;
  /** `fixture` for local runs and CI; `http` for a real PCC sandbox or production. */
  pccTransport: 'fixture' | 'http';
  pccBaseUrl: string;
  pccPathPrefix: string;
  pccTokenUrl: string;
  pccClientId: string;
  /** Secret Manager resource name for the OAuth client secret shared across connections. */
  pccClientSecretName: string;
  /** Full URL of the sync worker function — the Cloud Tasks target. */
  syncWorkerUrl: string;
  /** Cloud Tasks queue resource name, e.g. projects/…/locations/…/queues/sync. */
  syncTasksQueue: string;
  /** Service account Cloud Tasks uses to mint an OIDC token when calling the worker. */
  syncTasksInvokerServiceAccount: string;
  /** Optional shared secret PCC sends on webhook deliveries. Unset in emulator only. */
  webhookSharedSecret: string | null;
};

function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

export function loadConfig(): FunctionsConfig {
  const transport = process.env['PCC_TRANSPORT'] === 'fixture' ? 'fixture' : 'http';

  return {
    projectId:
      process.env['GCLOUD_PROJECT'] ??
      process.env['GOOGLE_CLOUD_PROJECT'] ??
      'rehabalpha-pcc-sync-demo',
    region: process.env['FUNCTIONS_REGION'] ?? 'us-central1',
    pccTransport: transport,
    pccBaseUrl: process.env['PCC_BASE_URL'] ?? 'https://connect.pointclickcare.com',
    pccPathPrefix: process.env['PCC_PATH_PREFIX'] ?? '/api/public/preview1',
    pccTokenUrl: process.env['PCC_TOKEN_URL'] ?? 'https://connect.pointclickcare.com/auth/token',
    pccClientId: process.env['PCC_CLIENT_ID'] ?? 'fixture-client',
    pccClientSecretName:
      process.env['PCC_CLIENT_SECRET_NAME'] ??
      'projects/demo/secrets/pcc-oauth-client-secret/versions/latest',
    syncWorkerUrl:
      process.env['SYNC_WORKER_URL'] ??
      `http://127.0.0.1:5001/${process.env['GCLOUD_PROJECT'] ?? 'rehabalpha-pcc-sync-demo'}/${process.env['FUNCTIONS_REGION'] ?? 'us-central1'}/syncWorker`,
    syncTasksQueue:
      process.env['SYNC_TASKS_QUEUE'] ??
      `projects/${process.env['GCLOUD_PROJECT'] ?? 'demo'}/locations/us-central1/queues/sync`,
    syncTasksInvokerServiceAccount:
      process.env['SYNC_TASKS_INVOKER_SA'] ?? 'sync-worker@demo.iam.gserviceaccount.com',
    webhookSharedSecret: optional('PCC_WEBHOOK_SHARED_SECRET'),
  };
}

/** Lazy singleton so cold starts do not re-parse env on every nested import. */
let cached: FunctionsConfig | null = null;

export function getConfig(): FunctionsConfig {
  cached ??= loadConfig();
  return cached;
}

/** Resets the cached config. Tests only. */
export function resetConfigForTests(): void {
  cached = null;
}
