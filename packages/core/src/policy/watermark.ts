/**
 * The rule that makes at-least-once, unordered webhook delivery safe.
 *
 * PCC does not promise to deliver a notification once, nor in the order the changes happened.
 * A retry of yesterday's "patient updated" can land after today's. The naive handler — fetch
 * current state, overwrite the document — is correct only when deliveries are ordered, which
 * they are not, and the resulting corruption is silent: a chart quietly reverts to an older
 * version and nothing logs an error.
 *
 * Rather than buying global ordering, which is expensive and still leaves the duplicate case,
 * every document remembers the upstream modification instant it was built from. A write is
 * applied only when it is derived from upstream state at least as new as what we already hold.
 * Duplicates and late deliveries become no-ops, and the operation is idempotent and
 * commutative: applying any permutation of a set of events converges on the same state. That
 * invariant is asserted by a property-based test rather than by example.
 */

export type StoredSyncState = {
  pccLastModified: string | null;
  contentHash: string;
} | null;

export type IncomingSyncState = {
  pccLastModified: string | null;
  contentHash: string;
};

export type WriteDecision =
  /** No document yet. */
  | { action: 'create' }
  /** Apply the projection. */
  | {
      action: 'update';
      reason: 'upstreamNewer' | 'sameWatermarkContentChanged' | 'noUpstreamTimestamp' | 'forced';
    }
  /**
   * Upstream moved but produced identical content. The watermark is advanced without
   * rewriting the payload, so the same event is not re-evaluated forever, while the document
   * body and its audit trail stay untouched.
   */
  | { action: 'advanceWatermark' }
  | { action: 'skip'; reason: 'staleWatermark' | 'contentUnchanged' };

export type DecideWriteOptions = {
  /**
   * Operator-initiated resync. Bypasses the watermark deliberately, and the caller is
   * expected to have written an audit event explaining why.
   */
  force?: boolean;
};

/**
 * Timestamps are compared as instants rather than lexicographically. Normalised ISO strings
 * would compare correctly as strings, but this function sits on the path where a
 * non-normalised value from a new PCC endpoint would cause silent data loss, and the cost of
 * parsing is irrelevant next to the Firestore write it guards.
 */
function compareInstants(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    throw new RangeError('Cannot compare unparseable timestamps in a watermark decision');
  }
  return left - right;
}

export function decideWrite(
  incoming: IncomingSyncState,
  stored: StoredSyncState,
  options: DecideWriteOptions = {},
): WriteDecision {
  if (stored === null) {
    return { action: 'create' };
  }

  if (options.force === true) {
    return { action: 'update', reason: 'forced' };
  }

  const contentChanged = incoming.contentHash !== stored.contentHash;

  // PCC did not tell us when this changed, so the watermark cannot arbitrate and content is
  // all we have. Treating the upstream as authoritative is the right default for a read-only
  // projection of a source of truth.
  if (incoming.pccLastModified === null) {
    return contentChanged
      ? { action: 'update', reason: 'noUpstreamTimestamp' }
      : { action: 'skip', reason: 'contentUnchanged' };
  }

  if (stored.pccLastModified === null) {
    return contentChanged
      ? { action: 'update', reason: 'upstreamNewer' }
      : { action: 'advanceWatermark' };
  }

  const delta = compareInstants(incoming.pccLastModified, stored.pccLastModified);

  if (delta < 0) {
    return { action: 'skip', reason: 'staleWatermark' };
  }

  if (delta > 0) {
    return contentChanged
      ? { action: 'update', reason: 'upstreamNewer' }
      : { action: 'advanceWatermark' };
  }

  // Same instant, different content. Either PCC changed a field without moving its
  // modification timestamp, or our own transform changed between deploys. Converging on
  // upstream is the safe resolution; the alternative is a document that never self-heals.
  return contentChanged
    ? { action: 'update', reason: 'sameWatermarkContentChanged' }
    : { action: 'skip', reason: 'contentUnchanged' };
}

/** True when the decision results in the stored payload changing. */
export function decisionWritesContent(decision: WriteDecision): boolean {
  return decision.action === 'create' || decision.action === 'update';
}
