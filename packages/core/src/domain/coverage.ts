import { z } from 'zod';
import { isoDate, isoDateTime, openEnum } from '../schema-primitives.js';
import { syncMetadataSchema } from './sync-metadata.js';

/** Matches the payer categories PCC exposes, left open for values added upstream. */
export const PAYER_TYPE_VALUES = [
  'MEDICARE',
  'MEDICAID',
  'PRIVATE_PAY',
  'INSURANCE',
  'VA',
  'OTHER',
  'UNKNOWN',
] as const;

export const payerTypeSchema = openEnum(PAYER_TYPE_VALUES);

/**
 * PCC returns coverage as a payer tree plus a set of informational payers. Rank is what
 * decides billing order, and `informational` payers must never be billed — conflating them
 * with a real secondary is how a claim goes to the wrong party.
 */
export const coverageRankSchema = z.enum([
  'primary',
  'secondary',
  'tertiary',
  'informational',
  'unknown',
]);
export type CoverageRank = z.infer<typeof coverageRankSchema>;

export const coverageStatusSchema = z.enum([
  /** Currently our belief and currently in force. */
  'active',
  /** Still our belief, but its real-world validity has ended. */
  'ended',
  /** No longer our belief: a corrected record replaced it. */
  'superseded',
]);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

export const coverageClosureReasonSchema = z.enum([
  /** PCC gave us an explicit end date. */
  'endedUpstream',
  /**
   * The payer vanished from the PCC response without an end date. We close the row as of the
   * day we noticed instead of deleting it, and flag it, because a disappearing payer is
   * usually a correction in PCC rather than a real coverage change.
   */
  'withdrawnUpstream',
  /** Replaced by a corrected version of the same coverage. */
  'supersededByCorrection',
]);

/**
 * A patient's coverage by one payer, recorded bitemporally.
 *
 * Two independent time axes, and conflating them is the classic healthcare-billing bug:
 *
 *   effectiveFrom / effectiveTo   when the coverage was in force in the real world
 *   recordedAt / supersededAt     when RehabAlpha believed that, in system time
 *
 * Both are needed because claims are submitted, denied and resubmitted months later, and the
 * question "what did we believe Betty's primary payer was on 3 March, and when did we learn
 * otherwise" has to be answerable. A single mutable row cannot answer it.
 *
 * Consequently, coverage is never deleted. A payer removed in PCC is closed with an end date
 * and a reason. Hard-deleting the row would destroy the basis of every claim already
 * submitted against it, and would take the audit trail with it.
 */
export const coverageSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  patientId: z.string().min(1),
  personId: z.string().nullable(),
  /** Null when PCC reports coverage at patient rather than stay level. */
  admissionId: z.string().nullable(),

  payer: z.object({
    pccPayerId: z.string().min(1),
    name: z.string().min(1),
    payerType: payerTypeSchema,
    planName: z.string().nullable(),
  }),
  rank: coverageRankSchema,

  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),

  recordedAt: isoDateTime,
  supersededAt: isoDateTime.nullable(),
  supersededByCoverageId: z.string().nullable(),

  status: coverageStatusSchema,
  closure: z
    .object({
      reason: coverageClosureReasonSchema,
      closedAt: isoDateTime,
      /** True when we inferred the end date rather than being told it. Surfaced to operators. */
      inferred: z.boolean(),
    })
    .nullable(),

  /**
   * Authorisation as asserted by PCC. Whether therapy needs prior authorisation, and the
   * approved visit count, materially changes what a therapist is allowed to schedule.
   */
  authorization: z
    .object({
      required: z.boolean(),
      number: z.string().nullable(),
      validFrom: isoDate.nullable(),
      validTo: isoDate.nullable(),
      approvedVisits: z.number().int().nonnegative().nullable(),
    })
    .nullable(),

  sync: syncMetadataSchema,
});
export type Coverage = z.infer<typeof coverageSchema>;

const RANK_ORDER: Record<CoverageRank, number> = {
  primary: 0,
  secondary: 1,
  tertiary: 2,
  unknown: 3,
  informational: 4,
};

/** Billing order. Informational payers sort last because they are never billed. */
export function compareCoverageRank(a: CoverageRank, b: CoverageRank): number {
  return RANK_ORDER[a] - RANK_ORDER[b];
}

/**
 * The tuple PCC effectively treats as identifying a coverage row. Used to decide whether an
 * incoming coverage is an update to an existing row or a genuinely new one: the same payer
 * re-added with a different effective date is new coverage, not an edit.
 */
export function coverageIdentityKey(input: {
  payer: { pccPayerId: string };
  effectiveFrom: string;
}): string {
  return `${input.payer.pccPayerId}@${input.effectiveFrom}`;
}

/** Whether the coverage was in force on a calendar date, according to our current belief. */
export function isCoverageInForceOn(coverage: Coverage, date: string): boolean {
  if (coverage.status === 'superseded') return false;
  if (date < coverage.effectiveFrom) return false;
  return coverage.effectiveTo === null || date <= coverage.effectiveTo;
}

/** Reconstructs what we believed on a past instant. This is what makes the model auditable. */
export function wasBelievedAt(coverage: Coverage, instant: string): boolean {
  if (coverage.recordedAt > instant) return false;
  return coverage.supersededAt === null || coverage.supersededAt > instant;
}
