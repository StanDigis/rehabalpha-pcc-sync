import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentHash } from './content-hash.js';
import { decideWrite, type StoredSyncState } from './watermark.js';

const hashA = contentHash({ firstName: 'A' });
const hashB = contentHash({ firstName: 'B' });

describe('decideWrite', () => {
  it('creates when nothing is stored', () => {
    expect(
      decideWrite({ pccLastModified: '2026-08-01T00:00:00.000Z', contentHash: hashA }, null),
    ).toEqual({
      action: 'create',
    });
  });

  it('skips a delivery derived from older upstream state', () => {
    const decision = decideWrite(
      { pccLastModified: '2026-08-01T00:00:00.000Z', contentHash: hashB },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
    );

    expect(decision).toEqual({ action: 'skip', reason: 'staleWatermark' });
  });

  it('applies a delivery derived from newer upstream state', () => {
    const decision = decideWrite(
      { pccLastModified: '2026-08-03T00:00:00.000Z', contentHash: hashB },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
    );

    expect(decision).toEqual({ action: 'update', reason: 'upstreamNewer' });
  });

  it('advances the watermark without rewriting identical content', () => {
    const decision = decideWrite(
      { pccLastModified: '2026-08-03T00:00:00.000Z', contentHash: hashA },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
    );

    expect(decision).toEqual({ action: 'advanceWatermark' });
  });

  it('treats a redelivery of the same state as a no-op', () => {
    const decision = decideWrite(
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
    );

    expect(decision).toEqual({ action: 'skip', reason: 'contentUnchanged' });
  });

  it('converges on upstream when the timestamp did not move but the content did', () => {
    const decision = decideWrite(
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashB },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
    );

    expect(decision).toEqual({ action: 'update', reason: 'sameWatermarkContentChanged' });
  });

  it('falls back to content comparison when upstream provides no timestamp', () => {
    expect(
      decideWrite(
        { pccLastModified: null, contentHash: hashB },
        { pccLastModified: null, contentHash: hashA },
      ),
    ).toEqual({ action: 'update', reason: 'noUpstreamTimestamp' });
    expect(
      decideWrite(
        { pccLastModified: null, contentHash: hashA },
        { pccLastModified: null, contentHash: hashA },
      ),
    ).toEqual({ action: 'skip', reason: 'contentUnchanged' });
  });

  it('compares instants rather than string forms', () => {
    // The same instant expressed in a different offset must not read as newer.
    const decision = decideWrite(
      { pccLastModified: '2026-08-02T02:00:00.000+02:00', contentHash: hashB },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashA },
    );

    expect(decision).toEqual({ action: 'update', reason: 'sameWatermarkContentChanged' });
  });

  it('honours a forced resync even when the watermark is older', () => {
    const decision = decideWrite(
      { pccLastModified: '2026-07-01T00:00:00.000Z', contentHash: hashA },
      { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashB },
      { force: true },
    );

    expect(decision).toEqual({ action: 'update', reason: 'forced' });
  });

  it('rejects unparseable timestamps instead of guessing an order', () => {
    expect(() =>
      decideWrite(
        { pccLastModified: 'not-a-date', contentHash: hashA },
        { pccLastModified: '2026-08-02T00:00:00.000Z', contentHash: hashB },
      ),
    ).toThrow(RangeError);
  });
});

/**
 * The property that makes the ingest path safe to operate.
 *
 * PCC delivers at least once and in no particular order, so the pipeline must be both
 * idempotent and commutative: replaying a set of versions in any order, with arbitrary
 * duplicates, has to converge on the newest version. Enumerating that by example would miss
 * the interleavings that actually break, which is why it is stated as an invariant and left to
 * fast-check to attack.
 */
describe('watermark convergence', () => {
  type Version = { pccLastModified: string; payload: string };

  /**
   * Stands in for the transaction body in `writePatientProjection`: apply the decision the policy
   * returned and nothing else. Declared as a function taking the prior state so that the state is a
   * parameter rather than a narrowed local, which is also how the production code sees it.
   */
  const applyDecision = (
    stored: StoredSyncState,
    incoming: { pccLastModified: string; contentHash: string },
  ): StoredSyncState => {
    const decision = decideWrite(incoming, stored);

    switch (decision.action) {
      case 'create':
      case 'update':
        return incoming;
      case 'advanceWatermark':
        // Content is unchanged, so only the watermark moves. Rewriting the body here would be the
        // bug this branch exists to avoid.
        return {
          pccLastModified: incoming.pccLastModified,
          contentHash: stored === null ? incoming.contentHash : stored.contentHash,
        };
      case 'skip':
        return stored;
    }
  };

  const applyAll = (versions: readonly Version[]): StoredSyncState => {
    let stored: StoredSyncState = null;

    for (const version of versions) {
      stored = applyDecision(stored, {
        pccLastModified: version.pccLastModified,
        contentHash: contentHash({ payload: version.payload }),
      });
    }

    return stored;
  };

  const versionArbitrary = fc.integer({ min: 0, max: 40 }).map((offsetDays) => ({
    pccLastModified: new Date(Date.UTC(2026, 0, 1 + offsetDays)).toISOString(),
    payload: `v${offsetDays}`,
  }));

  it('converges on the newest version regardless of arrival order or duplication', () => {
    fc.assert(
      fc.property(
        fc.array(versionArbitrary, { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (versions, shuffleSeed) => {
          const newest = [...versions].sort((a, b) =>
            a.pccLastModified < b.pccLastModified
              ? -1
              : a.pccLastModified > b.pccLastModified
                ? 1
                : 0,
          )[versions.length - 1]!;

          // Duplicate and reorder deliveries the way a retrying webhook producer would.
          const delivered = shuffleSeed.reduce<Version[]>(
            (accumulator, seed) => {
              const pick = versions[seed % versions.length]!;
              return [...accumulator, pick];
            },
            [...versions].reverse(),
          );

          const stored = applyAll(delivered);

          expect(stored?.pccLastModified).toBe(newest.pccLastModified);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is idempotent: replaying the whole stream changes nothing', () => {
    fc.assert(
      fc.property(fc.array(versionArbitrary, { minLength: 1, maxLength: 10 }), (versions) => {
        const once = applyAll(versions);
        const twice = applyAll([...versions, ...versions]);

        expect(twice).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});
