import { z } from 'zod';
import { isoDateTime } from '../schema-primitives.js';
import { syncSourceSchema } from './sync-metadata.js';

export const syncEntityTypeSchema = z.enum(['patient', 'admission', 'coverage']);
export type SyncEntityType = z.infer<typeof syncEntityTypeSchema>;

/**
 * How much of a patient to re-read.
 *
 * Kept separate from `entityType`, which records *what changed upstream*. A coverage notification
 * should re-read coverage and nothing else, so a payer change on a 90-bed facility does not turn
 * into 90 full patient refreshes. The reconciliation sweep, by contrast, has no idea which part
 * drifted and asks for everything. Collapsing the two into one field would force one of those two
 * callers to lie.
 */
export const syncScopeSchema = z.enum(['patient', 'admission', 'coverage', 'all']);
export type SyncScope = z.infer<typeof syncScopeSchema>;

/**
 * A webhook delivery from PCC, stored before anything else happens.
 *
 * PCC expects a webhook to be acknowledged within a few seconds and will retry when it is
 * not. That constraint dictates the shape of the whole ingest path: the endpoint may only
 * validate, persist and enqueue, and every expensive step — fetching from the PCC API,
 * transforming, writing the chart — has to happen in a worker afterwards. Doing the sync
 * inline would blow the acknowledgement budget under any real load and turn one slow PCC
 * response into a storm of redeliveries.
 *
 * The envelope is also the deduplication record. `id` is derived from PCC's message id, so a
 * redelivery collides with the existing document and is recognised instead of reprocessed.
 */
export const syncEventSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  pccOrgUuid: z.string().min(1),
  facilityId: z.string().nullable(),
  eventType: z.string().min(1),
  entityType: syncEntityTypeSchema,
  entityPccId: z.string().min(1),
  /** When PCC says the change happened. */
  occurredAt: isoDateTime.nullable(),
  /** When we accepted the delivery. Used for the ingest-to-applied latency metric. */
  receivedAt: isoDateTime,
  status: z.enum(['received', 'queued', 'applied', 'skipped', 'deadLettered']),
  /** Set when the write was intentionally not applied, e.g. a stale watermark. */
  skipReason: z
    .enum([
      'staleWatermark',
      'duplicateDelivery',
      'contentUnchanged',
      /** The therapy company's contract for this facility is not in force. */
      'contractInactive',
      /** PCC sent an event type this integration does not subscribe to or act on. */
      'unsupportedEventType',
      /** The notification carried no patient identifier, so there is nothing to fetch. */
      'missingPatientId',
    ])
    .nullable(),
  attempts: z.number().int().nonnegative(),
  completedAt: isoDateTime.nullable(),
  /**
   * Retention: webhook envelopes are operational data, not part of the medical record.
   * A Firestore TTL policy on this field expires them so the collection does not grow
   * without bound and so PCC identifiers are not retained longer than needed.
   */
  expiresAt: isoDateTime,
});
export type SyncEvent = z.infer<typeof syncEventSchema>;

/**
 * Unit of work handed to the worker.
 *
 * Note that it carries an identifier, not a payload. A webhook is treated as a hint that
 * something changed, and the worker re-reads current state from the PCC API. Trusting the
 * webhook body instead would mean applying whatever was true when the notification was
 * generated, which is exactly the state that goes stale when deliveries are retried or
 * arrive out of order.
 */
export const syncTaskSchema = z.object({
  taskId: z.string().min(1),
  therapyOrgId: z.string().min(1),
  pccOrgUuid: z.string().min(1),
  /**
   * PCC facility id from the notification, used as a hint. The authoritative facility comes from
   * the patient record itself, because an internal transfer moves a patient between facilities and
   * the notification's facility can be the one they left.
   */
  pccFacId: z.string().nullable(),
  /** What changed upstream, as reported by the trigger. Used for grouping and metrics. */
  entityType: syncEntityTypeSchema,
  /** What the worker should re-read. Defaults to the triggering entity type. */
  scope: syncScopeSchema,
  /**
   * Always a PCC patient id. Admissions and coverage are both addressed through the patient in the
   * PCC API, so one identifier serves all three entity types and the worker never has to guess
   * which kind of id it is holding.
   */
  entityPccId: z.string().min(1),
  reason: syncSourceSchema,
  causedByEventId: z.string().nullable(),
  attempt: z.number().int().positive(),
  enqueuedAt: isoDateTime,
});
export type SyncTask = z.infer<typeof syncTaskSchema>;

/**
 * Per-facility, per-entity cursor for the reconciliation sweep.
 *
 * Webhooks get missed: endpoints have outages, subscriptions get deactivated, PCC has
 * incidents. Without an independent path to the same data, a missed delivery is invisible
 * and permanent. The sweep pulls everything modified since the cursor, and periodically does
 * a full census comparison to catch records that were never delivered at all.
 */
export const syncCursorSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  entityType: syncEntityTypeSchema,
  /** Upstream modification instant reached by the last successful delta pull. */
  deltaCursor: isoDateTime.nullable(),
  lastDeltaRunAt: isoDateTime.nullable(),
  lastCensusRunAt: isoDateTime.nullable(),
  lastSuccessAt: isoDateTime.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  status: z.enum(['healthy', 'degraded', 'failing']),
});
export type SyncCursor = z.infer<typeof syncCursorSchema>;

export const failureKindSchema = z.enum([
  /** Transient. Worth retrying with backoff: 429, 5xx, socket errors, token refresh races. */
  'retryable',
  /** Deterministic. Retrying cannot help: validation failure, 404, revoked consent. */
  'permanent',
]);
export type FailureKind = z.infer<typeof failureKindSchema>;

/**
 * A unit of work that exhausted its retries or failed permanently.
 *
 * Kept as a first-class document with enough context to replay, rather than only a log line,
 * because the operational question is never "did something fail" but "which patients are
 * currently out of date, and can I fix them without a deploy". The console reads this
 * collection directly and the replay action re-enqueues the stored task.
 */
export const syncDeadLetterSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().nullable(),
  entityType: syncEntityTypeSchema,
  entityPccId: z.string().min(1),
  task: syncTaskSchema,
  failure: z.object({
    kind: failureKindSchema,
    code: z.string().min(1),
    /** Redacted before storage: upstream errors sometimes echo patient data back. */
    message: z.string(),
    attempts: z.number().int().positive(),
    firstFailedAt: isoDateTime,
    lastFailedAt: isoDateTime,
  }),
  status: z.enum(['open', 'replaying', 'resolved', 'ignored']),
  resolution: z
    .object({
      byUid: z.string().min(1),
      at: isoDateTime,
      note: z.string(),
    })
    .nullable(),
});
export type SyncDeadLetter = z.infer<typeof syncDeadLetterSchema>;

export const reconciliationRunSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  entityType: syncEntityTypeSchema,
  mode: z.enum(['delta', 'census']),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'partial']),
  counts: z.object({
    examined: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;

/**
 * A disagreement between PCC and RehabAlpha found by the sweep.
 *
 * Drift is reported before it is repaired. Silently overwriting on every discrepancy would
 * mask the bug that produced it, and for records a clinician may have touched it would
 * destroy their edit. Low-risk categories are auto-repaired; anything touching a field a
 * human may own waits for a decision.
 */
export const driftRecordSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  runId: z.string().min(1),
  entityType: syncEntityTypeSchema,
  entityPccId: z.string().min(1),
  documentId: z.string().nullable(),
  kind: z.enum([
    /** PCC has it, we do not. Usually a missed webhook. Auto-repaired. */
    'missingLocally',
    /** We have it, PCC does not. Never auto-deleted; a human decides. */
    'missingUpstream',
    /** Both have it, a PCC-owned field disagrees. Auto-repaired. */
    'fieldMismatch',
    /** Our watermark is ahead of PCC's, which should be impossible. Investigated, never repaired. */
    'watermarkInversion',
  ]),
  /** Field names only. Values are omitted so the drift log never becomes a PHI store. */
  fields: z.array(z.string().min(1)),
  detectedAt: isoDateTime,
  status: z.enum(['open', 'repaired', 'accepted']),
  resolvedAt: isoDateTime.nullable(),
});
export type DriftRecord = z.infer<typeof driftRecordSchema>;

/**
 * Append-only audit record.
 *
 * Covers two things that are usually kept apart and should not be: what the integration did
 * to the chart, and who looked at the chart. HIPAA's audit-control requirement wants the
 * second; being able to answer "why does Betty's payer say Medicaid" wants the first. One
 * ordered log per tenant answers both, and clients are never allowed to write to it.
 */
export const auditEventSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().nullable(),
  at: isoDateTime,
  actor: z.object({
    kind: z.enum(['system', 'user']),
    /** Firebase uid for user actions, service name for system actions. */
    uid: z.string().nullable(),
    service: z.string().nullable(),
  }),
  action: z.string().min(1),
  target: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
  }),
  outcome: z.enum(['success', 'denied', 'failure']),
  correlationId: z.string().nullable(),
  /** Already passed through redaction. Field names and ids only, never PHI values. */
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
