import { z } from 'zod';
import { isoDate, isoDateTime, openEnum } from '../schema-primitives.js';
import { syncMetadataSchema } from './sync-metadata.js';

/** PCC pick-list values drift, so this is an open enum rather than a closed one. */
export const ADMINISTRATIVE_SEX_VALUES = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'] as const;

export const administrativeSexSchema = openEnum(ADMINISTRATIVE_SEX_VALUES);

export const demographicsSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  middleName: z.string().nullable(),
  preferredName: z.string().nullable(),
  birthDate: isoDate.nullable(),
  administrativeSex: administrativeSexSchema,
  /** Facility-assigned medical record number. Identifying, never logged. */
  medicalRecordNumber: z.string().nullable(),
});
export type Demographics = z.infer<typeof demographicsSchema>;

export const personLinkMethodSchema = z.enum([
  /** PCC's own cross-facility master patient record. Authoritative, preferred. */
  'pccMasterPatient',
  /** PCC's patient match endpoint. Authoritative within a PCC organisation. */
  'pccMatchApi',
  /** Exact agreement on a strong local key. Safe to apply without review. */
  'deterministicLocal',
  /** Weighted similarity. Never applied automatically; always queued for a human. */
  'probabilisticLocal',
  /** A human in the operations console decided. */
  'operator',
]);
export type PersonLinkMethod = z.infer<typeof personLinkMethodSchema>;

export const personLinkSchema = z.object({
  method: personLinkMethodSchema,
  /** 0..1. Deterministic and PCC-sourced links are recorded as 1. */
  confidence: z.number().min(0).max(1),
  status: z.enum(['linked', 'pendingReview', 'rejected']),
  decidedAt: isoDateTime.nullable(),
  /** Firebase uid of the operator who confirmed or rejected, for the audit trail. */
  decidedByUid: z.string().nullable(),
});
export type PersonLink = z.infer<typeof personLinkSchema>;

/**
 * The master record for a human being within one tenant.
 *
 * Betty from the briefing is one `Person`. If she is discharged and later readmitted, or
 * moves to a second facility the same therapy company serves, that is one more `Patient`
 * projection pointing at the same `Person`. Therapists need her prior therapy history;
 * billing needs her prior coverage; both break if every admission creates a new human.
 */
export const personSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  /** Best-known values, sourced from the most recently updated linked patient record. */
  demographics: demographicsSchema,
  /**
   * Which patient projection these demographics came from, and how fresh it was upstream.
   *
   * Without this, the master record is whichever linked facility happened to sync last, so a stale
   * facility record can overwrite a corrected name. Comparing upstream freshness makes the
   * demographic merge deterministic instead of a race.
   */
  demographicsSource: z
    .object({
      patientId: z.string().min(1),
      pccLastModified: isoDateTime.nullable(),
    })
    .nullable(),
  /** Set when two person records were merged; the loser keeps a forwarding pointer. */
  mergedIntoPersonId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Person = z.infer<typeof personSchema>;

/**
 * A PCC patient record projected into RehabAlpha.
 *
 * This is a read model of upstream state, not a place therapists write to. Everything under
 * `demographics` and `pcc` is owned by PointClickCare; RehabAlpha-owned therapy data lives in
 * separate documents so that a sync can never overwrite a clinician's work. See
 * `policy/field-ownership.ts`.
 */
export const patientSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  /** Null while the record is waiting on identity review. */
  personId: z.string().nullable(),
  personLink: personLinkSchema.nullable(),
  pcc: z.object({
    orgUuid: z.string().min(1),
    facId: z.string().min(1),
    patientId: z.string().min(1),
    /** PCC's own lifecycle value for the record, e.g. Current, Discharged. */
    patientStatus: openEnum(['CURRENT', 'DISCHARGED', 'PENDING', 'CANCELLED', 'UNKNOWN']),
  }),
  demographics: demographicsSchema,
  /** Denormalised pointer so the caseload list does not need a second query per row. */
  currentAdmissionId: z.string().nullable(),
  sync: syncMetadataSchema,
});
export type Patient = z.infer<typeof patientSchema>;

/**
 * A proposed link between a patient projection and an existing person, awaiting a human.
 *
 * Auto-merging two patient records into one human on a similarity score is how EMRs produce
 * their worst class of incident: one person's therapy plan and coverage attached to another.
 * Splitting a wrongly merged chart afterwards is far harder than confirming a match once,
 * so anything short of an authoritative signal lands here instead.
 */
export const personMatchCandidateSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  patientId: z.string().min(1),
  candidatePersonId: z.string().min(1),
  score: z.number().min(0).max(1),
  /** Which fields agreed, so a reviewer can judge without opening both charts. */
  signals: z.object({
    birthDateMatches: z.boolean(),
    lastNameMatches: z.boolean(),
    firstNameSimilarity: z.number().min(0).max(1),
    medicalRecordNumberMatches: z.boolean(),
    sharesFacility: z.boolean(),
  }),
  status: z.enum(['pending', 'confirmed', 'rejected']),
  decidedByUid: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: isoDateTime,
});
export type PersonMatchCandidate = z.infer<typeof personMatchCandidateSchema>;
