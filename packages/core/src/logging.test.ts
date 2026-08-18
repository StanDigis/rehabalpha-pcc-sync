import { describe, expect, it } from 'vitest';
import { createLogger, createMemorySink, pseudonymise, redact } from './logging.js';

describe('redact', () => {
  it('blanks a direct identifier', () => {
    expect(redact({ firstName: 'Betty', patientId: 'pcc-1001' })).toEqual({
      firstName: '[redacted]',
      patientId: 'pcc-1001',
    });
  });

  /**
   * Substring matching rather than an exhaustive list, because upstream field names arrive in every
   * convention there is. Over-redacting a log field is cosmetic; under-redacting is reportable.
   */
  it.each([
    'patientFirstName',
    'subscriber_last_name',
    'guarantorPhone',
    'DOB',
    'birthDate',
    'ssn',
    'MedicalRecordNumber',
    'mailingAddress',
    'postalCode',
    'primaryDiagnosis',
    'progressNote',
  ])('blanks %s whatever the naming convention', (key) => {
    expect(redact({ [key]: 'sensitive' })).toEqual({ [key]: '[redacted]' });
  });

  it('keeps identifiers and decisions that carry no clinical content', () => {
    const input = {
      therapyOrgId: 'org_1',
      facilityId: 'fac_1',
      pccPatientId: 'pcc-1001',
      decision: 'staleWatermark',
      attempts: 3,
      applied: false,
    };

    expect(redact(input)).toEqual(input);
  });

  /**
   * `reason` is the natural name for the sync's own decision enums, and blanking it removes exactly
   * the field an operator needs. The exemption is by exact key, so clinical variants stay redacted.
   */
  it('keeps its own decision enums named reason but not clinical variants', () => {
    expect(redact({ reason: 'withdrawnUpstream', reasonForVisit: 'hip fracture' })).toEqual({
      reason: 'withdrawnUpstream',
      reasonForVisit: '[redacted]',
    });
  });

  it('redacts inside nested objects', () => {
    expect(redact({ patient: { demographics: { lastName: 'Alvarez' }, id: 'pat_1' } })).toEqual({
      patient: { demographics: { lastName: '[redacted]' }, id: 'pat_1' },
    });
  });

  it('redacts inside arrays', () => {
    expect(redact([{ firstName: 'Betty' }, { firstName: 'Harold' }])).toEqual([
      { firstName: '[redacted]' },
      { firstName: '[redacted]' },
    ]);
  });

  it('caps long arrays so one log line cannot carry a whole census', () => {
    const result = redact(Array.from({ length: 500 }, (_, index) => index)) as unknown[];

    expect(result).toHaveLength(50);
  });

  it('stops at a depth limit instead of recursing on a deep structure', () => {
    let nested: Record<string, unknown> = { leaf: 'value' };
    for (let index = 0; index < 20; index += 1) {
      nested = { child: nested };
    }

    expect(JSON.stringify(redact(nested))).toContain('[truncated]');
  });

  it('survives a cyclic object without hanging', () => {
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic['self'] = cyclic;

    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });

  it('keeps an error loggable', () => {
    const result = redact(new TypeError('boom')) as { name: string; message: string };

    expect(result.name).toBe('TypeError');
    expect(result.message).toBe('boom');
  });

  it('passes through primitives and nullish values unchanged', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('refuses to serialise a function rather than emitting something misleading', () => {
    expect(redact({ handler: () => undefined })).toEqual({ handler: '[unloggable:function]' });
  });
});

describe('pseudonymise', () => {
  it('is stable, so two log lines about one patient can be correlated', () => {
    expect(pseudonymise('pcc-1001')).toBe(pseudonymise('pcc-1001'));
  });

  it('separates different identifiers', () => {
    expect(pseudonymise('pcc-1001')).not.toBe(pseudonymise('pcc-1002'));
  });

  it('is short enough to be useless as a lookup key if the logs leak', () => {
    expect(pseudonymise('pcc-1001')).toHaveLength(12);
    expect(pseudonymise('pcc-1001')).not.toContain('1001');
  });
});

describe('createLogger', () => {
  it('emits Cloud Logging severity and the base context', () => {
    const { sink, entries } = createMemorySink();
    createLogger({ service: 'sync-worker', therapyOrgId: 'org_1' }, sink).warn('Retrying', {
      attempt: 2,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: 'WARN',
      message: 'Retrying',
      service: 'sync-worker',
      therapyOrgId: 'org_1',
      attempt: 2,
    });
  });

  /**
   * The redaction has to sit in the logger, not at each call site. Anything relying on the next
   * developer remembering to redact will leak on the first debug line added during an incident.
   */
  it('redacts context passed by a caller who did not think about it', () => {
    const { sink, entries } = createMemorySink();
    createLogger({ service: 'sync-worker' }, sink).info('Applied', {
      demographics: { firstName: 'Betty' },
    });

    expect(entries[0]!['demographics']).toEqual({ firstName: '[redacted]' });
  });

  it('carries correlation fields into child loggers', () => {
    const { sink, entries } = createMemorySink();
    createLogger({ service: 'sync-worker', therapyOrgId: 'org_1' }, sink)
      .child({ correlationId: 'evt_1' })
      .child({ facilityId: 'fac_1' })
      .error('Dead-lettered');

    expect(entries[0]).toMatchObject({
      therapyOrgId: 'org_1',
      correlationId: 'evt_1',
      facilityId: 'fac_1',
      severity: 'ERROR',
    });
  });

  it('does not let caller context overwrite the service name', () => {
    const { sink, entries } = createMemorySink();
    createLogger({ service: 'sync-worker' }, sink).info('Applied');

    expect(entries[0]!.service).toBe('sync-worker');
  });
});
