import { z } from 'zod';

/**
 * Date and timestamp primitives are hand-rolled rather than taken from Zod's
 * built-ins so that the shape of the validation error, and the accepted format,
 * stay stable across Zod majors. Everything crossing a boundary is a string:
 * Firestore `Timestamp` and JS `Date` are both mutable-timezone footguns when the
 * same value has to round-trip through PCC, Firestore, JSON and the browser.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date with no time or zone, e.g. a date of birth or an admit date. */
export const isoDate = z
  .string()
  .refine((value) => ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'Expected a calendar date formatted as YYYY-MM-DD',
  });

/** Instant, always normalised to UTC with millisecond precision. */
export const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)) && /[TZ+]/.test(value), {
    message: 'Expected an ISO 8601 timestamp',
  })
  .transform((value) => new Date(value).toISOString());

export type IsoDate = z.infer<typeof isoDate>;
export type IsoDateTime = z.infer<typeof isoDateTime>;

/**
 * Unknown enum members must not fail a sync. PCC adds values to pick-lists without
 * notice, and rejecting the whole patient because of an unrecognised marital status
 * would turn a cosmetic upstream change into a production outage. Unknown values are
 * preserved verbatim under `raw` so operators can see what arrived.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  const known = new Set<string>(values);
  return z.string().transform((value) => ({
    value: (known.has(value) ? value : 'UNKNOWN') as T[number] | 'UNKNOWN',
    raw: value,
  }));
}

export type OpenEnum<T extends string> = { value: T | 'UNKNOWN'; raw: string };

/** Builds an open-enum value outside of parsing, for use in transformers. */
export function toOpenEnum<const T extends readonly string[]>(
  values: T,
  raw: string | null | undefined,
): OpenEnum<T[number]> {
  const normalised = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  const known = values.includes(normalised) ? (normalised as T[number]) : 'UNKNOWN';
  return { value: known, raw: raw ?? '' };
}
