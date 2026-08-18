import {
  ADMINISTRATIVE_SEX_VALUES,
  contentHash,
  documentIds,
  toOpenEnum,
  type Demographics,
  type Patient,
  type SyncSource,
} from '@rehabalpha/core';
import type { PccPatient } from '@rehabalpha/pcc-client';
import { normalizeDate, normalizeInstant, requireField } from './normalize.js';

export type PatientProjectionInput = {
  pccPatient: PccPatient;
  therapyOrgId: string;
  facilityId: string;
  pccOrgUuid: string;
  pccFacId: string;
  source: SyncSource;
  causedByEventId: string | null;
  now: string;
};

export type Projection<T> = {
  document: T;
  /** Upstream modification instant, or null when PCC did not provide one. */
  watermark: string | null;
  /** Hash over the upstream-owned fields only, used to suppress no-op writes. */
  contentHash: string;
};

const PATIENT_STATUS_VALUES = ['CURRENT', 'DISCHARGED', 'PENDING', 'CANCELLED', 'UNKNOWN'] as const;

/**
 * Projects a PCC patient onto the RehabAlpha read model.
 *
 * The identity fields — `personId`, `personLink` — are emitted as null even though a stored
 * document may already have them. That is intentional: `planProjectionWrite` restores them from
 * the stored document because they are RehabAlpha-owned, so the transformer stays a pure
 * function of upstream state and cannot accidentally become a place where local decisions leak
 * in. See `policy/field-ownership.ts` in @rehabalpha/core.
 */
export function toPatientProjection(input: PatientProjectionInput): Projection<Patient> {
  const { pccPatient } = input;

  const demographics: Demographics = {
    firstName: requireField(pccPatient.firstName, 'firstName', 'patient'),
    lastName: requireField(pccPatient.lastName, 'lastName', 'patient'),
    middleName: pccPatient.middleName ?? null,
    preferredName: pccPatient.preferredName ?? null,
    birthDate: normalizeDate(pccPatient.birthDate),
    administrativeSex: toOpenEnum(ADMINISTRATIVE_SEX_VALUES, pccPatient.gender),
    medicalRecordNumber: pccPatient.medicalRecordNumber ?? null,
  };

  const pcc = {
    orgUuid: input.pccOrgUuid,
    facId: input.pccFacId,
    patientId: pccPatient.patientId,
    patientStatus: toOpenEnum(PATIENT_STATUS_VALUES, pccPatient.patientStatus),
  };

  const watermark = normalizeInstant(pccPatient.lastUpdateDatetime);

  const document: Patient = {
    id: documentIds.patient(input.pccOrgUuid, pccPatient.patientId),
    therapyOrgId: input.therapyOrgId,
    facilityId: input.facilityId,
    personId: null,
    personLink: null,
    pcc,
    demographics,
    currentAdmissionId: null,
    sync: {
      source: input.source,
      pccLastModified: watermark,
      syncedAt: input.now,
      syncVersion: 0,
      causedByEventId: input.causedByEventId,
      contentHash: '',
    },
  };

  // Provenance is excluded from the hash: `syncedAt` moves on every pass, so including it
  // would make every comparison report a change and defeat no-op suppression.
  const hash = contentHash({ demographics, pcc });
  document.sync.contentHash = hash;

  return { document, watermark, contentHash: hash };
}
