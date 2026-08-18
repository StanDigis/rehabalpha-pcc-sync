import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isoDate, isoDateTime, openEnum, toOpenEnum } from './schema-primitives.js';

const SEX = ['FEMALE', 'MALE', 'OTHER'] as const;

describe('openEnum', () => {
  it('normalises a known upstream value', () => {
    expect(openEnum(SEX).parse('FEMALE')).toEqual({ value: 'FEMALE', raw: 'FEMALE' });
  });

  /**
   * PCC adds values to pick-lists without notice. Rejecting the whole patient because of an
   * unrecognised marital status would turn a cosmetic upstream change into a production outage, so
   * the value degrades and the original is kept verbatim for whoever has to explain it.
   */
  it('keeps an unrecognised value verbatim instead of failing', () => {
    expect(openEnum(SEX).parse('NONBINARY')).toEqual({ value: 'UNKNOWN', raw: 'NONBINARY' });
  });

  it('tolerates the casing and spacing upstream actually sends', () => {
    expect(openEnum(SEX).parse(' female ')).toEqual({ value: 'FEMALE', raw: ' female ' });
  });

  /**
   * The regression this exists for: the stored document holds the `{ value, raw }` pair, so a schema
   * that could only parse a bare string failed on every read back out of Firestore. Validating a
   * projection on the way out is worthless if the round trip cannot succeed by construction.
   */
  it('reads back the pair it stores', () => {
    const schema = z.object({ administrativeSex: openEnum(SEX) });
    const stored = schema.parse({ administrativeSex: 'FEMALE' });

    expect(schema.parse(stored)).toEqual(stored);
  });

  it('agrees with the value built outside of parsing', () => {
    expect(openEnum(SEX).parse('male')).toEqual(toOpenEnum(SEX, 'male'));
  });

  /**
   * A value dropped from the union between deploys must not make the document unreadable. It
   * degrades to UNKNOWN, which is the same outcome as an unrecognised upstream value and for the
   * same reason.
   */
  it('degrades a stored value that is no longer part of the union', () => {
    const stored = { value: 'OTHER', raw: 'OTHER' };

    expect(openEnum(['FEMALE', 'MALE']).parse(stored)).toEqual({
      value: 'UNKNOWN',
      raw: 'OTHER',
    });
  });

  it('rejects a shape that is neither a string nor the stored pair', () => {
    expect(() => openEnum(SEX).parse({ value: 'FEMALE' })).toThrow();
    expect(() => openEnum(SEX).parse(null)).toThrow();
  });
});

describe('isoDate', () => {
  it('accepts a calendar date', () => {
    expect(isoDate.parse('1948-09-11')).toBe('1948-09-11');
  });

  /**
   * A birth date is a calendar date, not an instant. Accepting a timestamp here is how a date of
   * birth shifts by a day for anyone west of UTC.
   */
  it('rejects a timestamp', () => {
    expect(() => isoDate.parse('1948-09-11T00:00:00Z')).toThrow();
  });

  it('rejects a date that does not exist', () => {
    expect(() => isoDate.parse('2026-02-30')).toThrow();
  });
});

describe('isoDateTime', () => {
  it('normalises to UTC with millisecond precision', () => {
    expect(isoDateTime.parse('2026-08-11T10:05:00-04:00')).toBe('2026-08-11T14:05:00.000Z');
  });

  it('rejects a bare calendar date', () => {
    expect(() => isoDateTime.parse('2026-08-11')).toThrow();
  });
});
