import {
  authClaimsSchema,
  permissionsFor,
  syncTaskSchema,
  type Clock,
  type Role,
  type SyncTask,
} from '@rehabalpha/core';
import type { SecretStore } from '@rehabalpha/pcc-client';
import {
  SyncEngine,
  SyncWorker,
  replayDeadLetter,
  type AuditLog,
  type SyncStore,
  type TaskQueue,
} from '@rehabalpha/sync';
import type { FunctionsConfig } from '../config.js';
import { createPccApiForConnection, createServiceLogger } from '../pcc/factory.js';

export type WorkerDeps = {
  config: FunctionsConfig;
  store: SyncStore;
  clock: Clock;
  audit: AuditLog;
  secretStore: SecretStore;
  queue?: TaskQueue;
};

/** Runs one unit of sync work with the PCC client bound to the tenant's connection. */
export async function processSyncTask(task: SyncTask, deps: WorkerDeps) {
  const parsed = syncTaskSchema.parse(task);
  const logger = createServiceLogger('sync-worker').child({
    therapyOrgId: parsed.therapyOrgId,
    ...(parsed.causedByEventId !== null ? { correlationId: parsed.causedByEventId } : {}),
  });

  const connection = await deps.store.findConnectionByPccOrg(parsed.pccOrgUuid);
  if (connection === null) {
    throw new Error(`No PCC connection for organisation ${parsed.pccOrgUuid}`);
  }

  const pcc = await createPccApiForConnection(connection, {
    config: deps.config,
    secretStore: deps.secretStore,
    logger,
    clock: deps.clock,
  });

  const engine = new SyncEngine({
    store: deps.store,
    pcc,
    clock: deps.clock,
    logger,
    audit: deps.audit,
  });
  const worker = new SyncWorker({
    engine,
    store: deps.store,
    audit: deps.audit,
    clock: deps.clock,
    logger,
  });

  const result = await worker.process(parsed);

  if (result.status === 'retry' && deps.queue !== undefined) {
    await deps.queue.enqueue(
      { ...parsed, attempt: parsed.attempt + 1, enqueuedAt: deps.clock.now() },
      { delayMs: result.delayMs },
    );
  }

  return result;
}

export type ReplayInput = {
  therapyOrgId: string;
  deadLetterId: string;
  actorUid: string;
  note: string;
};

export async function replayDeadLetterForOperator(input: ReplayInput, deps: WorkerDeps) {
  if (deps.queue === undefined) {
    throw new Error('replay requires a task queue');
  }

  return replayDeadLetter(
    { store: deps.store, queue: deps.queue, clock: deps.clock, audit: deps.audit },
    input,
  );
}

export type OperatorIdentity = {
  uid: string;
  therapyOrgId: string;
  roles: readonly string[];
  grantVersion: number;
};

/** Verifies a Firebase ID token and loads the grant document the security rules also consult. */
export async function resolveOperator(
  store: SyncStore,
  token: string | undefined,
): Promise<OperatorIdentity | null> {
  if (token === undefined || token === '') return null;

  const { getAuth } = await import('firebase-admin/auth');
  const decoded = await getAuth().verifyIdToken(token);
  const claims = authClaimsSchema.safeParse(decoded);
  if (!claims.success) return null;

  const grantSnapshot = await store.userGrants().doc(decoded.uid).get();
  if (!grantSnapshot.exists) return null;
  const data = grantSnapshot.data();
  if (data === undefined || data.status !== 'active') return null;
  if (data.grantVersion !== claims.data.grantVersion) return null;

  return {
    uid: decoded.uid,
    therapyOrgId: claims.data.therapyOrgId,
    roles: claims.data.roles,
    grantVersion: claims.data.grantVersion,
  };
}

export function operatorMayReplay(operator: OperatorIdentity, therapyOrgId: string): boolean {
  if (operator.therapyOrgId !== therapyOrgId) return false;
  return permissionsFor(operator.roles as Role[]).has('deadLetter:replay');
}
