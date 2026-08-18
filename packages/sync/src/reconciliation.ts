import {
  classifyFailure,
  documentIds,
  type Clock,
  type DriftRecord,
  type Facility,
  type Logger,
  type ReconciliationRun,
  type SyncCursor,
  type SyncTask,
} from '@rehabalpha/core';
import type { PccApi } from '@rehabalpha/pcc-client';
import type { AuditLog } from './audit.js';
import { COLLECTIONS } from './firestore/collections.js';
import type { SyncStore } from './firestore/store.js';
import type { TaskQueue } from './task-queue.js';

export type ReconcilerDeps = {
  store: SyncStore;
  pcc: PccApi;
  queue: TaskQueue;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
};

export type ReconcileInput = {
  therapyOrgId: string;
  pccOrgUuid: string;
  facility: Facility;
  mode: 'delta' | 'census';
  /** Used only when no cursor exists yet. */
  lookbackDays?: number;
};

/**
 * Re-reading a window that has already been covered.
 *
 * PCC's `lastUpdateDatetime` is generated on their side and neither clock is authoritative, so a
 * cursor advanced to exactly the newest value seen will eventually skip a record written in the
 * same second by a slower node. Fifteen minutes of overlap is cheap — the delta pull returns almost
 * nothing for records that have not changed, and the watermark policy turns a re-read of unchanged
 * data into a no-op write — and it removes a class of permanently-missed updates that is close to
 * impossible to notice.
 */
const CURSOR_OVERLAP_MS = 15 * 60 * 1000;

const DEFAULT_LOOKBACK_DAYS = 7;

/** Three consecutive failures is where a transient blip stops being a blip. */
const FAILING_THRESHOLD = 3;

/**
 * The safety net under the webhooks.
 *
 * Webhook delivery is best-effort in practice: subscriptions get deactivated during PCC
 * maintenance, our endpoint has a bad deploy, a message is dropped. None of those are visible from
 * the inside — a chart that never received an update looks exactly like a chart that did not
 * change. So there is a second, independent path to the same data, and the two are compared.
 *
 * Two modes, because they answer different questions. The delta pull asks "what changed since the
 * cursor" and is cheap enough to run every few minutes. The census asks "does our copy of this
 * facility agree with PCC's" and is expensive, so it runs nightly. The census is the only thing
 * that catches a record that was never delivered at all, because a record that was missed has no
 * modification since the cursor either.
 */
export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  async run(input: ReconcileInput): Promise<ReconciliationRun> {
    const startedAt = this.deps.clock.now();
    const runRef = this.deps.store.reconciliationRuns().doc();
    const logger = this.deps.logger.child({
      therapyOrgId: input.therapyOrgId,
      correlationId: runRef.id,
    });

    const run: ReconciliationRun = {
      id: runRef.id,
      therapyOrgId: input.therapyOrgId,
      facilityId: input.facility.id,
      entityType: 'patient',
      mode: input.mode,
      startedAt,
      finishedAt: null,
      status: 'running',
      counts: {
        examined: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        closed: 0,
        drifted: 0,
        failed: 0,
      },
    };
    await runRef.set(run);

    try {
      const counts =
        input.mode === 'delta'
          ? await this.runDelta(input, runRef.id)
          : await this.runCensus(input, runRef.id);

      const finished: ReconciliationRun = {
        ...run,
        finishedAt: this.deps.clock.now(),
        status: (counts.failed ?? 0) > 0 ? 'partial' : 'succeeded',
        counts: { ...run.counts, ...counts },
      };
      await runRef.set(finished);
      await this.recordCursorSuccess(input);

      logger.info('Reconciliation finished', {
        mode: input.mode,
        facilityId: input.facility.id,
        ...finished.counts,
      });

      return finished;
    } catch (error) {
      const failure = classifyFailure(error);
      const finished: ReconciliationRun = {
        ...run,
        finishedAt: this.deps.clock.now(),
        status: 'failed',
      };
      await runRef.set(finished);
      await this.recordCursorFailure(input);

      logger.error('Reconciliation failed', {
        mode: input.mode,
        facilityId: input.facility.id,
        code: failure.code,
        kind: failure.kind,
      });

      // Rethrown rather than swallowed: the scheduler needs a non-zero exit to alert on, and a
      // sweep that reports success while having read nothing is worse than no sweep at all.
      throw error;
    }
  }

  /**
   * Enqueues a refresh for everything PCC says has changed since the cursor.
   *
   * The work is enqueued, not performed here. A facility that comes back from a two-day outage has
   * thousands of changed patients, and doing them inline would run past any function timeout and
   * hammer the PCC rate limit with no backpressure. Through the queue the same backlog drains at a
   * controlled rate, and an individual patient that fails gets the ordinary retry and dead-letter
   * treatment instead of aborting the sweep.
   */
  private async runDelta(
    input: ReconcileInput,
    runId: string,
  ): Promise<Partial<ReconciliationRun['counts']>> {
    const cursor = await this.loadCursor(input);
    const since = cursor.deltaCursor ?? this.defaultSince(input.lookbackDays);
    const from = new Date(Date.parse(since) - CURSOR_OVERLAP_MS).toISOString();

    let examined = 0;
    let newest: string | null = null;

    for await (const patient of this.deps.pcc.listPatients(
      input.pccOrgUuid,
      input.facility.pcc.facId,
      {
        modifiedSince: from,
      },
    )) {
      examined += 1;
      await this.enqueueRefresh(input, runId, patient.patientId, 'reconciliation');

      const modified = patient.lastUpdateDatetime ?? null;
      if (modified !== null && (newest === null || Date.parse(modified) > Date.parse(newest))) {
        newest = new Date(Date.parse(modified)).toISOString();
      }
    }

    // The cursor advances to the newest record actually seen, not to "now". Advancing to now would
    // step over anything PCC had accepted but not yet made visible to the list endpoint.
    await this.deps.store
      .syncCursors()
      .doc(this.cursorId(input))
      .set(
        {
          ...cursor,
          deltaCursor: newest ?? cursor.deltaCursor,
          lastDeltaRunAt: this.deps.clock.now(),
        },
        { merge: true },
      );

    return { examined };
  }

  /**
   * Compares the full facility census with our copy.
   *
   * Reads only the two fields the comparison needs, bypassing the converter to do it. A 200-bed
   * facility means 200 documents of demographics pulled into memory for a job that never looks at a
   * name — slower, and needless PHI in a process that has no use for it.
   *
   * Nothing is deleted. A patient we hold and PCC does not is recorded as drift and left alone: the
   * plausible causes include a PCC-side merge, a scope change, and a bug in this code, and only one
   * of those makes deletion correct. Therapy notes hang off that patient record.
   */
  private async runCensus(
    input: ReconcileInput,
    runId: string,
  ): Promise<Partial<ReconciliationRun['counts']>> {
    const local = new Map<string, string | null>();
    const localSnapshot = await this.deps.store.db
      .collection(COLLECTIONS.patients)
      .where('therapyOrgId', '==', input.therapyOrgId)
      .where('facilityId', '==', input.facility.id)
      .select('pcc.patientId', 'sync.pccLastModified')
      .get();

    for (const doc of localSnapshot.docs) {
      const pccPatientId = doc.get('pcc.patientId');
      if (typeof pccPatientId === 'string') {
        const watermark = doc.get('sync.pccLastModified');
        local.set(pccPatientId, typeof watermark === 'string' ? watermark : null);
      }
    }

    let examined = 0;
    let drifted = 0;
    const seen = new Set<string>();

    for await (const patient of this.deps.pcc.listPatients(
      input.pccOrgUuid,
      input.facility.pcc.facId,
    )) {
      examined += 1;
      seen.add(patient.patientId);

      if (!local.has(patient.patientId)) {
        await this.recordDrift(input, runId, patient.patientId, 'missingLocally', []);
        await this.enqueueRefresh(input, runId, patient.patientId, 'reconciliation');
        drifted += 1;
        continue;
      }

      const ours = local.get(patient.patientId) ?? null;
      const theirs = patient.lastUpdateDatetime ?? null;

      if (ours !== null && theirs !== null && Date.parse(ours) > Date.parse(theirs)) {
        // Our watermark is ahead of the source's, which the sync path cannot produce. Either PCC
        // rewound a timestamp or something wrote to the projection outside the engine. Repairing it
        // would erase the evidence, so it is only reported.
        await this.recordDrift(input, runId, patient.patientId, 'watermarkInversion', [
          'sync.pccLastModified',
        ]);
        drifted += 1;
        continue;
      }

      if (ours === null || (theirs !== null && Date.parse(theirs) > Date.parse(ours))) {
        await this.enqueueRefresh(input, runId, patient.patientId, 'reconciliation');
      }
    }

    for (const pccPatientId of local.keys()) {
      if (!seen.has(pccPatientId)) {
        await this.recordDrift(input, runId, pccPatientId, 'missingUpstream', []);
        drifted += 1;
      }
    }

    await this.deps.store
      .syncCursors()
      .doc(this.cursorId(input))
      .set({ lastCensusRunAt: this.deps.clock.now() }, { merge: true });

    return { examined, drifted };
  }

  private async enqueueRefresh(
    input: ReconcileInput,
    runId: string,
    pccPatientId: string,
    reason: SyncTask['reason'],
  ): Promise<void> {
    const task: SyncTask = {
      taskId: `${runId}__${documentIds.patient(input.pccOrgUuid, pccPatientId)}`,
      therapyOrgId: input.therapyOrgId,
      pccOrgUuid: input.pccOrgUuid,
      pccFacId: input.facility.pcc.facId,
      entityType: 'patient',
      // The sweep does not know which part drifted, so it refreshes the whole patient.
      scope: 'all',
      entityPccId: pccPatientId,
      reason,
      causedByEventId: null,
      attempt: 1,
      enqueuedAt: this.deps.clock.now(),
    };

    // Deduped per run, so a patient that appears in both the delta window and a concurrent census
    // is refreshed once.
    await this.deps.queue.enqueue(task, { dedupeKey: task.taskId });
  }

  private async recordDrift(
    input: ReconcileInput,
    runId: string,
    pccPatientId: string,
    kind: DriftRecord['kind'],
    fields: string[],
  ): Promise<void> {
    const documentId = documentIds.patient(input.pccOrgUuid, pccPatientId);
    const id = `${runId}__${documentId}__${kind}`;

    await this.deps.store.driftRecords().doc(id).set({
      id,
      therapyOrgId: input.therapyOrgId,
      facilityId: input.facility.id,
      runId,
      entityType: 'patient',
      entityPccId: pccPatientId,
      documentId,
      kind,
      fields,
      detectedAt: this.deps.clock.now(),
      status: 'open',
      resolvedAt: null,
    });
  }

  private cursorId(input: ReconcileInput): string {
    return this.deps.store.cursorId(input.therapyOrgId, input.facility.id, 'patient');
  }

  private async loadCursor(input: ReconcileInput): Promise<SyncCursor> {
    const existing = await this.deps.store.getCursor(
      input.therapyOrgId,
      input.facility.id,
      'patient',
    );
    if (existing !== null) return existing;

    return {
      id: this.cursorId(input),
      therapyOrgId: input.therapyOrgId,
      facilityId: input.facility.id,
      entityType: 'patient',
      deltaCursor: null,
      lastDeltaRunAt: null,
      lastCensusRunAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      status: 'healthy',
    };
  }

  private defaultSince(lookbackDays: number | undefined): string {
    const days = lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    return new Date(Date.parse(this.deps.clock.now()) - days * 24 * 60 * 60 * 1000).toISOString();
  }

  private async recordCursorSuccess(input: ReconcileInput): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.store
      .syncCursors()
      .doc(this.cursorId(input))
      .set(
        {
          ...(await this.loadCursor(input)),
          lastSuccessAt: now,
          consecutiveFailures: 0,
          status: 'healthy',
        },
        { merge: true },
      );
  }

  /**
   * Health is tracked on the cursor rather than only in logs, because the question an operator asks
   * is per-facility: "is Ferncrest syncing". A run document answers "did the last sweep work"; the
   * failure counter answers whether this facility has been quietly broken for a day.
   */
  private async recordCursorFailure(input: ReconcileInput): Promise<void> {
    const cursor = await this.loadCursor(input);
    const consecutiveFailures = cursor.consecutiveFailures + 1;

    await this.deps.store
      .syncCursors()
      .doc(this.cursorId(input))
      .set(
        {
          ...cursor,
          consecutiveFailures,
          status: consecutiveFailures >= FAILING_THRESHOLD ? 'failing' : 'degraded',
        },
        { merge: true },
      );
  }
}
