import { describe, expect, it } from 'vitest';
import type { Coverage } from '../domain/coverage.js';
import { PAYER_TYPE_VALUES } from '../domain/coverage.js';
import { toOpenEnum } from '../schema-primitives.js';
import {
  reconcileCoverageTimeline,
  type CoverageTimelineAction,
  type DesiredCoverage,
} from './coverage-timeline.js';

const TODAY = '2026-03-15';

function desired(overrides: Partial<DesiredCoverage> = {}): DesiredCoverage {
  return {
    payer: {
      pccPayerId: 'payer-medicare-a',
      name: 'Medicare Part A',
      payerType: toOpenEnum(PAYER_TYPE_VALUES, 'MEDICARE'),
      planName: null,
    },
    rank: 'primary',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    authorization: null,
    ...overrides,
  };
}

function stored(overrides: Partial<Coverage> = {}): Coverage {
  const base: Coverage = {
    id: 'cov_1',
    therapyOrgId: 'org_1',
    facilityId: 'fac_1',
    patientId: 'pat_1',
    personId: 'per_1',
    admissionId: 'adm_1',
    payer: {
      pccPayerId: 'payer-medicare-a',
      name: 'Medicare Part A',
      payerType: toOpenEnum(PAYER_TYPE_VALUES, 'MEDICARE'),
      planName: null,
    },
    rank: 'primary',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    recordedAt: '2026-01-02T00:00:00.000Z',
    supersededAt: null,
    supersededByCoverageId: null,
    status: 'active',
    closure: null,
    authorization: null,
    sync: {
      source: 'webhook',
      pccLastModified: '2026-01-02T00:00:00.000Z',
      syncedAt: '2026-01-02T00:00:00.000Z',
      syncVersion: 1,
      causedByEventId: null,
      contentHash: 'hash-1',
    },
  };
  return { ...base, ...overrides };
}

function buildCoverageId(payerId: string, effectiveFrom: string): string {
  return `cov_${payerId}_${effectiveFrom}`;
}

function run(input: { desired?: DesiredCoverage[]; stored?: Coverage[]; today?: string }) {
  return reconcileCoverageTimeline({
    desired: input.desired ?? [],
    stored: input.stored ?? [],
    today: input.today ?? TODAY,
    buildCoverageId,
  });
}

function kinds(actions: readonly CoverageTimelineAction[]): string[] {
  return actions.map((action) => action.kind);
}

function codes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe('reconcileCoverageTimeline', () => {
  it('creates a coverage row that PCC asserts and we do not hold', () => {
    const result = run({ desired: [desired()] });

    expect(kinds(result.actions)).toEqual(['create']);
    expect(result.actions[0]).toMatchObject({
      kind: 'create',
      coverageId: 'cov_payer-medicare-a_2026-01-01',
    });
  });

  it('reports no action when nothing about the coverage changed', () => {
    const result = run({ desired: [desired()], stored: [stored()] });

    expect(kinds(result.actions)).toEqual(['unchanged']);
    expect(result.warnings).toEqual([]);
  });

  it('names the fields that changed so the audit entry can be specific', () => {
    const result = run({
      desired: [desired({ rank: 'secondary', payer: { ...desired().payer, planName: 'Plan B' } })],
      stored: [stored()],
    });

    expect(result.actions[0]).toMatchObject({
      kind: 'update',
      coverageId: 'cov_1',
      changedFields: ['rank', 'payer.planName'],
    });
  });

  /**
   * The behaviour this whole policy exists for. PCC returns the current payer tree, so a coverage
   * that ended is simply absent — indistinguishable from one that was removed in error. Deleting the
   * row would destroy the basis of every claim already submitted against it.
   */
  it('closes a coverage that vanished upstream instead of deleting it', () => {
    const result = run({ stored: [stored()] });

    expect(result.actions).toEqual([
      {
        kind: 'close',
        coverageId: 'cov_1',
        effectiveTo: TODAY,
        reason: 'withdrawnUpstream',
        inferred: true,
      },
    ]);
  });

  it('flags an inferred closure for review because the end date is a guess', () => {
    const result = run({ stored: [stored()] });

    expect(codes(result.warnings)).toContain('withdrawnWithoutEndDate');
    expect(result.warnings[0]!.detail).toMatchObject({ assumedEffectiveTo: TODAY });
  });

  it('leaves an already-ended coverage alone when upstream omits it', () => {
    const result = run({ stored: [stored({ effectiveTo: '2026-02-28' })] });

    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('does not re-close a coverage that is already closed', () => {
    const result = run({
      stored: [
        stored({
          status: 'ended',
          effectiveTo: '2026-02-28',
          closure: {
            reason: 'endedUpstream',
            inferred: false,
            closedAt: '2026-03-01T00:00:00.000Z',
          },
        }),
      ],
    });

    expect(result.actions).toEqual([]);
  });

  /**
   * A payer plus an effective date is the identity, not the payer alone. Part A ending in February
   * and a fresh Part A period starting in March are two rows; collapsing them into one edit erases
   * the gap that decides what was billable in between.
   */
  it('treats a new period for the same payer as a new coverage row', () => {
    const result = run({
      desired: [desired({ effectiveFrom: '2026-03-01' })],
      stored: [stored({ effectiveTo: '2026-02-28', status: 'active' })],
    });

    expect(kinds(result.actions).sort()).toEqual(['create']);
    expect(result.actions[0]).toMatchObject({ coverageId: 'cov_payer-medicare-a_2026-03-01' });
  });

  it('reopens a coverage PCC asserts again after we closed it', () => {
    const result = run({
      desired: [desired()],
      stored: [
        stored({
          status: 'ended',
          closure: {
            reason: 'withdrawnUpstream',
            inferred: true,
            closedAt: '2026-03-01T00:00:00.000Z',
          },
        }),
      ],
    });

    expect(result.actions).toEqual([{ kind: 'reopen', coverageId: 'cov_1', desired: desired() }]);
  });

  it('drops a coverage whose end date precedes its start and says why', () => {
    const result = run({
      desired: [desired({ effectiveFrom: '2026-03-01', effectiveTo: '2026-02-01' })],
    });

    expect(result.actions).toEqual([]);
    expect(codes(result.warnings)).toContain('invertedEffectiveRange');
  });

  /**
   * Two primaries in force at once is a billing problem, not a sync problem: the claim goes to the
   * wrong payer and is denied weeks later. It is surfaced rather than resolved, because picking one
   * would be a clinical-billing decision made by a transformer.
   */
  it('warns when two billable coverages share a rank over overlapping dates', () => {
    const result = run({
      desired: [
        desired(),
        desired({ payer: { ...desired().payer, pccPayerId: 'payer-mcaid', name: 'Medicaid' } }),
      ],
    });

    expect(codes(result.warnings)).toContain('overlappingRank');
  });

  it('does not warn when same-rank coverages are consecutive rather than overlapping', () => {
    const result = run({
      desired: [
        desired({ effectiveFrom: '2026-01-01', effectiveTo: '2026-02-28' }),
        desired({
          payer: { ...desired().payer, pccPayerId: 'payer-mcaid', name: 'Medicaid' },
          effectiveFrom: '2026-03-01',
        }),
      ],
    });

    expect(codes(result.warnings)).not.toContain('overlappingRank');
  });

  it('ignores rank collisions between informational coverages', () => {
    const result = run({
      desired: [
        desired({ rank: 'informational' }),
        desired({ rank: 'informational', payer: { ...desired().payer, pccPayerId: 'payer-x' } }),
      ],
    });

    expect(codes(result.warnings)).not.toContain('overlappingRank');
  });

  it('warns when a patient has coverage but none of it is primary today', () => {
    const result = run({ desired: [desired({ rank: 'secondary' })] });

    expect(codes(result.warnings)).toContain('noPrimaryInForce');
  });

  it('warns when the only primary starts in the future', () => {
    const result = run({ desired: [desired({ effectiveFrom: '2026-06-01' })] });

    expect(codes(result.warnings)).toContain('noPrimaryInForce');
  });

  it('stays silent about a missing primary when the patient has no coverage at all', () => {
    const result = run({});

    expect(codes(result.warnings)).not.toContain('noPrimaryInForce');
  });

  /**
   * Reconciliation runs on every coverage event, and most of them change nothing. Applying the
   * result of a previous run has to produce no further actions, otherwise the sweep and the webhook
   * path would fight each other and rewrite the same rows indefinitely.
   */
  it('is a fixed point: applying its own output produces no further changes', () => {
    const first = run({ desired: [desired()], stored: [] });
    expect(kinds(first.actions)).toEqual(['create']);

    const created = stored({
      id: (first.actions[0] as { coverageId: string }).coverageId,
      effectiveTo: null,
    });

    const second = run({ desired: [desired()], stored: [created] });
    expect(kinds(second.actions)).toEqual(['unchanged']);
  });
});
