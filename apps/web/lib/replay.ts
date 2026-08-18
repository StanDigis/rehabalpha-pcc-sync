import { createLogger, createMemorySink, fixedClock } from '@rehabalpha/core';
import { FakePccApi } from '@rehabalpha/pcc-client/testing';
import {
  AuditLog,
  InlineTaskQueue,
  SyncEngine,
  SyncWorker,
  replayDeadLetter,
  type TaskQueue,
} from '@rehabalpha/sync';
import { getStore } from './store';

const clock = fixedClock(process.env['SEED_NOW'] ?? '2026-09-25T15:00:00.000Z');
const { sink } = createMemorySink();
const baseLogger = createLogger({ service: 'ops-console' }, sink);

let pcc: FakePccApi | undefined;
let queue: TaskQueue | undefined;

function getPcc(): FakePccApi {
  pcc ??= new FakePccApi();
  return pcc;
}

function getWorkerDeps() {
  const store = getStore();
  const audit = new AuditLog(store, clock, 'ops-console');
  const engine = new SyncEngine({
    store,
    pcc: getPcc(),
    clock,
    logger: baseLogger,
    audit,
  });
  const worker = new SyncWorker({
    engine,
    store,
    audit,
    clock,
    logger: baseLogger,
  });
  return { store, audit, worker };
}

function getQueue(): TaskQueue {
  if (queue !== undefined) return queue;

  const { worker } = getWorkerDeps();
  queue = new InlineTaskQueue(async (task) => {
    await worker.process(task);
  });

  return queue;
}

export async function replayDeadLetterFromConsole(input: {
  therapyOrgId: string;
  deadLetterId: string;
  actorUid: string;
  note: string;
}) {
  const store = getStore();
  const audit = new AuditLog(store, clock, 'ops-console');

  return replayDeadLetter({ store, queue: getQueue(), clock, audit }, input);
}

export function resetReplayRuntimeForTests(): void {
  pcc = undefined;
  queue = undefined;
}
