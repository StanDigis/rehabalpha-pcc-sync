import { createHash } from 'node:crypto';

/**
 * Deterministic serialisation: object keys sorted, arrays left in order, `undefined` dropped.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical objects built by
 * different code paths hash differently. That would make the "has anything actually changed"
 * check unreliable, and a reconciliation sweep would rewrite every document it examined.
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/**
 * Hash of the synchronised fields only.
 *
 * Provenance is excluded on purpose: `syncedAt` and `syncVersion` change on every write, so
 * including them would make every comparison report a difference and defeat the point.
 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}
