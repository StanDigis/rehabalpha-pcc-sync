import {
  contentHash,
  documentIds,
  reconcileCoverageTimeline,
  type Coverage,
  type DesiredCoverage,
  type Patient,
} from '@rehabalpha/core';
import { toDesiredCoverages } from '../transform/coverage.js';
import type { ResolvedContext, SyncDeps, SyncOutcome, SyncWarning } from './context.js';

function hashOf(desired: DesiredCoverage): string {
  return contentHash({
    payer: desired.payer,
    rank: desired.rank,
    effectiveFrom: desired.effectiveFrom,
    effectiveTo: desired.effectiveTo,
    authorization: desired.authorization,
  });
}

/**
 * Reconciles a patient's coverage timeline against PCC, atomically.
 *
 * One transaction for the whole set, and this is the single most important structural decision in
 * this file. Coverage is read as a set — "who is primary today, who is secondary" — so applying the
 * changes one document at a time exposes intermediate states that are not merely stale but
 * *invalid*: a moment with two primaries, or with none, during which a claim assembled by another
 * part of the system is wrong. Ending the old payer and starting the new one has to be one commit.
 *
 * Nothing is deleted, ever. A payer that disappears from PCC is closed with an end date, a reason,
 * and a flag saying whether we were told the date or inferred it. Every claim already submitted
 * rests on a coverage row; deleting it destroys both the billing basis and the ability to explain a
 * denial months later. Where the end date had to be inferred, a drift record is raised so a human
 * confirms it rather than the system quietly back-dating somebody's coverage.
 */
export async function syncCoverage(
  deps: SyncDeps,
  context: ResolvedContext,
  patient: Patient,
): Promise<SyncOutcome> {
  const pccCoverages = await deps.pcc.listCoverages(context.pccOrgUuid, patient.pcc.patientId);
  const { desired, skipped } = toDesiredCoverages(pccCoverages);

  const now = deps.clock.now();
  const warnings: SyncWarning[] = skipped.map((row) => ({
    code: 'coverage.skipped',
    detail: { pccPayerId: row.pccPayerId, reason: row.reason },
  }));

  const storedQuery = deps.store
    .coverages()
    .where('therapyOrgId', '==', context.therapyOrgId)
    .where('patientId', '==', patient.id);

  const result = await deps.store.db.runTransaction(async (tx) => {
    const storedSnapshot = await tx.get(storedQuery);
    const stored = storedSnapshot.docs.map((doc) => doc.data());

    const { actions, warnings: policyWarnings } = reconcileCoverageTimeline({
      desired,
      stored,
      today: context.today,
      buildCoverageId: (payerId, effectiveFrom) =>
        documentIds.coverage(patient.pcc.patientId, payerId, effectiveFrom),
    });

    const storedById = new Map(stored.map((row) => [row.id, row]));
    const writtenIds: string[] = [];
    let closedCount = 0;

    for (const action of actions) {
      const ref = deps.store.coverages().doc(action.coverageId);

      if (action.kind === 'unchanged') continue;

      if (action.kind === 'close') {
        const existing = storedById.get(action.coverageId)!;
        tx.update(ref, {
          effectiveTo: action.effectiveTo,
          status: 'ended',
          closure: { reason: action.reason, closedAt: now, inferred: action.inferred },
          'sync.syncedAt': now,
          'sync.source': context.source,
          'sync.syncVersion': existing.sync.syncVersion + 1,
          'sync.causedByEventId': context.causedByEventId,
        });
        writtenIds.push(action.coverageId);
        closedCount += 1;

        deps.audit.recordIn(
          tx,
          deps.audit.system({
            therapyOrgId: context.therapyOrgId,
            facilityId: context.facilityId,
            action: 'coverage.closed',
            target: { type: 'coverage', id: action.coverageId },
            outcome: 'success',
            correlationId: context.causedByEventId,
            detail: {
              reason: action.reason,
              inferredEndDate: action.inferred,
              effectiveTo: action.effectiveTo,
            },
          }),
        );

        // An inferred end date is a guess about somebody's insurance. It is surfaced for review
        // rather than trusted, because PCC returns only the current payer tree by default and a
        // payer's absence can equally mean "corrected away".
        if (action.inferred) {
          const driftRef = deps.store.driftRecords().doc();
          tx.set(driftRef, {
            id: driftRef.id,
            therapyOrgId: context.therapyOrgId,
            facilityId: context.facilityId,
            runId: context.causedByEventId ?? 'inline',
            entityType: 'coverage',
            entityPccId: patient.pcc.patientId,
            documentId: action.coverageId,
            kind: 'missingUpstream',
            fields: ['effectiveTo'],
            detectedAt: now,
            status: 'open',
            resolvedAt: null,
          });
        }

        continue;
      }

      const existing = storedById.get(action.coverageId) ?? null;
      const next: Coverage = {
        id: action.coverageId,
        therapyOrgId: context.therapyOrgId,
        facilityId: context.facilityId,
        patientId: patient.id,
        personId: patient.personId,
        admissionId: patient.currentAdmissionId,
        payer: action.desired.payer,
        rank: action.desired.rank,
        effectiveFrom: action.desired.effectiveFrom,
        effectiveTo: action.desired.effectiveTo,
        // System time: when we first believed this row, preserved across updates so the bitemporal
        // record keeps its original observation point.
        recordedAt: existing?.recordedAt ?? now,
        supersededAt: null,
        supersededByCoverageId: null,
        status: 'active',
        closure: null,
        authorization: action.desired.authorization,
        sync: {
          source: context.source,
          pccLastModified: null,
          syncedAt: now,
          syncVersion: (existing?.sync.syncVersion ?? 0) + 1,
          causedByEventId: context.causedByEventId,
          contentHash: hashOf(action.desired),
        },
      };

      tx.set(ref, next);
      writtenIds.push(action.coverageId);

      deps.audit.recordIn(
        tx,
        deps.audit.system({
          therapyOrgId: context.therapyOrgId,
          facilityId: context.facilityId,
          action: `coverage.${action.kind === 'create' ? 'created' : action.kind === 'reopen' ? 'reopened' : 'updated'}`,
          target: { type: 'coverage', id: action.coverageId },
          outcome: 'success',
          correlationId: context.causedByEventId,
          detail: {
            rank: next.rank,
            payerType: next.payer.payerType.value,
            effectiveFrom: next.effectiveFrom,
            effectiveTo: next.effectiveTo,
            changedFields: action.kind === 'update' ? action.changedFields : null,
            authorizationRequired: next.authorization?.required ?? null,
          },
        }),
      );
    }

    return { writtenIds, closedCount, policyWarnings };
  });

  warnings.push(
    ...result.policyWarnings.map((warning) => ({
      code: `coverage.${warning.code}`,
      detail: warning.detail as Record<string, unknown>,
    })),
  );

  return {
    entityType: 'coverage',
    entityPccId: patient.pcc.patientId,
    applied: result.writtenIds.length > 0,
    decision: result.writtenIds.length > 0 ? 'applied' : 'contentUnchanged',
    documentIds: result.writtenIds,
    warnings,
  };
}
