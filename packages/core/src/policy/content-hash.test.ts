import { describe, expect, it } from 'vitest';
import { contentHash } from './content-hash.js';

describe('contentHash', () => {
  /**
   * The property everything else depends on. `JSON.stringify` preserves insertion order, so two
   * structurally identical projections built by different code paths would hash differently, every
   * comparison would report a difference, and the reconciliation sweep would rewrite every document
   * it examined.
   */
  it('does not depend on key order', () => {
    expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('does depend on array order, because a coverage list is ordered', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('treats an absent key and an explicitly undefined one as the same', () => {
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
  });

  it('distinguishes null from undefined, because null is an asserted value', () => {
    expect(contentHash({ a: null })).not.toBe(contentHash({ a: undefined }));
  });

  it('distinguishes a number from its string form', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: '1' }));
  });

  it('notices a nested change', () => {
    expect(contentHash({ payer: { rank: 'primary' } })).not.toBe(
      contentHash({ payer: { rank: 'secondary' } }),
    );
  });

  it('is stable across calls', () => {
    const value = { patientId: 'pat_1', demographics: { lastName: 'Alvarez' } };

    expect(contentHash(value)).toBe(contentHash(value));
  });

  it('returns a short hex digest, so it is cheap to store on every document', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes primitives and empty structures without special-casing at the call site', () => {
    expect(contentHash(null)).toMatch(/^[0-9a-f]{32}$/);
    expect(contentHash('betty')).not.toBe(contentHash('harold'));
    expect(contentHash({})).not.toBe(contentHash([]));
  });
});
