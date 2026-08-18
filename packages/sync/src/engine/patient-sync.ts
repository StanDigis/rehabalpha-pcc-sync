import {
  decideWrite,
  documentIds,
  PATIENT_OWNERSHIP,
  planProjectionWrite,
  type Patient,
} from '@rehabalpha/core';
import type { PccPatient } from '@rehabalpha/pcc-client';
import { toPatientProjection } from '../transform/patient.js';
import type { ResolvedContext, SyncDeps, SyncOutcome } from './context.js';

export type PatientSyncResult = {
  outcome: SyncOutcome;
  /** The document as it now stands, whether it was rewritten or left alone. */
  patient: Patient;
};

/**
 * Writes a patient projection under the watermark rule, in one transaction with its audit record.
 *
 * The transaction is not about contention — two webhooks for the same patient are rare — it is
 * about the watermark. Reading the stored watermark, deciding, and writing has to be atomic, or
 * two concurrent deliveries can both read the old value and both decide they are newer, and the
 * loser's write lands last. That is the same corruption the watermark exists to prevent, arrived at
 * by a different route.
 */
export async function writePatientProjection(
  deps: SyncDeps,
  context: ResolvedContext,
  pccPatient: PccPatient,
  options: { force?: boolean } = {},
): Promise<PatientSyncResult> {
  const now = deps.clock.now();
  const projection = toPatientProjection({
    pccPatient,
    therapyOrgId: context.therapyOrgId,
    facilityId: context.facilityId,
    pccOrgUuid: context.pccOrgUuid,
    pccFacId: context.pccFacId,
    source: context.source,
    causedByEventId: context.causedByEventId,
    now,
  });

  const ref = deps.store
    .patients()
    .doc(documentIds.patient(context.pccOrgUuid, pccPatient.patientId));

  return deps.store.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const stored = snapshot.exists ? snapshot.data()! : null;

    const decision = decideWrite(
      { pccLastModified: projection.watermark, contentHash: projection.contentHash },
      stored === null
        ? null
        : { pccLastModified: stored.sync.pccLastModified, contentHash: stored.sync.contentHash },
      options.force === true ? { force: true } : {},
    );

    if (decision.action === 'skip') {
      return {
        outcome: {
          entityType: 'patient' as const,
          entityPccId: pccPatient.patientId,
          applied: false,
          decision: decision.reason,
          documentIds: [ref.id],
          warnings: [],
        },
        patient: stored!,
      };
    }

    if (decision.action === 'advanceWatermark') {
      tx.update(ref, { 'sync.pccLastModified': projection.watermark, 'sync.syncedAt': now });
      return {
        outcome: {
          entityType: 'patient' as const,
          entityPccId: pccPatient.patientId,
          applied: false,
          decision: 'advanceWatermark',
          documentIds: [ref.id],
          warnings: [],
        },
        patient: {
          ...stored!,
          sync: { ...stored!.sync, pccLastModified: projection.watermark, syncedAt: now },
        },
      };
    }

    const plan = planProjectionWrite(projection.document, stored, {
      ownership: PATIENT_OWNERSHIP,
      now,
    });

    const next: Patient = {
      ...plan.next,
      sync: {
        source: context.source,
        pccLastModified: projection.watermark,
        syncedAt: now,
        syncVersion: (stored?.sync.syncVersion ?? 0) + 1,
        causedByEventId: context.causedByEventId,
        contentHash: projection.contentHash,
      },
    };

    tx.set(ref, next);

    deps.audit.recordIn(
      tx,
      deps.audit.system({
        therapyOrgId: context.therapyOrgId,
        facilityId: context.facilityId,
        action: stored === null ? 'patient.created' : 'patient.updated',
        target: { type: 'patient', id: ref.id },
        outcome: 'success',
        correlationId: context.causedByEventId,
        detail: {
          decision: decision.action === 'update' ? decision.reason : 'create',
          // Field names only. The audit trail explains what moved without restating the values.
          changedFields: plan.changedPaths,
          preservedFields: plan.preservedPaths,
          syncVersion: next.sync.syncVersion,
          source: context.source,
        },
      }),
    );

    const warnings = plan.conflicts.map((conflict) => ({
      code: `fieldOwnership.${conflict.kind}`,
      detail: { path: conflict.path },
    }));

    return {
      outcome: {
        entityType: 'patient' as const,
        entityPccId: pccPatient.patientId,
        applied: true,
        decision: decision.action === 'update' ? decision.reason : 'create',
        documentIds: [ref.id],
        warnings,
      },
      patient: next,
    };
  });
}
