import {
  ADT_ACTION_VALUES,
  contentHash,
  documentIds,
  statusFromAdtAction,
  toOpenEnum,
  type Admission,
  type AdmissionStatus,
  type SyncSource,
} from '@rehabalpha/core';
import type { PccAdtRecord } from '@rehabalpha/pcc-client';
import { normalizeDate, normalizeInstant } from './normalize.js';
import type { Projection } from './patient.js';

export type AdmissionProjectionInput = {
  /** Every ADT record PCC holds for one patient. */
  pccAdtRecords: readonly PccAdtRecord[];
  therapyOrgId: string;
  facilityId: string;
  pccOrgUuid: string;
  pccFacId: string;
  patientId: string;
  pccPatientId: string;
  source: SyncSource;
  causedByEventId: string | null;
  now: string;
};

export type AdmissionTransformResult = {
  projections: Projection<Admission>[];
  /** ADT records that could not be attributed to a stay. Surfaced rather than dropped. */
  unattributed: { adtRecordId: string; reason: string }[];
};

function actionOf(record: PccAdtRecord): string {
  return toOpenEnum(ADT_ACTION_VALUES, record.actionCode ?? record.actionType).value;
}

function effectiveInstant(record: PccAdtRecord): string {
  return (
    normalizeInstant(record.effectiveDateTime) ??
    normalizeInstant(record.lastUpdateDatetime) ??
    '1970-01-01T00:00:00.000Z'
  );
}

function locationOf(record: PccAdtRecord): Admission['location'] {
  const unit = record.unitDescription ?? null;
  const room = record.roomDescription ?? null;
  const bed = record.bedDescription ?? null;
  return unit === null && room === null && bed === null ? null : { unit, room, bed };
}

/**
 * Folds a patient's ADT history into stays.
 *
 * PCC does not expose a mutable "admission" object; it exposes the event stream that produced
 * one. So a stay is reconstructed, and the identity of a stay is the patient plus the date they
 * were admitted. That choice matters for readmissions: Betty discharged in August and readmitted
 * in October is two stays, and keying on the patient alone would collapse them into one record
 * whose admit date silently changed.
 *
 * Events are folded in effective-time order rather than being read individually, because the
 * ordering is what carries the meaning. A leave of absence followed by a return is an active
 * stay; the same two events applied in the wrong order leaves the patient permanently out of the
 * building, off every caseload, with nothing logged.
 */
export function toAdmissionProjections(input: AdmissionProjectionInput): AdmissionTransformResult {
  const unattributed: { adtRecordId: string; reason: string }[] = [];

  const ordered = [...input.pccAdtRecords].sort((a, b) => {
    const byTime = effectiveInstant(a).localeCompare(effectiveInstant(b));
    // A stable tiebreak keeps the fold deterministic when two records share an instant, which
    // otherwise makes the resulting status depend on upstream array order.
    return byTime !== 0 ? byTime : a.adtRecordId.localeCompare(b.adtRecordId);
  });

  const groups = new Map<string, PccAdtRecord[]>();
  let currentAdmitDate: string | null = null;

  for (const record of ordered) {
    const recordAdmitDate = normalizeDate(record.admissionDate);
    if (recordAdmitDate !== null) {
      currentAdmitDate = recordAdmitDate;
    }

    if (currentAdmitDate === null) {
      // A transfer or discharge with no admit date anywhere in the history cannot be placed on a
      // stay. Reported so an operator can look at it, never guessed at.
      unattributed.push({
        adtRecordId: record.adtRecordId,
        reason: 'no_admission_date_in_history',
      });
      continue;
    }

    const bucket = groups.get(currentAdmitDate);
    if (bucket === undefined) {
      groups.set(currentAdmitDate, [record]);
    } else {
      bucket.push(record);
    }
  }

  const projections: Projection<Admission>[] = [];

  for (const [admitDate, records] of groups) {
    const pccAdmissionId = `${input.pccPatientId}:${admitDate}`;

    let status: AdmissionStatus = 'unknown';
    let dischargeDate: string | null = null;
    let location: Admission['location'] = null;

    for (const record of records) {
      status = statusFromAdtAction(actionOf(record), status);

      const recordDischargeDate = normalizeDate(record.dischargeDate);
      if (recordDischargeDate !== null) dischargeDate = recordDischargeDate;

      const recordLocation = locationOf(record);
      if (recordLocation !== null) location = recordLocation;
    }

    // A stay that is not over must not carry a discharge date: a stale one here is what makes a
    // patient vanish from a caseload after they have returned from hospital.
    if (status === 'admitted' || status === 'onLeaveOfAbsence') {
      dischargeDate = null;
    }

    const last = records[records.length - 1]!;
    const watermark = records.reduce<string | null>((newest, record) => {
      const candidate = normalizeInstant(record.lastUpdateDatetime);
      if (candidate === null) return newest;
      return newest === null || candidate > newest ? candidate : newest;
    }, null);

    const core = {
      status,
      admitDate,
      dischargeDate,
      location,
      lastAdt: {
        recordId: last.adtRecordId,
        action: toOpenEnum(ADT_ACTION_VALUES, last.actionCode ?? last.actionType),
        effectiveAt: effectiveInstant(last),
      },
    };

    const hash = contentHash(core);

    projections.push({
      document: {
        id: documentIds.admission(input.pccOrgUuid, pccAdmissionId),
        therapyOrgId: input.therapyOrgId,
        facilityId: input.facilityId,
        patientId: input.patientId,
        personId: null,
        pcc: {
          orgUuid: input.pccOrgUuid,
          facId: input.pccFacId,
          admissionId: pccAdmissionId,
          patientId: input.pccPatientId,
        },
        ...core,
        sync: {
          source: input.source,
          pccLastModified: watermark,
          syncedAt: input.now,
          syncVersion: 0,
          causedByEventId: input.causedByEventId,
          contentHash: hash,
        },
      },
      watermark,
      contentHash: hash,
    });
  }

  return { projections, unattributed };
}
