import {
  backoffDelayMs,
  classifyFailure,
  redactFreeText,
  type Clock,
  type Logger,
  type SyncDeadLetter,
  type SyncEvent,
  type SyncTask,
} from '@rehabalpha/core';
import type { AuditLog } from './audit.js';
import type { SyncEngine } from './engine/sync-engine.js';
import type { SyncOutcome } from './engine/context.js';
import { COLLECTIONS } from './firestore/collections.js';
import type { SyncStore } from './firestore/store.js';
import type { TaskQueue } from './task-queue.js';

export type WorkerResult =
  | { status: 'applied'; outcomes: SyncOutcome[] }
  | { status: 'skipped'; reason: string }
  /** Transient failure with attempts left. The caller decides how to schedule the retry. */
  | { status: 'retry'; delayMs: number; code: string }
  | { status: 'deadLettered'; deadLetterId: string; code: string };

export type SyncWorkerDeps = {
  engine: SyncEngine;
  store: SyncStore;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  maxAttempts?: number;
};

const DEFAULT_MAX_ATTEMPTS = 6;

export class SyncWorker {
  private readonly maxAttempts: number;

  constructor(private readonly deps: SyncWorkerDeps) {
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Runs one unit of work and decides what happens to it on failure.
   *
   * The retryable/permanent split is what keeps the queue honest. Retrying a permanent failure —
   * a validation error, a revoked consent — burns the organisation's PCC rate budget and hides a
   * real defect behind a queue that only looks busy. Dead-lettering a transient failure hands an
   * operator a chart that would have healed itself, and after a PCC incident there are thousands of
   * them. So the classification happens where the error is raised, and this method only routes.
   */
  async process(task: SyncTask): Promise<WorkerResult> {
    const logger = this.deps.logger.child({
      therapyOrgId: task.therapyOrgId,
      ...(task.causedByEventId !== null ? { correlationId: task.causedByEventId } : {}),
    });

    try {
      const outcomes = await this.deps.engine.handleTask(task);
      await this.markEvent(task, outcomes);

      const skipped = outcomes.every((outcome) => !outcome.applied);
      return skipped
        ? { status: 'skipped', reason: outcomes[0]?.decision ?? 'contentUnchanged' }
        : { status: 'applied', outcomes };
    } catch (error) {
      const failure = classifyFailure(error);

      if (failure.kind === 'retryable' && task.attempt < this.maxAttempts) {
        const delayMs = backoffDelayMs(task.attempt, {}, failure.retryAfterMs);
        logger.warn('Sync task failed transiently; will retry', {
          entityType: task.entityType,
          attempt: task.attempt,
          code: failure.code,
          delayMs,
        });
        return { status: 'retry', delayMs, code: failure.code };
      }

      const deadLetterId = await this.deadLetter(task, failure);
      logger.error('Sync task dead-lettered', {
        entityType: task.entityType,
        attempt: task.attempt,
        code: failure.code,
        kind: failure.kind,
        deadLetterId,
      });

      return { status: 'deadLettered', deadLetterId, code: failure.code };
    }
  }

  private async markEvent(task: SyncTask, outcomes: SyncOutcome[]): Promise<void> {
    if (task.causedByEventId === null) return;

    const applied = outcomes.some((outcome) => outcome.applied);
    const skipReason = outcomes.find((outcome) => !outcome.applied)?.decision;

    await this.updateEvent(task.causedByEventId, {
      status: applied ? 'applied' : 'skipped',
      attempts: task.attempt,
      completedAt: this.deps.clock.now(),
      ...(applied ? {} : { skipReason: mapSkipReason(skipReason) }),
    });
  }

  /**
   * Updates the delivery record, tolerating its absence.
   *
   * `update` rather than a merging `set`, because the envelope has a ninety-day TTL and a replay
   * requested after that window has no envelope to close out. A merging set would create a stub
   * document holding a status and nothing else, which then fails validation the next time the
   * console lists recent deliveries — a stale write turning into a broken screen.
   */
  private async updateEvent(eventId: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.store.db.collection(COLLECTIONS.syncEvents).doc(eventId).update(fields);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.deps.logger.info('Delivery record already expired; nothing to close out', {
        correlationId: eventId,
      });
    }
  }

  private async deadLetter(
    task: SyncTask,
    failure: { kind: 'retryable' | 'permanent'; code: string; message: string },
  ): Promise<string> {
    const now = this.deps.clock.now();
    // Deterministic id so a replay that fails again updates the same record instead of leaving a
    // growing pile of near-identical entries for the same underlying problem.
    const id = `${task.taskId}__${task.entityType}`;
    const ref = this.deps.store.syncDeadLetters().doc(id);

    const existing = await ref.get();
    const firstFailedAt = existing.exists ? existing.data()!.failure.firstFailedAt : now;

    const record: SyncDeadLetter = {
      id,
      therapyOrgId: task.therapyOrgId,
      facilityId: null,
      entityType: task.entityType,
      entityPccId: task.entityPccId,
      task,
      failure: {
        kind: failure.kind,
        code: failure.code,
        // Upstream errors occasionally echo request data back, so the message is scrubbed before it
        // is stored in a collection that operators browse freely. Key-based redaction is no help
        // here: the whole thing is one string, and the key is inside it.
        message: redactFreeText(failure.message),
        attempts: task.attempt,
        firstFailedAt,
        lastFailedAt: now,
      },
      status: 'open',
      resolution: null,
    };

    await ref.set(record);

    if (task.causedByEventId !== null) {
      await this.updateEvent(task.causedByEventId, {
        status: 'deadLettered',
        attempts: task.attempt,
        completedAt: now,
      });
    }

    await this.deps.audit.record(
      this.deps.audit.system({
        therapyOrgId: task.therapyOrgId,
        facilityId: null,
        action: 'sync.deadLettered',
        target: { type: 'syncDeadLetter', id },
        outcome: 'failure',
        correlationId: task.causedByEventId,
        detail: { entityType: task.entityType, code: failure.code, attempts: task.attempt },
      }),
    );

    return id;
  }
}

/** Firestore signals an update against a missing document with gRPC status 5. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 5
  );
}

function mapSkipReason(decision: string | undefined): SyncEvent['skipReason'] {
  switch (decision) {
    case 'staleWatermark':
    case 'contentUnchanged':
    case 'contractInactive':
      return decision;
    default:
      return null;
  }
}

export type ReplayResult = { status: 'replayed'; taskId: string } | { status: 'notFound' };

/**
 * Re-runs a dead-lettered unit of work at an operator's request.
 *
 * The stored task is replayed rather than reconstructed, which is why the dead-letter record keeps
 * the whole envelope. Reconstructing it from the entity id would quietly change the work: the
 * original reason, the correlation id that ties it to the PCC delivery, and the scope would all be
 * guessed, and the replay would no longer be the thing that failed.
 *
 * `attempt` resets to 1 so the replay gets a full retry budget: whatever the operator fixed —
 * re-authorising a connection, correcting a record in PCC — may need more than one attempt.
 */
export async function replayDeadLetter(
  deps: { store: SyncStore; queue: TaskQueue; clock: Clock; audit: AuditLog },
  input: { therapyOrgId: string; deadLetterId: string; actorUid: string; note: string },
): Promise<ReplayResult> {
  const ref = deps.store.syncDeadLetters().doc(input.deadLetterId);
  const snapshot = await ref.get();
  const record = snapshot.exists ? snapshot.data()! : null;

  // Tenant is checked here as well as in the rules: this runs with admin credentials, so the rules
  // are not in the path and the check has to exist in the code that does the work.
  if (record === null || record.therapyOrgId !== input.therapyOrgId) {
    return { status: 'notFound' };
  }

  const now = deps.clock.now();
  const task = { ...record.task, attempt: 1, enqueuedAt: now };

  await ref.update({
    status: 'replaying',
    resolution: { byUid: input.actorUid, at: now, note: input.note },
  });

  // No dedupe key: the operator is explicitly asking for this to run again, and the original key
  // would be suppressed by the queue's deduplication window.
  await deps.queue.enqueue(task);

  await deps.audit.record({
    therapyOrgId: input.therapyOrgId,
    facilityId: record.facilityId,
    actor: { kind: 'user', uid: input.actorUid, service: null },
    action: 'sync.deadLetterReplayed',
    target: { type: 'syncDeadLetter', id: input.deadLetterId },
    outcome: 'success',
    correlationId: record.task.causedByEventId,
    detail: { entityType: record.entityType, note: input.note },
  });

  return { status: 'replayed', taskId: task.taskId };
}
