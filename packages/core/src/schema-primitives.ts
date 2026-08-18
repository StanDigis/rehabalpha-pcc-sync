import { z } from 'zod';

/**
 * Date and timestamp primitives are hand-rolled rather than taken from Zod's
 * built-ins so that the shape of the validation error, and the accepted format,
 * stay stable across Zod majors. Everything crossing a boundary is a string:
 * Firestore `Timestamp` and JS `Date` are both mutable-timezone footguns when the
 * same value has to round-trip through PCC, Firestore, JSON and the browser.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar date with no time or zone, e.g. a date of birth or an admit date.
 *
 * The check is a round trip rather than a parse, because `Date.parse` silently rolls an impossible
 * date over — `2026-02-30` becomes 2 March and reports itself as valid. A birth date is a field
 * people are matched on, so storing a date that does not exist is worse than rejecting the record
 * and telling somebody the upstream value is wrong.
 */
export const isoDate = z.string().refine(
  (value) => {
    if (!ISO_DATE.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  },
  { message: 'Expected a calendar date formatted as YYYY-MM-DD' },
);

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
 *
 * Two input shapes are accepted, and both matter. A bare string is what a lenient upstream
 * payload carries. The `{ value, raw }` pair is what the *stored document* carries, and the
 * schema has to be able to read back what it wrote — validating a projection on the way out of
 * Firestore is worthless if the round trip fails by construction.
 *
 * `value` is always recomputed from `raw` rather than trusted. A stored value that has since
 * been dropped from the union then degrades to `UNKNOWN` on read instead of failing validation
 * and taking the document with it.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .union([z.string(), z.object({ value: z.string(), raw: z.string() })])
    .transform((input) => toOpenEnum(values, typeof input === 'string' ? input : input.raw));
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
