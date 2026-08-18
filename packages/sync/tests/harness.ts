import {
  createLogger,
  createMemorySink,
  fixedClock,
  type Clock,
  type Facility,
  type FacilityContract,
  type LogEntry,
  type Logger,
  type TherapyOrg,
} from '@rehabalpha/core';
import {
  FakePccApi,
  FIXTURE_FERNCREST_FAC_ID,
  FIXTURE_LAKESIDE_FAC_ID,
  FIXTURE_ORG_UUID,
} from '@rehabalpha/pcc-client/testing';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { AuditLog } from '../src/audit.js';
import { SyncEngine } from '../src/engine/sync-engine.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { SyncStore } from '../src/firestore/store.js';
import { WebhookIngest } from '../src/ingest.js';
import { RecordingTaskQueue } from '../src/task-queue.js';
import { SyncWorker } from '../src/worker.js';

export const THERAPY_ORG_ID = 'org_healthpro';
export const FERNCREST_ID = 'fac_ferncrest';
export const LAKESIDE_ID = 'fac_lakeside';

/**
 * A point in time after every fixture event, in a facility's local reckoning still inside the
 * contract window. Coverage closure dates and contract checks are calendar dates in the facility's
 * time zone, so "now" is pinned rather than read from the system clock.
 */
export const NOW = '2026-09-25T15:00:00.000Z';

export type Harness = {
  db: Firestore;
  store: SyncStore;
  pcc: FakePccApi;
  engine: SyncEngine;
  worker: SyncWorker;
  ingest: WebhookIngest;
  queue: RecordingTaskQueue;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  logs: LogEntry[];
  reset(): Promise<void>;
  dispose(): Promise<void>;
};

let appCounter = 0;

/**
 * Wires the real engine against the Firestore emulator and a programmable PointClickCare.
 *
 * There is deliberately no in-memory Firestore here. The behaviour these tests are for *is*
 * Firestore behaviour — transaction semantics, the thirty-value ceiling on an `in` clause, whether
 * a converter rejects a document written by an older schema — and a hand-written fake agrees with
 * whatever its author believed, which is the belief under test.
 *
 * Each suite gets its own emulator project, keyed by `namespace`. Test files run in parallel
 * workers, and the per-test wipe is a whole-database delete, so a shared project means one file
 * clearing the ground out from under another — which surfaces as a transaction failing on a document
 * that existed a moment ago, in whichever file happened to lose the race.
 */
export async function createHarness(options: {
  namespace: string;
  now?: string;
}): Promise<Harness> {
  if (process.env['FIRESTORE_EMULATOR_HOST'] === undefined) {
    throw new Error(
      'These tests require the Firestore emulator. Run them through `npm run test:emulator`.',
    );
  }

  appCounter += 1;
  const projectId = `demo-${options.namespace}`;
  const app: App = initializeApp({ projectId }, `harness-${options.namespace}-${appCounter}`);

  const db = getFirestore(app);
  const store = new SyncStore(db);
  const clock = fixedClock(options.now ?? NOW);
  const { sink, entries } = createMemorySink();
  const logger = createLogger({ service: 'sync-test' }, sink);
  const audit = new AuditLog(store, clock, 'sync-test');
  const pcc = new FakePccApi();
  const deps = { store, pcc, clock, logger, audit };
  const engine = new SyncEngine(deps);
  const queue = new RecordingTaskQueue();

  return {
    db,
    store,
    pcc,
    engine,
    worker: new SyncWorker({ engine, store, audit, clock, logger }),
    ingest: new WebhookIngest(store, queue, clock, logger),
    queue,
    audit,
    clock,
    logger,
    logs: entries,
    async reset() {
      await clearFirestore(projectId);
      await seedTenant(store);
      pcc.reset();
      queue.reset();
      entries.length = 0;
    },
    async dispose() {
      await deleteApp(app);
    },
  };
}

/**
 * The emulator's REST clear endpoint, rather than deleting documents one by one.
 *
 * Recursive deletes through the SDK are slow enough to dominate a suite's runtime, and they leave
 * behind anything a test wrote to a collection the helper did not know about — which is exactly the
 * kind of leakage that produces a test that passes alone and fails in a run.
 */
async function clearFirestore(projectId: string): Promise<void> {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );

  if (!response.ok) {
    throw new Error(`Failed to clear the Firestore emulator: ${response.status}`);
  }
}

export function ferncrest(): Facility {
  return {
    id: FERNCREST_ID,
    therapyOrgId: THERAPY_ORG_ID,
    name: 'Ferncrest Skilled Nursing Facility',
    timeZone: 'America/New_York',
    pcc: { orgUuid: FIXTURE_ORG_UUID, facId: FIXTURE_FERNCREST_FAC_ID },
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

export function lakeside(): Facility {
  return {
    id: LAKESIDE_ID,
    therapyOrgId: THERAPY_ORG_ID,
    name: 'Lakeside Senior Living',
    timeZone: 'America/New_York',
    pcc: { orgUuid: FIXTURE_ORG_UUID, facId: FIXTURE_LAKESIDE_FAC_ID },
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

export function contract(overrides: Partial<FacilityContract> = {}): FacilityContract {
  return {
    id: `ctr_${overrides.facilityId ?? FERNCREST_ID}`,
    therapyOrgId: THERAPY_ORG_ID,
    facilityId: FERNCREST_ID,
    disciplines: ['PT', 'OT', 'SLP'],
    effectiveFrom: '2026-06-01',
    effectiveTo: null,
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

export async function seedTenant(store: SyncStore): Promise<void> {
  const org: TherapyOrg = {
    id: THERAPY_ORG_ID,
    legalName: 'HealthPRO Rehabilitation Services LLC',
    displayName: 'HealthPRO Rehab',
    status: 'active',
    createdAt: '2026-05-01T00:00:00.000Z',
  };

  await store.therapyOrgs().doc(org.id).set(org);
  await store.facilities().doc(FERNCREST_ID).set(ferncrest());
  await store.facilities().doc(LAKESIDE_ID).set(lakeside());
  await store.facilityContracts().doc(`ctr_${FERNCREST_ID}`).set(contract());
  await store
    .facilityContracts()
    .doc(`ctr_${LAKESIDE_ID}`)
    .set(contract({ facilityId: LAKESIDE_ID, effectiveFrom: '2026-07-15' }));
}

export async function countDocuments(db: Firestore, collection: string): Promise<number> {
  const snapshot = await db.collection(collection).count().get();
  return snapshot.data().count;
}

export async function auditActions(db: Firestore): Promise<string[]> {
  const snapshot = await db.collection(COLLECTIONS.auditEvents).get();
  return snapshot.docs.map((doc) => String(doc.get('action'))).sort();
}
