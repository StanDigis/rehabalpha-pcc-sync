import { PermanentSyncError } from '@rehabalpha/core';
import type { PccPatient } from '@rehabalpha/pcc-client';
import { describe, expect, it } from 'vitest';
import { toPatientProjection, type PatientProjectionInput } from './patient.js';

const NOW = '2026-03-15T12:00:00.000Z';

function pccPatient(overrides: Partial<PccPatient> = {}): PccPatient {
  return {
    patientId: '1001',
    facId: '7',
    firstName: 'Betty',
    lastName: 'Alvarez',
    middleName: null,
    preferredName: null,
    birthDate: '1941-06-12',
    gender: 'Female',
    medicalRecordNumber: 'MRN-77',
    patientStatus: 'Current',
    lastUpdateDatetime: '2026-03-14T09:30:00-04:00',
    ...overrides,
  };
}

function project(overrides: Partial<PccPatient> = {}, input: Partial<PatientProjectionInput> = {}) {
  return toPatientProjection({
    pccPatient: pccPatient(overrides),
    therapyOrgId: 'org_1',
    facilityId: 'fac_ferncrest',
    pccOrgUuid: 'org-uuid-1',
    pccFacId: '7',
    source: 'webhook',
    causedByEventId: 'evt_1',
    now: NOW,
    ...input,
  });
}

describe('toPatientProjection', () => {
  it('derives a deterministic document id from the PCC identifiers', () => {
    expect(project().document.id).toBe(project().document.id);
    expect(project().document.id).toContain('1001');
  });

  it('normalises the upstream watermark to UTC', () => {
    expect(project().watermark).toBe('2026-03-14T13:30:00.000Z');
    expect(project().document.sync.pccLastModified).toBe('2026-03-14T13:30:00.000Z');
  });

  it('carries a null watermark when PCC asserts no modification time', () => {
    expect(project({ lastUpdateDatetime: null }).watermark).toBeNull();
  });

  it('maps a pick-list value while keeping what actually arrived', () => {
    expect(project().document.demographics.administrativeSex).toEqual({
      value: 'FEMALE',
      raw: 'Female',
    });
  });

  /**
   * An unrecognised pick-list value must not fail the sync. PCC adds values without notice, and
   * rejecting the patient over a marital status would turn a cosmetic upstream change into an outage.
   */
  it('accepts an unrecognised pick-list value and preserves it verbatim', () => {
    expect(project({ gender: 'X' }).document.demographics.administrativeSex).toEqual({
      value: 'UNKNOWN',
      raw: 'X',
    });
  });

  it.each(['firstName', 'lastName'] as const)('refuses a patient with no %s', (field) => {
    expect(() => project({ [field]: null })).toThrow(PermanentSyncError);
  });

  /**
   * The transformer stays a pure function of upstream state. Identity is RehabAlpha-owned and is
   * restored from the stored document by `planProjectionWrite`, so emitting null here is what stops
   * local decisions from leaking into a projection.
   */
  it('emits RehabAlpha-owned fields as null rather than guessing at them', () => {
    const { document } = project();

    expect(document.personId).toBeNull();
    expect(document.personLink).toBeNull();
    expect(document.currentAdmissionId).toBeNull();
  });

  it('produces the same content hash for the same upstream record', () => {
    expect(project().contentHash).toBe(project().contentHash);
  });

  /**
   * Provenance is excluded from the hash on purpose: `syncedAt` moves on every pass, so including it
   * would make every comparison report a change and a reconciliation sweep would rewrite everything.
   */
  it('ignores provenance when hashing, so a re-read of unchanged data is a no-op', () => {
    const first = project({}, { now: NOW, source: 'webhook', causedByEventId: 'evt_1' });
    const second = project(
      {},
      { now: '2026-04-01T00:00:00.000Z', source: 'reconciliation', causedByEventId: 'evt_2' },
    );

    expect(second.contentHash).toBe(first.contentHash);
  });

  it('changes the hash when a synchronised field changes', () => {
    expect(project({ lastName: 'Alvarez-Reyes' }).contentHash).not.toBe(project().contentHash);
  });

  /**
   * The watermark is not part of the hash either. A PCC edit that touches only their modification
   * time — a reindex, a no-op save — has to be recognised as unchanged content so the audit trail
   * does not fill with writes that changed nothing.
   */
  it('leaves the hash alone when only the upstream timestamp moved', () => {
    expect(project({ lastUpdateDatetime: '2026-03-20T00:00:00Z' }).contentHash).toBe(
      project().contentHash,
    );
  });

  it('records the facility and tenant it was projected into', () => {
    const { document } = project();

    expect(document).toMatchObject({
      therapyOrgId: 'org_1',
      facilityId: 'fac_ferncrest',
      pcc: { orgUuid: 'org-uuid-1', facId: '7', patientId: '1001' },
    });
  });
});
