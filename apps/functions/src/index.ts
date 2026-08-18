import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { handlePccWebhook } from './handlers/pcc-webhook.js';
import { handleReplayDeadLetter, handleSyncWorker } from './handlers/http.js';
import { runScheduledReconciliation } from './handlers/reconciliation.js';
import { createRuntime } from './runtime.js';

const shared = {
  region: process.env['FUNCTIONS_REGION'] ?? 'us-central1',
  memory: '512MiB' as const,
};

/** PointClickCare webhook ingress — must acknowledge within a few seconds. */
export const pccWebhook = onRequest({ ...shared, timeoutSeconds: 10 }, async (req, res) => {
  await handlePccWebhook(req, res, createRuntime());
});

/** Cloud Tasks worker — re-reads upstream state and writes the chart. */
export const syncWorker = onRequest({ ...shared, timeoutSeconds: 540 }, async (req, res) => {
  await handleSyncWorker(req, res, createRuntime());
});

/** Operator action: replay a dead-lettered task after fixing the underlying problem. */
export const replayDeadLetter = onRequest({ ...shared, timeoutSeconds: 30 }, async (req, res) => {
  await handleReplayDeadLetter(req, res, createRuntime());
});

/** Delta reconciliation every fifteen minutes — cheap enough to run often. */
export const reconciliationDelta = onSchedule(
  { schedule: 'every 15 minutes', ...shared, timeoutSeconds: 540 },
  async () => {
    await runScheduledReconciliation(createRuntime(), 'delta');
  },
);

/** Nightly census — the only path that catches a webhook that was never delivered. */
export const reconciliationCensus = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'America/New_York', ...shared, timeoutSeconds: 540 },
  async () => {
    await runScheduledReconciliation(createRuntime(), 'census');
  },
);
