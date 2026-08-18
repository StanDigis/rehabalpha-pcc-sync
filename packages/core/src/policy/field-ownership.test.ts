import { describe, expect, it } from 'vitest';
import {
  planProjectionWrite,
  PATIENT_OWNERSHIP,
  type LocalOverrides,
  type OwnershipMap,
} from './field-ownership.js';

const NOW = '2026-03-15T12:00:00.000Z';

type Doc = {
  demographics: { firstName: string; lastName: string; birthDate: string | null };
  personId: string | null;
  currentAdmissionId: string | null;
  sync: { contentHash: string };
};

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    demographics: { firstName: 'Betty', lastName: 'Alvarez', birthDate: '1941-06-12' },
    personId: null,
    currentAdmissionId: null,
    sync: { contentHash: 'hash-incoming' },
    ...overrides,
  };
}

function plan(incoming: Doc, stored: Doc | null, overrides: LocalOverrides = {}) {
  return planProjectionWrite(incoming, stored, {
    ownership: PATIENT_OWNERSHIP as OwnershipMap,
    overrides,
    now: NOW,
  });
}

describe('planProjectionWrite', () => {
  it('writes the projection as-is when nothing is stored yet', () => {
    const incoming = doc();
    const result = plan(incoming, null);

    expect(result.next).toEqual(incoming);
    expect(result.changedPaths).toEqual([]);
    expect(result.preservedPaths).toEqual([]);
  });

  /**
   * The failure this exists to prevent: a routine reconciliation sweep resetting a link a human
   * confirmed, sending an already reviewed patient back to the queue on every demographic edit.
   */
  it('preserves a RehabAlpha-owned field that the upstream projection knows nothing about', () => {
    const result = plan(doc(), doc({ personId: 'per_betty' }));

    expect(result.next.personId).toBe('per_betty');
    expect(result.preservedPaths).toContain('personId');
  });

  it('does not report a preserved field when both sides already agree', () => {
    const result = plan(doc({ personId: 'per_betty' }), doc({ personId: 'per_betty' }));

    expect(result.preservedPaths).toEqual([]);
  });

  it('applies PCC-owned changes and names the paths that moved', () => {
    const result = plan(
      doc({ demographics: { firstName: 'Bettye', lastName: 'Alvarez', birthDate: '1941-06-12' } }),
      doc(),
    );

    expect(result.next.demographics.firstName).toBe('Bettye');
    expect(result.changedPaths).toEqual(['demographics.firstName']);
  });

  it('reports no changed paths when the upstream record is identical', () => {
    const result = plan(doc(), doc());

    expect(result.changedPaths).toEqual([]);
  });

  it('treats an unlisted field as PCC-owned, so a new field fails safe towards upstream', () => {
    const incoming = { ...doc(), notes: 'from-pcc' } as Doc & { notes: string };
    const stored = { ...doc(), notes: 'stale' } as Doc & { notes: string };

    const result = plan(incoming, stored);

    expect((result.next as Doc & { notes: string }).notes).toBe('from-pcc');
    expect(result.changedPaths).toContain('notes');
  });

  describe('local overrides', () => {
    const overrides: LocalOverrides = {
      'demographics.birthDate': {
        reason: 'Ferncrest transposed the digits; ticket RA-1183',
        byUid: 'uid_supervisor',
        at: '2026-03-01T00:00:00.000Z',
        expiresAt: '2026-04-01T00:00:00.000Z',
      },
    };

    it('holds a corrected value against upstream while the override is live', () => {
      const result = plan(
        doc({ demographics: { firstName: 'Betty', lastName: 'Alvarez', birthDate: '1941-06-21' } }),
        doc(),
        overrides,
      );

      expect(result.next.demographics.birthDate).toBe('1941-06-12');
      expect(result.conflicts).toEqual([{ path: 'demographics.birthDate', kind: 'overrideHeld' }]);
    });

    /**
     * Time-boxed on purpose. A permanent override is a second source of truth that nobody revisits;
     * an expiring one makes the discrepancy resurface so somebody has to fix it upstream.
     */
    it('lets upstream win once the override has lapsed, and says that it lapsed', () => {
      const lapsed: LocalOverrides = {
        'demographics.birthDate': {
          ...overrides['demographics.birthDate']!,
          expiresAt: '2026-03-01T00:00:00.000Z',
        },
      };

      const result = plan(
        doc({ demographics: { firstName: 'Betty', lastName: 'Alvarez', birthDate: '1941-06-21' } }),
        doc(),
        lapsed,
      );

      expect(result.next.demographics.birthDate).toBe('1941-06-21');
      expect(result.conflicts).toEqual([
        { path: 'demographics.birthDate', kind: 'overrideExpired' },
      ]);
    });

    it('raises no conflict once upstream has been corrected to match the override', () => {
      const result = plan(doc(), doc(), overrides);

      expect(result.conflicts).toEqual([]);
      expect(result.next.demographics.birthDate).toBe('1941-06-12');
    });

    it('ignores an override on a field RehabAlpha already owns', () => {
      const result = plan(doc(), doc({ personId: 'per_betty' }), {
        personId: {
          reason: 'noop',
          byUid: 'uid_supervisor',
          at: NOW,
          expiresAt: null,
        },
      });

      expect(result.conflicts).toEqual([]);
      expect(result.next.personId).toBe('per_betty');
    });
  });

  it('does not mutate the projection it was given', () => {
    const incoming = doc();
    plan(incoming, doc({ personId: 'per_betty' }));

    expect(incoming.personId).toBeNull();
  });
});
