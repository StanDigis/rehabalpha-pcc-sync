import { decideWrite, isActiveStay, type Admission, type Patient } from '@rehabalpha/core';
import { toAdmissionProjections } from '../transform/admission.js';
import type { ResolvedContext, SyncDeps, SyncOutcome, SyncWarning } from './context.js';

/**
 * Rebuilds every stay for a patient from their ADT history, in one transaction.
 *
 * All of a patient's stays are written together rather than one at a time because they are not
 * independent: which stay is current, and therefore whose caseload the patient appears on, is a
 * property of the set. Writing them individually leaves a window where a discharge has landed but
 * the patient still points at the closed stay, and a therapist looking at that moment sees a
 * discharged patient as active — or, worse, the reverse.
 */
export async function syncAdmissions(
  deps: SyncDeps,
  context: ResolvedContext,
  patient: Patient,
  options: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const adtRecords = await deps.pcc.listAdtRecords(context.pccOrgUuid, patient.pcc.patientId);

  const now = deps.clock.now();
  const { projections, unattributed } = toAdmissionProjections({
    pccAdtRecords: adtRecords,
    therapyOrgId: context.therapyOrgId,
    facilityId: context.facilityId,
    pccOrgUuid: context.pccOrgUuid,
    pccFacId: context.pccFacId,
    patientId: patient.id,
    pccPatientId: patient.pcc.patientId,
    source: context.source,
    causedByEventId: context.causedByEventId,
    now,
  });

  const warnings: SyncWarning[] = unattributed.map((record) => ({
    code: 'admission.unattributedAdtRecord',
    detail: { adtRecordId: record.adtRecordId, reason: record.reason },
  }));

  if (projections.length === 0) {
    return {
      entityType: 'admission',
      entityPccId: patient.pcc.patientId,
      applied: false,
      decision: 'noAdtRecords',
      documentIds: [],
      warnings,
    };
  }

  const admissionRefs = projections.map((projection) =>
    deps.store.admissions().doc(projection.document.id),
  );
  const patientRef = deps.store.patients().doc(patient.id);

  const applied = await deps.store.db.runTransaction(async (tx) => {
    // Firestore requires every read in a transaction to precede every write, so the whole working
    // set is fetched up front. Two calls rather than one because `getAll` is typed for a single
    // converter and mixing patient and admission references in it loses that typing.
    const [patientSnapshot, admissionSnapshots] = await Promise.all([
      tx.get(patientRef),
      tx.getAll(...admissionRefs),
    ]);

    const storedPatient = patientSnapshot.exists ? patientSnapshot.data()! : patient;
    const writtenIds: string[] = [];
    const finalStays: Admission[] = [];

    for (const [index, projection] of projections.entries()) {
      const snapshot = admissionSnapshots[index];
      const stored = snapshot?.exists === true ? (snapshot.data() ?? null) : null;

      const decision = decideWrite(
        { pccLastModified: projection.watermark, contentHash: projection.contentHash },
        stored === null
          ? null
          : { pccLastModified: stored.sync.pccLastModified, contentHash: stored.sync.contentHash },
        options.force === true ? { force: true } : {},
      );

      if (decision.action === 'skip') {
        finalStays.push(stored!);
        continue;
      }

      if (decision.action === 'advanceWatermark') {
        const ref = admissionRefs[index]!;
        tx.update(ref, { 'sync.pccLastModified': projection.watermark, 'sync.syncedAt': now });
        finalStays.push(stored!);
        continue;
      }

      const next: Admission = {
        ...projection.document,
        // Derived from the linked patient on every write, so that confirming an identity link
        // later propagates to the stays without a separate backfill.
        personId: storedPatient.personId,
        sync: {
          ...projection.document.sync,
          syncVersion: (stored?.sync.syncVersion ?? 0) + 1,
        },
      };

      tx.set(admissionRefs[index]!, next);
      writtenIds.push(next.id);
      finalStays.push(next);

      deps.audit.recordIn(
        tx,
        deps.audit.system({
          therapyOrgId: context.therapyOrgId,
          facilityId: context.facilityId,
          action: stored === null ? 'admission.created' : 'admission.updated',
          target: { type: 'admission', id: next.id },
          outcome: 'success',
          correlationId: context.causedByEventId,
          detail: {
            decision: decision.action === 'update' ? decision.reason : 'create',
            status: next.status,
            previousStatus: stored?.status ?? null,
            admitDate: next.admitDate,
            source: context.source,
          },
        }),
      );
    }

    // The current stay is whichever active stay was admitted most recently. A patient out on leave
    // of absence is still current: they have not been discharged, and dropping them from the
    // caseload for two days would take their therapy plan with them.
    const currentStay =
      finalStays
        .filter((stay) => isActiveStay(stay))
        .sort((a, b) => a.admitDate.localeCompare(b.admitDate))
        .at(-1) ?? null;

    const currentAdmissionId = currentStay?.id ?? null;
    if (storedPatient.currentAdmissionId !== currentAdmissionId) {
      tx.update(patientRef, { currentAdmissionId });
    }

    return { writtenIds, currentAdmissionId };
  });

  return {
    entityType: 'admission',
    entityPccId: patient.pcc.patientId,
    applied: applied.writtenIds.length > 0,
    decision: applied.writtenIds.length > 0 ? 'applied' : 'contentUnchanged',
    documentIds: applied.writtenIds,
    warnings,
  };
}
