import {
  documentIds,
  type Clock,
  type Logger,
  type PccConnection,
  type SyncEntityType,
  type SyncEvent,
  type SyncTask,
} from '@rehabalpha/core';
import type { PccWebhookNotification } from '@rehabalpha/pcc-client';
import type { SyncStore } from './firestore/store.js';
import type { TaskQueue } from './task-queue.js';

export type IngestResult =
  | { status: 'queued'; eventId: string; entityType: SyncEntityType }
  | { status: 'duplicate'; eventId: string }
  | { status: 'ignored'; eventId: string; reason: 'unsupportedEventType' | 'missingPatientId' };

/**
 * Webhook envelopes are operational records, not part of the medical record. Ninety days is long
 * enough to investigate a delivery problem and short enough that PCC identifiers are not retained
 * indefinitely. A Firestore TTL policy on `expiresAt` does the deleting.
 */
const EVENT_RETENTION_DAYS = 90;

/**
 * Maps a PCC event type onto what needs re-reading.
 *
 * Deliberately a small allow-list rather than a catch-all. An unrecognised event type is recorded
 * and ignored, which means enabling a new subscription in PCC cannot start silently rewriting
 * charts through a code path nobody reviewed. The recorded envelope is how an operator notices the
 * new event type exists and asks for it to be handled.
 */
function entityTypeFor(eventType: string): SyncEntityType | null {
  const normalised = eventType.toLowerCase();

  // The specific signal is tested before the generic prefix, because PCC namespaces some events
  // under the patient. `patient.payerChanged` matched on the prefix would schedule a demographics
  // refresh and never re-read coverage, so the payer change that caused the notification would be
  // the one thing the sync ignored.
  if (normalised.includes('payer') || normalised.startsWith('coverage.')) return 'coverage';
  if (normalised.includes('admission') || normalised.startsWith('adt.')) return 'admission';
  if (normalised.startsWith('patient.')) return 'patient';

  return null;
}

/**
 * The fast path.
 *
 * PointClickCare expects a webhook to be acknowledged within a few seconds and retries when it is
 * not, so this does the least work that is still safe: validate, record the envelope, enqueue, and
 * return. Everything expensive — reading from the PCC API, transforming, writing the chart — happens
 * in the worker.
 *
 * Doing the sync inline is the obvious shortcut and it fails in a specific, ugly way. One slow PCC
 * response pushes the handler past the acknowledgement budget; PCC redelivers; the redelivery is
 * also slow; and the retries pile onto an upstream that is already struggling. The queue converts
 * that feedback loop into a backlog with a depth metric.
 *
 * Deduplication happens here too. `create` on a deterministic id fails if the document exists, so a
 * redelivered message is recognised with one write and no read, and never reaches the worker.
 */
export class WebhookIngest {
  constructor(
    private readonly store: SyncStore,
    private readonly queue: TaskQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async accept(
    connection: PccConnection,
    notification: PccWebhookNotification,
  ): Promise<IngestResult> {
    const now = this.clock.now();
    const eventId = documentIds.syncEvent(notification.messageId);
    const entityType = entityTypeFor(notification.eventType);
    const pccPatientId = notification.patientId ?? null;

    const reason =
      entityType === null
        ? ('unsupportedEventType' as const)
        : pccPatientId === null
          ? ('missingPatientId' as const)
          : null;

    const event: SyncEvent = {
      id: eventId,
      therapyOrgId: connection.therapyOrgId,
      pccOrgUuid: notification.orgUuid,
      facilityId: null,
      eventType: notification.eventType,
      entityType: entityType ?? 'patient',
      entityPccId: pccPatientId ?? notification.messageId,
      occurredAt: normaliseOccurredAt(notification.eventDateTime),
      receivedAt: now,
      status: reason === null ? 'queued' : 'skipped',
      skipReason: reason,
      attempts: 0,
      completedAt: reason === null ? null : now,
      expiresAt: new Date(
        Date.parse(now) + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    };

    try {
      await this.store.syncEvents().doc(eventId).create(event);
    } catch (error) {
      if (isAlreadyExists(error)) {
        this.logger.info('Ignored duplicate PCC webhook delivery', { eventId });
        return { status: 'duplicate', eventId };
      }
      throw error;
    }

    if (reason !== null || entityType === null || pccPatientId === null) {
      this.logger.warn('Recorded PCC webhook without acting on it', {
        eventId,
        eventType: notification.eventType,
        reason,
      });
      return { status: 'ignored', eventId, reason: reason ?? 'unsupportedEventType' };
    }

    const task: SyncTask = {
      taskId: eventId,
      therapyOrgId: connection.therapyOrgId,
      pccOrgUuid: notification.orgUuid,
      pccFacId: notification.facId ?? null,
      entityType,
      scope: entityType,
      entityPccId: pccPatientId,
      reason: 'webhook',
      causedByEventId: eventId,
      attempt: 1,
      enqueuedAt: now,
    };

    // The queue deduplicates by name as a second line of defence, which covers the window where the
    // envelope was written but the process died before enqueueing and PCC redelivered.
    await this.queue.enqueue(task, { dedupeKey: eventId });

    return { status: 'queued', eventId, entityType };
  }
}

function normaliseOccurredAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Firestore signals a create collision with gRPC status 6. */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 6
  );
}
