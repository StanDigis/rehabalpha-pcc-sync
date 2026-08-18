import {
  compareCoverageRank,
  coverageIdentityKey,
  type Coverage,
  type CoverageRank,
} from '../domain/coverage.js';

export type DesiredCoverage = {
  /**
   * Reuses the stored shape rather than restating a looser one. A structurally similar duplicate
   * would widen `payerType.value` back to `string`, and the whole point of the open enum is that the
   * normalised value stays a closed union while the raw upstream string is kept alongside it.
   */
  payer: Coverage['payer'];
  rank: CoverageRank;
  effectiveFrom: string;
  effectiveTo: string | null;
  authorization: Coverage['authorization'];
};

export type CoverageTimelineAction =
  | { kind: 'create'; coverageId: string; desired: DesiredCoverage }
  | { kind: 'update'; coverageId: string; desired: DesiredCoverage; changedFields: string[] }
  | { kind: 'reopen'; coverageId: string; desired: DesiredCoverage }
  | {
      kind: 'close';
      coverageId: string;
      effectiveTo: string;
      reason: 'endedUpstream' | 'withdrawnUpstream';
      inferred: boolean;
    }
  | { kind: 'unchanged'; coverageId: string };

export type CoverageWarning = {
  code:
    /**
     * An open coverage vanished from the PCC response with no end date. Ambiguous, because
     * PCC returns only the current payer tree by default, so absence can mean "ended", "was
     * corrected away" or simply "not current any more".
     */
    | 'withdrawnWithoutEndDate'
    /** Two payers claim the same rank over overlapping dates. Billing cannot resolve this. */
    | 'overlappingRank'
    /** effectiveTo precedes effectiveFrom. Upstream data problem; the row is not applied. */
    | 'invertedEffectiveRange'
    /** No primary payer in force. Therapy may proceed, but claims cannot be assembled. */
    | 'noPrimaryInForce';
  detail: Record<string, string | number | boolean | null>;
};

export type ReconcileCoverageInput = {
  /** The coverage set PCC currently asserts for the patient. */
  desired: readonly DesiredCoverage[];
  /** Every coverage row we hold for the patient, including already-closed ones. */
  stored: readonly Coverage[];
  /** Calendar date used when an end date has to be inferred. Facility-local, not UTC. */
  today: string;
  /** Builds the deterministic document id for a new coverage row. */
  buildCoverageId: (payerId: string, effectiveFrom: string) => string;
};

export type ReconcileCoverageResult = {
  actions: CoverageTimelineAction[];
  warnings: CoverageWarning[];
};

function authorizationEqual(a: Coverage['authorization'], b: Coverage['authorization']): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.required === b.required &&
    a.number === b.number &&
    a.validFrom === b.validFrom &&
    a.validTo === b.validTo &&
    a.approvedVisits === b.approvedVisits
  );
}

function changedFieldsBetween(stored: Coverage, desired: DesiredCoverage): string[] {
  const changed: string[] = [];

  if (stored.rank !== desired.rank) changed.push('rank');
  if (stored.effectiveTo !== desired.effectiveTo) changed.push('effectiveTo');
  if (stored.payer.name !== desired.payer.name) changed.push('payer.name');
  if (stored.payer.planName !== desired.payer.planName) changed.push('payer.planName');
  if (stored.payer.payerType.raw !== desired.payer.payerType.raw) changed.push('payer.payerType');
  if (!authorizationEqual(stored.authorization, desired.authorization))
    changed.push('authorization');

  return changed;
}

function rangesOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  const aEnd = aTo ?? '9999-12-31';
  const bEnd = bTo ?? '9999-12-31';
  return aFrom <= bEnd && bFrom <= aEnd;
}

/**
 * Reconciles the coverage PCC asserts against the coverage we hold, producing actions rather
 * than performing writes.
 *
 * Three decisions define this function, and they are the ones a naive implementation gets
 * wrong.
 *
 * First, nothing is ever deleted. Coverage is the basis of every claim already submitted; a
 * payer that disappears is closed with an end date and a reason. Deleting the row destroys
 * both the billing history and the ability to explain a denial three months later.
 *
 * Second, absence upstream is treated as ambiguous, not as proof of termination. PCC returns
 * the current payer tree by default, so a coverage that ended last year is simply not in the
 * response. Only rows we still believe to be open — `effectiveTo` of null — are candidates for
 * closure, and when we have to invent the end date the row is marked `inferred` and a warning
 * is raised for a human. Confidently back-dating a coverage end is how a facility's correction
 * in PCC turns into a wrongly denied claim in RehabAlpha.
 *
 * Third, identity is the payer plus the date the coverage took effect, not the payer alone.
 * Medicare Part A ending and a new Part A period starting in March is two coverage rows, and
 * collapsing them into one edit loses the gap that determines what was billable in February.
 */
export function reconcileCoverageTimeline({
  desired,
  stored,
  today,
  buildCoverageId,
}: ReconcileCoverageInput): ReconcileCoverageResult {
  const actions: CoverageTimelineAction[] = [];
  const warnings: CoverageWarning[] = [];

  const applicable: DesiredCoverage[] = [];
  for (const candidate of desired) {
    if (candidate.effectiveTo !== null && candidate.effectiveTo < candidate.effectiveFrom) {
      warnings.push({
        code: 'invertedEffectiveRange',
        detail: {
          pccPayerId: candidate.payer.pccPayerId,
          effectiveFrom: candidate.effectiveFrom,
          effectiveTo: candidate.effectiveTo,
        },
      });
      continue;
    }
    applicable.push(candidate);
  }

  const storedByKey = new Map(stored.map((row) => [coverageIdentityKey(row), row]));
  const desiredKeys = new Set(applicable.map((row) => coverageIdentityKey(row)));

  for (const candidate of applicable) {
    const key = coverageIdentityKey(candidate);
    const existing = storedByKey.get(key);

    if (existing === undefined) {
      actions.push({
        kind: 'create',
        coverageId: buildCoverageId(candidate.payer.pccPayerId, candidate.effectiveFrom),
        desired: candidate,
      });
      continue;
    }

    // Upstream asserts a coverage we had previously closed. That is a correction on their side,
    // so the row is reopened rather than a duplicate being created next to it.
    if (existing.status !== 'active' || existing.closure !== null) {
      actions.push({ kind: 'reopen', coverageId: existing.id, desired: candidate });
      continue;
    }

    const changedFields = changedFieldsBetween(existing, candidate);
    actions.push(
      changedFields.length === 0
        ? { kind: 'unchanged', coverageId: existing.id }
        : { kind: 'update', coverageId: existing.id, desired: candidate, changedFields },
    );
  }

  for (const row of stored) {
    if (desiredKeys.has(coverageIdentityKey(row))) continue;
    if (row.status !== 'active') continue;

    // Already carries an end date, so PCC omitting it from the current tree is expected.
    if (row.effectiveTo !== null) continue;

    actions.push({
      kind: 'close',
      coverageId: row.id,
      effectiveTo: today,
      reason: 'withdrawnUpstream',
      inferred: true,
    });
    warnings.push({
      code: 'withdrawnWithoutEndDate',
      detail: {
        coverageId: row.id,
        pccPayerId: row.payer.pccPayerId,
        assumedEffectiveTo: today,
      },
    });
  }

  warnings.push(...validateRanks(applicable, today));

  return { actions, warnings };
}

function validateRanks(desired: readonly DesiredCoverage[], today: string): CoverageWarning[] {
  const warnings: CoverageWarning[] = [];
  const billable = desired.filter((row) => row.rank !== 'informational' && row.rank !== 'unknown');

  for (let i = 0; i < billable.length; i += 1) {
    for (let j = i + 1; j < billable.length; j += 1) {
      const a = billable[i];
      const b = billable[j];
      if (a === undefined || b === undefined) continue;
      if (a.rank !== b.rank) continue;
      if (!rangesOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) continue;

      warnings.push({
        code: 'overlappingRank',
        detail: { rank: a.rank, first: a.payer.pccPayerId, second: b.payer.pccPayerId },
      });
    }
  }

  const primaryInForce = billable.some(
    (row) =>
      row.rank === 'primary' &&
      row.effectiveFrom <= today &&
      (row.effectiveTo === null || row.effectiveTo >= today),
  );

  if (desired.length > 0 && !primaryInForce) {
    warnings.push({ code: 'noPrimaryInForce', detail: { today } });
  }

  return warnings;
}

/** Coverage in force on a date, in billing order. */
export function coverageInForceOn(coverages: readonly Coverage[], date: string): Coverage[] {
  return coverages
    .filter((row) => row.status !== 'superseded')
    .filter(
      (row) => row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo >= date),
    )
    .sort((a, b) => compareCoverageRank(a.rank, b.rank));
}
