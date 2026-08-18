import { fixedClock, type PccConnection, type TherapyOrg } from '@rehabalpha/core';
import { InMemorySecretStore } from '@rehabalpha/pcc-client';
import { FakePccApi } from '@rehabalpha/pcc-client/testing';
import type { SyncStore, TaskQueue } from '@rehabalpha/sync';
import type { SyncTask } from '@rehabalpha/core';
import type { EnqueueOptions } from '@rehabalpha/sync';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { loadConfig, resetConfigForTests, type FunctionsConfig } from '../src/config.js';
import { processSyncTask, type WorkerDeps } from '../src/handlers/sync-worker.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

export const THERAPY_ORG_ID = 'org_healthpro';
export const FERNCREST_ID = 'fac_ferncrest';
export const FIXTURE_ORG_UUID = 'a7f1c2d4-9b3e-4c81-8f27-5d6a0e1b3c94';
export const FIXTURE_FERNCREST_FAC_ID = '22';
export const BETTY_PCC_PATIENT_ID = '1001';
export const NOW = '2026-09-25T15:00:00.000Z';

/** Records what was enqueued and runs the worker inline, like the emulator wiring does. */
class RecordingInlineQueue implements TaskQueue {
  readonly enqueued: { task: SyncTask; options: EnqueueOptions }[] = [];

  constructor(private readonly deps: () => WorkerDeps) {}

  async enqueue(task: SyncTask, options: EnqueueOptions = {}): Promise<void> {
    this.enqueued.push({ task, options });
    const deps = this.deps();
    await processSyncTask(task, { ...deps, queue: this });
  }

  reset(): void {
    this.enqueued.length = 0;
  }
}

export type Harness = {
  runtime: Runtime;
  db: Firestore;
  store: SyncStore;
  queue: RecordingInlineQueue;
  pcc: FakePccApi;
  config: FunctionsConfig;
  reset(): Promise<void>;
  dispose(): Promise<void>;
};

let appCounter = 0;

export async function createHarness(): Promise<Harness> {
  if (process.env['FIRESTORE_EMULATOR_HOST'] === undefined) {
    throw new Error('Functions tests require the Firestore emulator.');
  }

  resetConfigForTests();
  process.env['PCC_TRANSPORT'] = 'fixture';

  appCounter += 1;
  const projectId = `demo-functions-${appCounter}`;
  const app: App = initializeApp({ projectId }, `functions-harness-${appCounter}`);
  const db = getFirestore(app);
  const config = loadConfig();
  const clock = fixedClock(NOW);
  const secretStore = new InMemorySecretStore();
  const pcc = new FakePccApi();

  const holder: { runtime?: Runtime; queue?: RecordingInlineQueue } = {};

  const queue = new RecordingInlineQueue(() => ({
    config,
    store: holder.runtime!.store,
    clock,
    audit: holder.runtime!.audit,
    secretStore,
    queue: holder.queue!,
  }));

  holder.queue = queue;
  const runtime = createRuntime({ config, clock, queue, secretStore });
  holder.runtime = runtime;

  return {
    runtime,
    db,
    store: runtime.store,
    queue,
    pcc,
    config,
    async reset() {
      await clearFirestore(projectId);
      await seedTenant(runtime.store);
      pcc.reset();
      queue.reset();
    },
    async dispose() {
      await deleteApp(app);
    },
  };
}

async function clearFirestore(projectId: string): Promise<void> {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`Failed to clear emulator: ${response.status}`);
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
  await store
    .facilities()
    .doc(FERNCREST_ID)
    .set({
      id: FERNCREST_ID,
      therapyOrgId: THERAPY_ORG_ID,
      name: 'Ferncrest Skilled Nursing Facility',
      timeZone: 'America/New_York',
      pcc: { orgUuid: FIXTURE_ORG_UUID, facId: FIXTURE_FERNCREST_FAC_ID },
      createdAt: '2026-06-01T00:00:00.000Z',
    });
  await store
    .facilityContracts()
    .doc(`ctr_${FERNCREST_ID}`)
    .set({
      id: `ctr_${FERNCREST_ID}`,
      therapyOrgId: THERAPY_ORG_ID,
      facilityId: FERNCREST_ID,
      disciplines: ['PT', 'OT', 'SLP'],
      effectiveFrom: '2026-06-01',
      effectiveTo: null,
      status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

  const connection: PccConnection = {
    id: 'conn_healthpro_pcc',
    therapyOrgId: THERAPY_ORG_ID,
    pccOrgUuid: FIXTURE_ORG_UUID,
    authMode: 'threeLegged',
    credentialSecretName: 'projects/demo/secrets/pcc-refresh-token/versions/3',
    activatedFacilityIds: [FIXTURE_FERNCREST_FAC_ID],
    consent: {
      status: 'granted',
      grantedBySubjectHash: 'sha256:demo',
      grantedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: null,
    },
    scopes: ['patient.read', 'adt.read', 'coverage.read'],
    status: 'healthy',
    lastVerifiedAt: NOW,
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  await store.pccConnections().doc(connection.id).set(connection);
}

export function mockResponse() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    send(payload: unknown) {
      state.body = payload;
      return this;
    },
    get state() {
      return state;
    },
  };
}

export function mockRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    body,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}
