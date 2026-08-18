import type { PccCoverage } from '@rehabalpha/pcc-client';
import { describe, expect, it } from 'vitest';
import { toDesiredCoverages } from './coverage.js';

function coverage(overrides: Partial<PccCoverage> = {}): PccCoverage {
  return {
    payerId: 'payer-medicare-a',
    payerName: 'Medicare Part A',
    payerType: 'Medicare',
    payerRank: 'Primary',
    planName: null,
    effectiveDate: '2026-01-01',
    expirationDate: null,
    informationalOnly: null,
    authorizationRequired: null,
    authorizationNumber: null,
    authorizationEffectiveDate: null,
    authorizationExpirationDate: null,
    approvedVisits: null,
    lastUpdateDatetime: '2026-01-02T09:00:00Z',
    ...overrides,
  };
}

describe('toDesiredCoverages', () => {
  it('maps a payer onto a dated coverage row', () => {
    const { desired } = toDesiredCoverages([coverage()]);

    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      payer: {
        pccPayerId: 'payer-medicare-a',
        name: 'Medicare Part A',
        payerType: { value: 'MEDICARE', raw: 'Medicare' },
      },
      rank: 'primary',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    });
  });

  it.each([
    ['Primary', 'primary'],
    ['P', 'primary'],
    ['1', 'primary'],
    ['secondary', 'secondary'],
    ['S', 'secondary'],
    ['2', 'secondary'],
    ['TERTIARY', 'tertiary'],
    ['3', 'tertiary'],
  ])('reads %s as rank %s', (raw, expected) => {
    expect(toDesiredCoverages([coverage({ payerRank: raw })]).desired[0]!.rank).toBe(expected);
  });

  /**
   * An unreadable rank becomes `unknown`, which the timeline policy excludes from its billing-order
   * checks. Defaulting it to primary would be the convenient guess and would send claims to a payer
   * chosen by a string-matching accident.
   */
  it.each([null, '', 'weird'])('refuses to guess a rank from %p', (raw) => {
    expect(toDesiredCoverages([coverage({ payerRank: raw })]).desired[0]!.rank).toBe('unknown');
  });

  /**
   * Informational payers sit on the tree to record who else is involved — a responsible family
   * member, say. Treating one as a real secondary sends a claim to somebody who never agreed to pay.
   */
  it('marks an informational payer as such whatever rank PCC gives it', () => {
    const { desired } = toDesiredCoverages([
      coverage({ informationalOnly: true, payerRank: 'Secondary' }),
    ]);

    expect(desired[0]!.rank).toBe('informational');
  });

  /**
   * The effective date decides which payer is liable for a given visit. The tempting fallback is the
   * admission date, and it produces claims that look correct and get denied weeks later.
   */
  it('skips a coverage with no effective date and reports it', () => {
    const { desired, skipped } = toDesiredCoverages([coverage({ effectiveDate: null })]);

    expect(desired).toEqual([]);
    expect(skipped).toEqual([{ pccPayerId: 'payer-medicare-a', reason: 'missing_effective_date' }]);
  });

  it('keeps the usable rows when one row in the tree is unusable', () => {
    const { desired, skipped } = toDesiredCoverages([
      coverage(),
      coverage({ payerId: 'payer-broken', effectiveDate: null }),
    ]);

    expect(desired).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('truncates a timestamp where PCC sent one instead of a date', () => {
    const { desired } = toDesiredCoverages([
      coverage({ effectiveDate: '2026-01-01T05:00:00Z', expirationDate: '2026-02-28T00:00:00Z' }),
    ]);

    expect(desired[0]).toMatchObject({ effectiveFrom: '2026-01-01', effectiveTo: '2026-02-28' });
  });

  it('leaves authorization null when PCC says nothing about it', () => {
    expect(toDesiredCoverages([coverage()]).desired[0]!.authorization).toBeNull();
  });

  it('builds authorization details from any single signal', () => {
    const { desired } = toDesiredCoverages([
      coverage({
        authorizationRequired: true,
        authorizationNumber: 'AUTH-9',
        authorizationEffectiveDate: '2026-01-01',
        authorizationExpirationDate: '2026-06-30',
        approvedVisits: 20,
      }),
    ]);

    expect(desired[0]!.authorization).toEqual({
      required: true,
      number: 'AUTH-9',
      validFrom: '2026-01-01',
      validTo: '2026-06-30',
      approvedVisits: 20,
    });
  });

  it('treats a visit allowance alone as enough to record an authorization', () => {
    const { desired } = toDesiredCoverages([coverage({ approvedVisits: 0 })]);

    expect(desired[0]!.authorization).toMatchObject({ required: false, approvedVisits: 0 });
  });

  it('takes the newest upstream timestamp across the tree as the watermark', () => {
    const { watermark } = toDesiredCoverages([
      coverage({ lastUpdateDatetime: '2026-01-02T09:00:00Z' }),
      coverage({ payerId: 'payer-mcaid', lastUpdateDatetime: '2026-03-01T08:00:00-05:00' }),
    ]);

    expect(watermark).toBe('2026-03-01T13:00:00.000Z');
  });

  it('reports a null watermark when no row carries a timestamp', () => {
    expect(toDesiredCoverages([coverage({ lastUpdateDatetime: null })]).watermark).toBeNull();
  });

  it('handles an empty payer tree', () => {
    expect(toDesiredCoverages([])).toEqual({ desired: [], skipped: [], watermark: null });
  });

  it('keeps an unrecognised payer type verbatim rather than failing', () => {
    const { desired } = toDesiredCoverages([coverage({ payerType: 'Managed Care Plan' })]);

    expect(desired[0]!.payer.payerType).toEqual({ value: 'UNKNOWN', raw: 'Managed Care Plan' });
  });
});
