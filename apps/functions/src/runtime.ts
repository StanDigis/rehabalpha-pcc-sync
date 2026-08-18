import { fixedClock, type Clock } from '@rehabalpha/core';
import type { SecretStore } from '@rehabalpha/pcc-client';
import { AuditLog, SyncStore, WebhookIngest, type TaskQueue } from '@rehabalpha/sync';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getConfig, type FunctionsConfig } from './config.js';
import { createServiceLogger } from './pcc/factory.js';
import { createSecretStore } from './pcc/secret-store.js';
import { CloudTasksQueue, InlineTaskQueue } from './queue/cloud-tasks-queue.js';
import { processSyncTask } from './handlers/sync-worker.js';

export type Runtime = {
  config: FunctionsConfig;
  db: Firestore;
  store: SyncStore;
  clock: Clock;
  queue: TaskQueue;
  ingest: WebhookIngest;
  audit: AuditLog;
  secretStore: SecretStore;
};

let app: App | undefined;

function adminApp(): App {
  if (app !== undefined) return app;
  app = getApps()[0] ?? initializeApp();
  return app;
}

export function getDb(): Firestore {
  return getFirestore(adminApp());
}

/** Wires the shared runtime graph used by every HTTP handler and scheduled job. */
export function createRuntime(
  options: {
    config?: FunctionsConfig;
    clock?: Clock;
    queue?: TaskQueue;
    secretStore?: SecretStore;
  } = {},
): Runtime {
  const config = options.config ?? getConfig();
  const db = getDb();
  const store = new SyncStore(db);
  const clock = options.clock ?? fixedClock(new Date().toISOString());
  const logger = createServiceLogger('sync-functions');
  const audit = new AuditLog(store, clock, 'sync-functions');
  const secretStore = options.secretStore ?? createSecretStore();

  const queue =
    options.queue ??
    (process.env['FIRESTORE_EMULATOR_HOST'] !== undefined
      ? new InlineTaskQueue(async (task) => {
          await processSyncTask(task, { config, store, clock, audit, secretStore });
        })
      : new CloudTasksQueue(config));

  const ingest = new WebhookIngest(store, queue, clock, logger);

  return { config, db, store, clock, queue, ingest, audit, secretStore };
}
