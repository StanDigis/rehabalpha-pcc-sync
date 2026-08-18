import {
  PermanentSyncError,
  type SyncScope,
  type SyncSource,
  type SyncTask,
} from '@rehabalpha/core';
import { syncAdmissions } from './admission-sync.js';
import { resolveSyncContext, skippedOutcome, type SyncDeps, type SyncOutcome } from './context.js';
import { syncCoverage } from './coverage-sync.js';
import { resolvePatientIdentity } from './identity-sync.js';
import { writePatientProjection } from './patient-sync.js';

export type SyncRequest = {
  therapyOrgId: string;
  pccOrgUuid: string;
  pccFacId: string | null;
  pccPatientId: string;
  scope: SyncScope;
  source: SyncSource;
  causedByEventId: string | null;
  force?: boolean;
};

export class SyncEngine {
  constructor(private readonly deps: SyncDeps) {}

  async handleTask(task: SyncTask): Promise<SyncOutcome[]> {
    return this.sync({
      therapyOrgId: task.therapyOrgId,
      pccOrgUuid: task.pccOrgUuid,
      pccFacId: task.pccFacId,
      pccPatientId: task.entityPccId,
      scope: task.scope,
      source: task.reason,
      causedByEventId: task.causedByEventId,
    });
  }

  /**
   * Synchronises one patient, and whichever of their stays and coverage the caller asked for.
   *
   * The patient projection is always written first, whatever the scope, and that costs one extra
   * PCC read on a coverage-only event. It buys two things worth more than the read. It removes any
   * ordering dependency between event types — a coverage notification that arrives before we have
   * ever heard of the patient still works, instead of failing and waiting for a retry to overtake a
   * patient event that may never come. And the patient record is where the authoritative facility
   * lives, which is what the contract check needs.
   */
  async sync(request: SyncRequest): Promise<SyncOutcome[]> {
    const logger = this.deps.logger.child({
      therapyOrgId: request.therapyOrgId,
      ...(request.causedByEventId !== null ? { correlationId: request.causedByEventId } : {}),
    });

    const pccPatient = await this.deps.pcc.getPatient(request.pccOrgUuid, request.pccPatientId);

    // The notification's facility is a hint; the patient record decides. An internal transfer
    // between two facilities in the same organisation would otherwise be applied against the
    // facility the patient just left, and the contract check would consult the wrong contract.
    const pccFacId = pccPatient.facId ?? request.pccFacId;
    if (pccFacId === null || pccFacId === undefined) {
      throw new PermanentSyncError(
        'pcc_patient_without_facility',
        'PCC patient record carries no facility and the notification did not supply one',
      );
    }

    const resolution = await resolveSyncContext(
      { ...this.deps, logger },
      {
        therapyOrgId: request.therapyOrgId,
        pccOrgUuid: request.pccOrgUuid,
        pccFacId,
        source: request.source,
        causedByEventId: request.causedByEventId,
      },
    );

    if (!resolution.ok) {
      return [skippedOutcome('patient', request.pccPatientId, resolution.skipReason)];
    }

    const context = resolution.context;
    const deps = { ...this.deps, logger };
    const outcomes: SyncOutcome[] = [];

    const patientResult = await writePatientProjection(
      deps,
      context,
      pccPatient,
      request.force === true ? { force: true } : {},
    );
    outcomes.push(patientResult.outcome);

    const identityOutcome = await resolvePatientIdentity(deps, context, patientResult.patient);
    if (identityOutcome.decision !== 'identityAlreadyLinked') {
      outcomes.push(identityOutcome);
    }

    // Re-read is deliberate: identity resolution may have set `personId`, and the denormalised
    // pointer has to be present on the stays and coverage rows written next.
    const patient =
      (await deps.store.getPatient(patientResult.patient.id)) ?? patientResult.patient;

    if (request.scope === 'admission' || request.scope === 'all') {
      outcomes.push(
        await syncAdmissions(deps, context, patient, request.force === true ? { force: true } : {}),
      );
    }

    if (request.scope === 'coverage' || request.scope === 'all') {
      // Coverage links to the current stay, so it is written after admissions when both are in
      // scope: the other order attaches coverage to a stay pointer that is about to change.
      const refreshed =
        request.scope === 'all' ? ((await deps.store.getPatient(patient.id)) ?? patient) : patient;
      outcomes.push(await syncCoverage(deps, context, refreshed));
    }

    logger.info('Sync completed', {
      scope: request.scope,
      source: request.source,
      facilityId: context.facilityId,
      applied: outcomes.filter((outcome) => outcome.applied).map((outcome) => outcome.entityType),
      decisions: outcomes.map((outcome) => outcome.decision),
      warningCodes: outcomes.flatMap((outcome) => outcome.warnings.map((warning) => warning.code)),
    });

    return outcomes;
  }
}
