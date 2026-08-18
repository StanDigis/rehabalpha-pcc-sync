import { PermanentSyncError } from '@rehabalpha/core';

/**
 * PointClickCare returns dates in more than one shape depending on the endpoint: a bare
 * calendar date for a birth date, a full timestamp for an ADT effective time, and occasionally
 * a timestamp where a date is meant. Normalising at the boundary keeps every comparison
 * downstream — watermarks, coverage effective ranges, timeline queries — working on one
 * representation.
 */

/** To a calendar date. A timestamp is truncated to its UTC date part. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;

  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;

  return new Date(parsed).toISOString().slice(0, 10);
}

/** To a UTC instant. */
export function normalizeInstant(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;

  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return null;

  return new Date(parsed).toISOString();
}

/**
 * A required upstream field that is missing.
 *
 * Raised as permanent rather than substituted with a placeholder. A patient record with no
 * surname is not something to quietly accept into a chart: it lands in the dead-letter queue
 * where an operator sees it, and the facility gets asked to fix the record in PCC. Inventing a
 * value would make the chart look complete while being wrong, which is worse.
 */
export function requireField<T>(value: T | null | undefined, field: string, entity: string): T {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new PermanentSyncError(
      'pcc_required_field_missing',
      `PCC ${entity} is missing the required field ${field}`,
    );
  }
  return value;
}
