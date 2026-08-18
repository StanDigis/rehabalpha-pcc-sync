import {
  PAYER_TYPE_VALUES,
  toOpenEnum,
  type CoverageRank,
  type DesiredCoverage,
} from '@rehabalpha/core';
import type { PccCoverage } from '@rehabalpha/pcc-client';
import { normalizeDate, normalizeInstant } from './normalize.js';

export type CoverageTransformResult = {
  desired: DesiredCoverage[];
  /** Rows that cannot be placed on a timeline. Reported to operators, never silently dropped. */
  skipped: { pccPayerId: string; reason: string }[];
  watermark: string | null;
};

const RANK_BY_UPSTREAM: Record<string, CoverageRank> = {
  PRIMARY: 'primary',
  P: 'primary',
  '1': 'primary',
  SECONDARY: 'secondary',
  S: 'secondary',
  '2': 'secondary',
  TERTIARY: 'tertiary',
  T: 'tertiary',
  '3': 'tertiary',
};

function rankOf(coverage: PccCoverage): CoverageRank {
  // Informational payers exist on the tree to record who else is involved — a responsible family
  // member, for instance. They are not billable, and treating one as a real secondary sends a
  // claim to somebody who never agreed to pay it.
  if (coverage.informationalOnly === true) return 'informational';

  const raw = (coverage.payerRank ?? '').trim().toUpperCase();
  return RANK_BY_UPSTREAM[raw] ?? 'unknown';
}

function authorizationOf(coverage: PccCoverage): DesiredCoverage['authorization'] {
  const hasAnySignal =
    coverage.authorizationRequired != null ||
    coverage.authorizationNumber != null ||
    coverage.approvedVisits != null ||
    coverage.authorizationEffectiveDate != null;

  if (!hasAnySignal) return null;

  return {
    required: coverage.authorizationRequired ?? false,
    number: coverage.authorizationNumber ?? null,
    validFrom: normalizeDate(coverage.authorizationEffectiveDate),
    validTo: normalizeDate(coverage.authorizationExpirationDate),
    approvedVisits: coverage.approvedVisits ?? null,
  };
}

/**
 * Maps a PCC coverage tree onto the dated coverage rows the timeline policy consumes.
 *
 * A coverage with no effective date is skipped rather than back-filled. The tempting fallback is
 * the admission date, and it is wrong: the effective date is what decides which payer is liable
 * for a given visit, so inventing one produces claims that look correct and get denied. Skipping
 * and reporting keeps the gap visible, and a missing effective date in PCC is a data-entry
 * problem the facility can fix in minutes once somebody tells them.
 */
export function toDesiredCoverages(pccCoverages: readonly PccCoverage[]): CoverageTransformResult {
  const desired: DesiredCoverage[] = [];
  const skipped: { pccPayerId: string; reason: string }[] = [];
  let watermark: string | null = null;

  for (const coverage of pccCoverages) {
    const candidate = normalizeInstant(coverage.lastUpdateDatetime);
    if (candidate !== null && (watermark === null || candidate > watermark)) {
      watermark = candidate;
    }

    const effectiveFrom = normalizeDate(coverage.effectiveDate);
    if (effectiveFrom === null) {
      skipped.push({ pccPayerId: coverage.payerId, reason: 'missing_effective_date' });
      continue;
    }

    desired.push({
      payer: {
        pccPayerId: coverage.payerId,
        name: coverage.payerName,
        payerType: toOpenEnum(PAYER_TYPE_VALUES, coverage.payerType),
        planName: coverage.planName ?? null,
      },
      rank: rankOf(coverage),
      effectiveFrom,
      effectiveTo: normalizeDate(coverage.expirationDate),
      authorization: authorizationOf(coverage),
    });
  }

  return { desired, skipped, watermark };
}
