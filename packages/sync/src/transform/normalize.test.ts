import { PermanentSyncError } from '@rehabalpha/core';
import { describe, expect, it } from 'vitest';
import { normalizeDate, normalizeInstant, requireField } from './normalize.js';

describe('normalizeDate', () => {
  it('passes a calendar date through untouched', () => {
    expect(normalizeDate('1941-06-12')).toBe('1941-06-12');
  });

  /**
   * PCC returns a full timestamp where a calendar date is meant on some endpoints. Truncating in UTC
   * keeps one representation downstream, which is what makes coverage range comparisons string
   * comparisons rather than date arithmetic.
   */
  it('truncates a timestamp to its UTC date part', () => {
    expect(normalizeDate('2026-03-15T22:45:00Z')).toBe('2026-03-15');
  });

  it('resolves an offset before truncating, so a late-evening local time is not misdated', () => {
    expect(normalizeDate('2026-03-15T23:30:00-05:00')).toBe('2026-03-16');
  });

  it.each([null, undefined, '', '   '])('returns null for %p', (value) => {
    expect(normalizeDate(value)).toBeNull();
  });

  it('returns null rather than a wrong date for an unparseable value', () => {
    expect(normalizeDate('not-a-date')).toBeNull();
  });

  it('trims incidental whitespace', () => {
    expect(normalizeDate('  1941-06-12  ')).toBe('1941-06-12');
  });
});

describe('normalizeInstant', () => {
  it('normalises an offset timestamp to UTC with millisecond precision', () => {
    expect(normalizeInstant('2026-03-15T10:00:00-05:00')).toBe('2026-03-15T15:00:00.000Z');
  });

  it('is idempotent on a value it has already produced', () => {
    const once = normalizeInstant('2026-03-15T10:00:00-05:00');

    expect(normalizeInstant(once)).toBe(once);
  });

  it.each([null, undefined, '', 'garbage'])('returns null for %p', (value) => {
    expect(normalizeInstant(value)).toBeNull();
  });
});

describe('requireField', () => {
  it('returns a present value', () => {
    expect(requireField('Alvarez', 'lastName', 'patient')).toBe('Alvarez');
  });

  /**
   * Raised as permanent, not substituted. A chart with an invented surname looks complete and is
   * wrong; a dead-lettered one gets an operator to ask the facility to fix the source record.
   */
  it.each([null, undefined, '', '   '])('refuses %p with a permanent failure', (value) => {
    expect(() => requireField(value, 'lastName', 'patient')).toThrow(PermanentSyncError);
  });

  it('names the field and entity so the dead-letter entry is actionable', () => {
    expect(() => requireField(null, 'lastName', 'patient')).toThrow(
      /patient is missing the required field lastName/,
    );
  });

  it('does not reject a falsy value that is legitimately present', () => {
    expect(requireField(0, 'approvedVisits', 'coverage')).toBe(0);
    expect(requireField(false, 'authorizationRequired', 'coverage')).toBe(false);
  });
});
