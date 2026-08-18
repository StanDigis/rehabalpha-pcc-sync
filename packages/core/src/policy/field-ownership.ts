/**
 * Which system owns which field.
 *
 * "PointClickCare is the source of truth" is true of demographics, stay dates and coverage,
 * and false of everything RehabAlpha exists to produce. A sync that merges the whole upstream
 * projection over the stored document will eventually delete a therapist's work, and it will
 * do it quietly, during a routine reconciliation sweep, to a chart nobody was looking at.
 *
 * Most of this is handled structurally: therapy documentation lives in its own collections
 * that the sync never touches. What remains are the few fields on a synchronised document
 * that RehabAlpha derives or a human curates — the identity link, the derived pointers — plus
 * the deliberate escape hatch of a local override.
 *
 * The default is that PCC owns a field. Anything RehabAlpha owns has to be named, so adding a
 * field to a projection without thinking about ownership fails safe: upstream wins, which is
 * the correct behaviour for a read model.
 */

export type FieldOwner = 'pcc' | 'rehabAlpha';

/** Dotted paths to the owner. Absent paths default to `pcc`. */
export type OwnershipMap = Readonly<Record<string, FieldOwner>>;

/**
 * A field a human has pinned locally, in spite of what PCC says.
 *
 * Needed because facilities do get data wrong, and a therapist who cannot proceed until
 * Ferncrest's admissions clerk fixes a transposed birth date is blocked on somebody else's
 * backlog. The override is time-boxed and audited rather than permanent, so it cannot quietly
 * become a second, divergent source of truth: when it expires, upstream wins again and the
 * discrepancy resurfaces.
 */
export type LocalOverride = {
  reason: string;
  byUid: string;
  at: string;
  /** Null means no expiry, which requires an org admin and is surfaced in the console. */
  expiresAt: string | null;
};

export type LocalOverrides = Readonly<Record<string, LocalOverride>>;

export type FieldConflict = {
  path: string;
  kind:
    /** Upstream disagrees, but an active local override holds. Reported, not applied. */
    | 'overrideHeld'
    /** The override lapsed and upstream still disagrees, so upstream was applied. */
    | 'overrideExpired';
};

export type ProjectionWritePlan<T> = {
  next: T;
  /** PCC-owned paths whose value changed. Drives the audit detail. */
  changedPaths: string[];
  /** RehabAlpha-owned paths that were carried over from the stored document. */
  preservedPaths: string[];
  conflicts: FieldConflict[];
};

function getPath(target: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, target);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (last === undefined) return;

  let cursor: Record<string, unknown> = target;
  for (const segment of segments) {
    const next = cursor[segment];
    if (next === null || typeof next !== 'object') {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
}

function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export type PlanOptions = {
  ownership: OwnershipMap;
  overrides?: LocalOverrides;
  /** Compared against `expiresAt`; injected so the decision is testable. */
  now: string;
};

/**
 * Builds the document to write from the upstream projection and what is already stored.
 *
 * Returns the plan rather than performing the write so that the caller can audit precisely
 * which PCC-owned fields moved, and so that a conflict can be surfaced to an operator instead
 * of being resolved by whichever side happened to be written last.
 */
export function planProjectionWrite<T extends Record<string, unknown>>(
  incoming: T,
  stored: T | null,
  { ownership, overrides = {}, now }: PlanOptions,
): ProjectionWritePlan<T> {
  const next = structuredClone(incoming) as Record<string, unknown>;
  const changedPaths: string[] = [];
  const preservedPaths: string[] = [];
  const conflicts: FieldConflict[] = [];

  if (stored === null) {
    return { next: next as T, changedPaths: [], preservedPaths: [], conflicts: [] };
  }

  for (const [path, owner] of Object.entries(ownership)) {
    if (owner !== 'rehabAlpha') continue;

    const storedValue = getPath(stored, path);
    if (!equalValues(storedValue, getPath(next, path))) {
      preservedPaths.push(path);
    }
    setPath(next, path, storedValue);
  }

  for (const [path, override] of Object.entries(overrides)) {
    if (ownership[path] === 'rehabAlpha') continue;

    const upstreamValue = getPath(next, path);
    const storedValue = getPath(stored, path);
    if (equalValues(upstreamValue, storedValue)) continue;

    const expired = override.expiresAt !== null && override.expiresAt <= now;
    if (expired) {
      conflicts.push({ path, kind: 'overrideExpired' });
      continue;
    }

    setPath(next, path, storedValue);
    conflicts.push({ path, kind: 'overrideHeld' });
  }

  for (const path of collectLeafPaths(incoming)) {
    if (ownership[path] === 'rehabAlpha') continue;
    if (!equalValues(getPath(stored, path), getPath(next, path))) {
      changedPaths.push(path);
    }
  }

  return { next: next as T, changedPaths, preservedPaths, conflicts };
}

/**
 * Leaf paths of the projection, used to report what changed.
 *
 * Arrays are treated as leaves rather than being walked element by element. A coverage list
 * that reordered would otherwise report every index as changed, which is noise; and for the
 * audit trail "the coverage set changed" is the useful statement.
 */
function collectLeafPaths(value: unknown, prefix = '', accumulator: string[] = []): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') accumulator.push(prefix);
    return accumulator;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectLeafPaths(child, prefix === '' ? key : `${prefix}.${key}`, accumulator);
  }
  return accumulator;
}

/**
 * The identity link is decided by our matching policy and, for anything short of an
 * authoritative signal, by a human. A fresh projection from PCC has no opinion about it and
 * must not reset it — that would send an already reviewed patient back to the review queue on
 * every demographic edit.
 */
export const PATIENT_OWNERSHIP: OwnershipMap = {
  personId: 'rehabAlpha',
  personLink: 'rehabAlpha',
  currentAdmissionId: 'rehabAlpha',
  sync: 'rehabAlpha',
};

/**
 * Admissions have no ownership map on purpose.
 *
 * Nothing on a stay is human-curated: the dates, the status and the location all come from PCC's
 * ADT stream, and `personId` is derived from the linked patient on every write so that linking a
 * patient later propagates to their stays. A map here would be dead configuration implying a
 * decision that does not exist.
 */
