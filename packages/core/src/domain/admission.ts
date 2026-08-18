import { z } from 'zod';
import { isoDate, isoDateTime, openEnum } from '../schema-primitives.js';
import { syncMetadataSchema } from './sync-metadata.js';

/**
 * PCC exposes stay lifecycle through ADT (admit / discharge / transfer) records rather than a
 * single mutable "admission" object. The action list PCC documents includes admission,
 * discharge, internal room transfer, death and leave of absence.
 *
 * Leave of absence deserves special mention because it is easy to model wrongly: the patient
 * is temporarily out of the building (a hospital visit, for example) but the stay has not
 * ended. Treating it as a discharge would drop the patient off every therapist's caseload and
 * then create a duplicate stay on return.
 */
export const ADT_ACTION_VALUES = [
  'ADMISSION',
  'READMISSION',
  'DISCHARGE',
  'INTERNAL_TRANSFER',
  'LEAVE_OF_ABSENCE',
  'RETURN_FROM_LEAVE',
  'DEATH',
  'CANCEL',
  'UNKNOWN',
] as const;

export const adtActionSchema = openEnum(ADT_ACTION_VALUES);

export const admissionStatusSchema = z.enum([
  'admitted',
  'onLeaveOfAbsence',
  'discharged',
  'deceased',
  'cancelled',
  'unknown',
]);
export type AdmissionStatus = z.infer<typeof admissionStatusSchema>;

export const admissionSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  patientId: z.string().min(1),
  /** Denormalised so a person's whole stay history can be read in one query. */
  personId: z.string().nullable(),
  pcc: z.object({
    orgUuid: z.string().min(1),
    facId: z.string().min(1),
    admissionId: z.string().min(1),
    patientId: z.string().min(1),
  }),
  status: admissionStatusSchema,
  admitDate: isoDate,
  dischargeDate: isoDate.nullable(),
  /** Current unit/room/bed. Changes on internal transfer and matters for scheduling. */
  location: z
    .object({
      unit: z.string().nullable(),
      room: z.string().nullable(),
      bed: z.string().nullable(),
    })
    .nullable(),
  /** Most recent ADT record we applied, so replays can be recognised as no-ops. */
  lastAdt: z
    .object({
      recordId: z.string().min(1),
      action: adtActionSchema,
      effectiveAt: isoDateTime,
    })
    .nullable(),
  sync: syncMetadataSchema,
});
export type Admission = z.infer<typeof admissionSchema>;

const STATUS_BY_ACTION: Record<string, AdmissionStatus> = {
  ADMISSION: 'admitted',
  READMISSION: 'admitted',
  RETURN_FROM_LEAVE: 'admitted',
  INTERNAL_TRANSFER: 'admitted',
  LEAVE_OF_ABSENCE: 'onLeaveOfAbsence',
  DISCHARGE: 'discharged',
  DEATH: 'deceased',
  CANCEL: 'cancelled',
};

/**
 * Maps an ADT action to the stay status. Unrecognised actions leave the status untouched
 * rather than resetting it, because guessing here would silently move patients on and off
 * caseloads when PCC introduces a new action type.
 */
export function statusFromAdtAction(action: string, current: AdmissionStatus): AdmissionStatus {
  return STATUS_BY_ACTION[action] ?? current;
}

/** A stay a therapist should currently see on their caseload. */
export function isActiveStay(admission: Admission): boolean {
  return admission.status === 'admitted' || admission.status === 'onLeaveOfAbsence';
}
