import {
  documentIds,
  PermanentSyncError,
  RetryableSyncError,
  type PccConnection,
  type SyncTask,
} from '@rehabalpha/core';
import type { PccWebhookNotification } from '@rehabalpha/pcc-client';
import {
  BETTY_PCC_PATIENT_ID,
  FIXTURE_FERNCREST_FAC_ID,
  FIXTURE_ORG_UUID,
  HAROLD_PCC_PATIENT_ID,
} from '@rehabalpha/pcc-client/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Reconciler } from '../src/reconciliation.js';
import { replayDeadLetter } from '../src/worker.js';
import { createHarness, FERNCREST_ID, ferncrest, THERAPY_ORG_ID, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ namespace: 'pipeline' });
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.reset();
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
    grantedBySubjectHash: 'sha256:7b1e…',
    grantedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: null,
  },
  scopes: ['patient.read', 'adt.read', 'coverage.read'],
  status: 'healthy',
  lastVerifiedAt: '2026-09-25T14:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
};

function notification(overrides: Partial<PccWebhookNotification> = {}): PccWebhookNotification {
  return {
    messageId: 'msg-0001',
    eventType: 'patient.updated',
    orgUuid: FIXTURE_ORG_UUID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    patientId: BETTY_PCC_PATIENT_ID,
    eventDateTime: '2026-09-25T14:58:12Z',
    ...overrides,
  };
}

function task(overrides: Partial<SyncTask> = {}): SyncTask {
  return {
    taskId: 'tsk_0001',
    therapyOrgId: THERAPY_ORG_ID,
    pccOrgUuid: FIXTURE_ORG_UUID,
    pccFacId: FIXTURE_FERNCREST_FAC_ID,
    entityType: 'patient',
    scope: 'all',
    entityPccId: BETTY_PCC_PATIENT_ID,
    reason: 'webhook',
    causedByEventId: null,
    attempt: 1,
    enqueuedAt: '2026-09-25T15:00:00.000Z',
    ...overrides,
  };
}

describe('accepting a webhook', () => {
  it('records the delivery and enqueues the work instead of doing it', async () => {
    const result = await h.ingest.accept(connection, notification());

    expect(result).toMatchObject({ status: 'queued', entityType: 'patient' });
    expect(h.queue.enqueued).toHaveLength(1);
    // Nothing was pulled from PCC on the acknowledgement path: that is the whole point of it.
    expect(h.pcc.calls).toHaveLength(0);
  });

  /**
   * PCC delivers at least once and retries anything it does not see acknowledged, so the same
   * message id arriving twice is ordinary traffic. It is recognised with one conditional create and
   * never reaches the worker.
   */
  it('ignores a redelivery of the same message', async () => {
    await h.ingest.accept(connection, notification());
    const second = await h.ingest.accept(connection, notification());

    expect(second.status).toBe('duplicate');
    expect(h.queue.enqueued).toHaveLength(1);
  });

  it('treats two different messages about one patient as two units of work', async () => {
    await h.ingest.accept(connection, notification({ messageId: 'msg-0001' }));
    await h.ingest.accept(
      connection,
      notification({ messageId: 'msg-0002', eventType: 'coverage.updated' }),
    );

    expect(h.queue.enqueued.map((entry) => entry.task.scope)).toEqual(['patient', 'coverage']);
  });

  /**
   * Enabling a new subscription in the PCC portal must not start rewriting charts through a code
   * path nobody reviewed. The envelope is kept so an operator can see the new event type arrived and
   * ask for it to be handled.
   */
  it('records an unrecognised event type without acting on it', async () => {
    const result = await h.ingest.accept(
      connection,
      notification({ eventType: 'assessment.finalized' }),
    );

    expect(result).toMatchObject({ status: 'ignored', reason: 'unsupportedEventType' });
    expect(h.queue.enqueued).toHaveLength(0);

    const stored = await h.store.syncEvents().doc(documentIds.syncEvent('msg-0001')).get();
    expect(stored.data()).toMatchObject({
      status: 'skipped',
      skipReason: 'unsupportedEventType',
      eventType: 'assessment.finalized',
    });
  });

  it('records a notification with no patient on it without acting on it', async () => {
    const result = await h.ingest.accept(connection, notification({ patientId: null }));

    expect(result).toMatchObject({ status: 'ignored', reason: 'missingPatientId' });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it('maps ADT and coverage event types onto the right scope', async () => {
    await h.ingest.accept(connection, notification({ messageId: 'm1', eventType: 'adt.created' }));
    await h.ingest.accept(
      connection,
      notification({ messageId: 'm2', eventType: 'coverage.updated' }),
    );
    await h.ingest.accept(
      connection,
      notification({ messageId: 'm3', eventType: 'patient.payerChanged' }),
    );

    expect(h.queue.enqueued.map((entry) => entry.task.scope)).toEqual([
      'admission',
      'coverage',
      'coverage',
    ]);
  });

  it('sets a retention deadline on the envelope so identifiers are not kept forever', async () => {
    await h.ingest.accept(connection, notification());

    const stored = await h.store.syncEvents().doc(documentIds.syncEvent('msg-0001')).get();
    expect(stored.data()!.expiresAt).toBe('2026-12-24T15:00:00.000Z');
  });
});

describe('processing a unit of work', () => {
  it('applies the work and closes out the delivery record', async () => {
    const accepted = await h.ingest.accept(connection, notification());
    const queued = h.queue.enqueued[0]!.task;

    const result = await h.worker.process(queued);

    expect(result.status).toBe('applied');
    const event = await h.store.syncEvents().doc(accepted.eventId).get();
    expect(event.data()).toMatchObject({ status: 'applied', attempts: 1 });
  });

  it('reports a repeated delivery as skipped rather than applied', async () => {
    await h.worker.process(task());
    const second = await h.worker.process(task({ taskId: 'tsk_0002' }));

    expect(second).toMatchObject({ status: 'skipped' });
  });

  /**
   * The envelope has a ninety-day retention, so a replay requested after that has no delivery record
   * to close out. Writing one anyway would leave a stub holding a status and nothing else, which
   * breaks the console's recent-deliveries list rather than the sync it came from.
   */
  it('completes work whose delivery record has already expired', async () => {
    const result = await h.worker.process(task({ causedByEventId: 'evt_long_gone' }));

    expect(result.status).toBe('applied');
    expect((await h.store.syncEvents().doc('evt_long_gone').get()).exists).toBe(false);
  });

  /**
   * A 429 or a 503 from PCC is a transient condition. Dead-lettering it would hand an operator a
   * chart that was going to heal itself, and after a PCC incident there are thousands of them.
   */
  it('asks for a retry when PCC is temporarily unavailable', async () => {
    h.pcc.failNextCalls('getPatient', new RetryableSyncError('pcc_unavailable', 'Service busy'));

    const result = await h.worker.process(task());

    expect(result).toMatchObject({ status: 'retry', code: 'pcc_unavailable' });
    expect((await h.db.collection('syncDeadLetters').count().get()).data().count).toBe(0);
  });

  it('backs off further on each successive attempt', async () => {
    h.pcc.failNextCalls('getPatient', new RetryableSyncError('pcc_unavailable', 'busy'), 9);

    const first = await h.worker.process(task({ attempt: 1 }));
    const later = await h.worker.process(task({ attempt: 4 }));

    if (first.status !== 'retry' || later.status !== 'retry') throw new Error('expected retries');
    expect(later.delayMs).toBeGreaterThan(first.delayMs);
  });

  /**
   * Retrying a permanent failure burns the organisation's PCC rate budget and hides a real defect
   * behind a queue that only looks busy. It goes straight to the dead-letter queue.
   */
  it('dead-letters a permanent failure on the first attempt', async () => {
    h.pcc.failNextCalls(
      'getPatient',
      new PermanentSyncError('pcc_forbidden', 'Consent was revoked'),
    );

    const result = await h.worker.process(task({ causedByEventId: 'evt_dl' }));

    expect(result).toMatchObject({ status: 'deadLettered', code: 'pcc_forbidden' });
  });

  it('gives up on a transient failure once the retry budget is spent', async () => {
    h.pcc.failNextCalls('getPatient', new RetryableSyncError('pcc_unavailable', 'busy'), 9);

    const result = await h.worker.process(task({ attempt: 6 }));

    expect(result.status).toBe('deadLettered');
  });

  it('keeps the whole failed unit of work so it can be replayed exactly', async () => {
    h.pcc.failNextCalls('getPatient', new PermanentSyncError('pcc_forbidden', 'revoked'));
    const original = task({ scope: 'coverage', causedByEventId: 'evt_dl', attempt: 3 });

    const result = await h.worker.process(original);
    if (result.status !== 'deadLettered') throw new Error('expected a dead letter');

    const record = (await h.store.syncDeadLetters().doc(result.deadLetterId).get()).data()!;
    expect(record.task).toEqual(original);
    expect(record).toMatchObject({ status: 'open', entityType: 'patient' });
    expect(record.failure).toMatchObject({ kind: 'permanent', code: 'pcc_forbidden', attempts: 3 });
  });

  /**
   * One underlying problem should be one row in the operator's queue. A fresh document per attempt
   * turns a broken connection into hundreds of near-identical entries and buries everything else.
   */
  it('collapses repeated failures of the same work into one record', async () => {
    h.pcc.failNextCalls('getPatient', new PermanentSyncError('pcc_forbidden', 'revoked'), 5);

    const first = await h.worker.process(task({ attempt: 1 }));
    await h.worker.process(task({ attempt: 2 }));

    if (first.status !== 'deadLettered') throw new Error('expected a dead letter');
    const record = (await h.store.syncDeadLetters().doc(first.deadLetterId).get()).data()!;

    expect((await h.db.collection('syncDeadLetters').count().get()).data().count).toBe(1);
    expect(record.failure.attempts).toBe(2);
  });

  it('marks the originating delivery as dead-lettered and audits it', async () => {
    h.pcc.failNextCalls('getPatient', new PermanentSyncError('pcc_forbidden', 'revoked'));
    await h.ingest.accept(connection, notification());
    const queued = h.queue.enqueued[0]!.task;

    await h.worker.process(queued);

    const event = await h.store.syncEvents().doc(queued.causedByEventId!).get();
    expect(event.data()!.status).toBe('deadLettered');

    const audits = await h.db
      .collection('auditEvents')
      .where('action', '==', 'sync.deadLettered')
      .get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.get('outcome')).toBe('failure');
  });

  /**
   * An upstream error message can echo request data back at us, and the dead-letter queue is a
   * collection operators browse freely. The message is redacted before it is stored.
   */
  it('redacts upstream error text before storing it', async () => {
    h.pcc.failNextCalls(
      'getPatient',
      new PermanentSyncError('pcc_bad_request', 'Rejected payload for lastName=Abernathy'),
    );

    const result = await h.worker.process(task());
    if (result.status !== 'deadLettered') throw new Error('expected a dead letter');

    const record = (await h.store.syncDeadLetters().doc(result.deadLetterId).get()).data()!;
    expect(record.failure.message).not.toContain('Abernathy');
  });
});

describe('replaying a dead letter', () => {
  async function deadLetter(): Promise<string> {
    h.pcc.failNextCalls('getPatient', new PermanentSyncError('pcc_forbidden', 'revoked'));
    const result = await h.worker.process(task({ attempt: 4, causedByEventId: 'evt_dl' }));
    if (result.status !== 'deadLettered') throw new Error('expected a dead letter');
    return result.deadLetterId;
  }

  it('re-enqueues the stored work with a full retry budget', async () => {
    const deadLetterId = await deadLetter();
    h.queue.reset();

    const result = await replayDeadLetter(
      { store: h.store, queue: h.queue, clock: h.clock, audit: h.audit },
      { therapyOrgId: THERAPY_ORG_ID, deadLetterId, actorUid: 'uid_operator', note: 'Reconsented' },
    );

    expect(result.status).toBe('replayed');
    expect(h.queue.enqueued).toHaveLength(1);
    expect(h.queue.enqueued[0]!.task).toMatchObject({
      attempt: 1,
      entityPccId: BETTY_PCC_PATIENT_ID,
      causedByEventId: 'evt_dl',
    });
  });

  it('names the operator who asked for it', async () => {
    const deadLetterId = await deadLetter();

    await replayDeadLetter(
      { store: h.store, queue: h.queue, clock: h.clock, audit: h.audit },
      { therapyOrgId: THERAPY_ORG_ID, deadLetterId, actorUid: 'uid_operator', note: 'Reconsented' },
    );

    const record = (await h.store.syncDeadLetters().doc(deadLetterId).get()).data()!;
    expect(record).toMatchObject({
      status: 'replaying',
      resolution: { byUid: 'uid_operator', note: 'Reconsented' },
    });

    const audits = await h.db
      .collection('auditEvents')
      .where('action', '==', 'sync.deadLetterReplayed')
      .get();
    expect(audits.docs[0]!.get('actor')).toMatchObject({ kind: 'user', uid: 'uid_operator' });
  });

  /**
   * The replay endpoint runs with admin credentials, so Firestore rules are not in the path. The
   * tenant check has to exist in the code that does the work, and a cross-tenant id must look like
   * a missing record rather than a forbidden one.
   */
  it('refuses to replay another tenant’s dead letter', async () => {
    const deadLetterId = await deadLetter();

    const result = await replayDeadLetter(
      { store: h.store, queue: h.queue, clock: h.clock, audit: h.audit },
      {
        therapyOrgId: 'org_someone_else',
        deadLetterId,
        actorUid: 'uid_intruder',
        note: 'curiosity',
      },
    );

    expect(result.status).toBe('notFound');
    expect(h.queue.enqueued.some((entry) => entry.task.taskId === 'tsk_0001')).toBe(false);
  });

  it('replays successfully once the underlying problem is fixed', async () => {
    const deadLetterId = await deadLetter();
    h.queue.reset();

    await replayDeadLetter(
      { store: h.store, queue: h.queue, clock: h.clock, audit: h.audit },
      { therapyOrgId: THERAPY_ORG_ID, deadLetterId, actorUid: 'uid_operator', note: 'Reconsented' },
    );
    const result = await h.worker.process(h.queue.enqueued[0]!.task);

    expect(result.status).toBe('applied');
    expect(
      await h.store.getPatient(documentIds.patient(FIXTURE_ORG_UUID, BETTY_PCC_PATIENT_ID)),
    ).not.toBeNull();
  });
});

describe('reconciliation', () => {
  function reconciler(): Reconciler {
    return new Reconciler({
      store: h.store,
      pcc: h.pcc,
      queue: h.queue,
      audit: h.audit,
      clock: h.clock,
      logger: h.logger,
    });
  }

  const input = {
    therapyOrgId: THERAPY_ORG_ID,
    pccOrgUuid: FIXTURE_ORG_UUID,
    facility: ferncrest(),
  };

  /**
   * The delta sweep enqueues rather than syncing inline. A facility coming back from a two-day
   * outage has thousands of changed patients, and doing them inline would run past any function
   * timeout and hammer the PCC rate limit with no backpressure.
   */
  it('enqueues a refresh for everything that changed, rather than syncing inline', async () => {
    const run = await reconciler().run({ ...input, mode: 'delta', lookbackDays: 120 });

    expect(run).toMatchObject({ mode: 'delta', status: 'succeeded' });
    expect(run.counts.examined).toBe(2);
    expect(h.queue.enqueued).toHaveLength(2);
    expect(h.queue.enqueued.every((entry) => entry.task.reason === 'reconciliation')).toBe(true);
    // The sweep does not know which part drifted, so it asks for the whole patient.
    expect(h.queue.enqueued.every((entry) => entry.task.scope === 'all')).toBe(true);
  });

  it('advances the cursor to the newest record it actually saw, not to now', async () => {
    await reconciler().run({ ...input, mode: 'delta', lookbackDays: 120 });

    const cursor = await h.store.getCursor(THERAPY_ORG_ID, FERNCREST_ID, 'patient');
    // Betty's own last modification, which is the newest at Ferncrest.
    expect(cursor).toMatchObject({
      deltaCursor: '2026-08-11T14:05:00.000Z',
      status: 'healthy',
      consecutiveFailures: 0,
    });
  });

  /**
   * Re-reading an already covered window is deliberate. PCC's timestamps come from their clock, and
   * a cursor advanced to exactly the newest value seen will eventually skip a record written in the
   * same second by a slower node.
   */
  it('re-reads a window it has already covered', async () => {
    await reconciler().run({ ...input, mode: 'delta', lookbackDays: 120 });
    h.queue.reset();
    h.pcc.resetCalls();

    await reconciler().run({ ...input, mode: 'delta' });

    const call = h.pcc.calls.find((entry) => entry.method === 'listPatients')!;
    expect(Date.parse(call.detail['modifiedSince']!)).toBeLessThan(
      Date.parse('2026-08-11T14:05:00.000Z'),
    );
  });

  it('does not touch a facility it was not asked about', async () => {
    await reconciler().run({ ...input, mode: 'delta', lookbackDays: 120 });

    expect(
      h.queue.enqueued.every((entry) => entry.task.pccFacId === FIXTURE_FERNCREST_FAC_ID),
    ).toBe(true);
  });

  /**
   * The census is the only thing that catches a webhook that was never delivered: a record we never
   * received has no modification since the cursor either, so the delta sweep cannot see it.
   */
  it('finds a patient it never heard about and queues them', async () => {
    const run = await reconciler().run({ ...input, mode: 'census' });

    const drift = await h.db.collection('driftRecords').get();
    expect(run.counts.drifted).toBe(2);
    expect(drift.docs.every((doc) => doc.get('kind') === 'missingLocally')).toBe(true);
    expect(h.queue.enqueued).toHaveLength(2);
  });

  it('reports a patient we hold and PCC no longer lists, and deletes nothing', async () => {
    await h.engine.sync({
      therapyOrgId: THERAPY_ORG_ID,
      pccOrgUuid: FIXTURE_ORG_UUID,
      pccFacId: FIXTURE_FERNCREST_FAC_ID,
      pccPatientId: HAROLD_PCC_PATIENT_ID,
      scope: 'all',
      source: 'webhook',
      causedByEventId: null,
    });

    // PCC stops listing Harold: a merge on their side, a scope change, or a bug on ours.
    h.pcc.data.patients = h.pcc.data.patients.filter(
      (patient) => patient.patientId !== HAROLD_PCC_PATIENT_ID,
    );
    const run = await reconciler().run({ ...input, mode: 'census' });

    const drift = await h.db
      .collection('driftRecords')
      .where('kind', '==', 'missingUpstream')
      .get();

    expect(drift.size).toBe(1);
    expect(run.counts.drifted).toBeGreaterThanOrEqual(1);
    expect(
      await h.store.getPatient(documentIds.patient(FIXTURE_ORG_UUID, HAROLD_PCC_PATIENT_ID)),
    ).not.toBeNull();
  });

  it('leaves an up-to-date patient alone', async () => {
    await h.engine.sync({
      therapyOrgId: THERAPY_ORG_ID,
      pccOrgUuid: FIXTURE_ORG_UUID,
      pccFacId: FIXTURE_FERNCREST_FAC_ID,
      pccPatientId: BETTY_PCC_PATIENT_ID,
      scope: 'all',
      source: 'webhook',
      causedByEventId: null,
    });
    h.queue.reset();

    await reconciler().run({ ...input, mode: 'census' });

    expect(h.queue.enqueued.some((entry) => entry.task.entityPccId === BETTY_PCC_PATIENT_ID)).toBe(
      false,
    );
  });

  /**
   * Health is tracked per facility because that is the question an operator asks: "is Ferncrest
   * syncing". A run document only answers "did the last sweep work".
   */
  it('marks the facility degraded when a sweep fails, and rethrows', async () => {
    h.pcc.failNextCalls('listPatients', new RetryableSyncError('pcc_unavailable', 'busy'));

    await expect(reconciler().run({ ...input, mode: 'delta' })).rejects.toThrow(RetryableSyncError);

    const cursor = await h.store.getCursor(THERAPY_ORG_ID, FERNCREST_ID, 'patient');
    expect(cursor).toMatchObject({ consecutiveFailures: 1, status: 'degraded' });
  });

  it('escalates to failing after three consecutive failures', async () => {
    h.pcc.failNextCalls('listPatients', new RetryableSyncError('pcc_unavailable', 'busy'), 3);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(reconciler().run({ ...input, mode: 'delta' })).rejects.toThrow();
    }

    const cursor = await h.store.getCursor(THERAPY_ORG_ID, FERNCREST_ID, 'patient');
    expect(cursor).toMatchObject({ consecutiveFailures: 3, status: 'failing' });
  });

  /**
   * A nightly census on a facility that has never had a delta pull writes the first cursor this
   * facility has ever had. Merging one field into a document that does not exist yet leaves a cursor
   * with nothing but a timestamp on it, and the next read of it fails validation.
   */
  it('leaves a readable cursor behind on the first census a facility ever gets', async () => {
    await reconciler().run({ ...input, mode: 'census' });

    const cursor = await h.store.getCursor(THERAPY_ORG_ID, FERNCREST_ID, 'patient');
    expect(cursor).toMatchObject({
      therapyOrgId: THERAPY_ORG_ID,
      facilityId: FERNCREST_ID,
      entityType: 'patient',
      lastCensusRunAt: '2026-09-25T15:00:00.000Z',
      status: 'healthy',
    });
  });

  it('records the failed run so a scheduler has something to alert on', async () => {
    h.pcc.failNextCalls('listPatients', new RetryableSyncError('pcc_unavailable', 'busy'));

    await expect(reconciler().run({ ...input, mode: 'delta' })).rejects.toThrow();

    const runs = await h.db.collection('reconciliationRuns').get();
    expect(runs.docs.map((doc) => doc.get('status'))).toEqual(['failed']);
  });

  /**
   * A delta sweep and a concurrent census can both name the same patient. Refreshing them twice is
   * wasted PCC budget, so every enqueue carries a key the queue can collapse on.
   */
  it('keys each refresh so a patient found twice in one sweep is refreshed once', async () => {
    await reconciler().run({ ...input, mode: 'census' });

    expect(h.queue.enqueued).not.toHaveLength(0);
    expect(h.queue.enqueued.every((entry) => entry.options.dedupeKey === entry.task.taskId)).toBe(
      true,
    );
  });

  it('drains the queue it filled', async () => {
    await reconciler().run({ ...input, mode: 'census' });

    for (const entry of h.queue.enqueued) {
      expect((await h.worker.process(entry.task)).status).toBe('applied');
    }

    expect((await h.db.collection('patients').count().get()).data().count).toBe(2);
  });
});
