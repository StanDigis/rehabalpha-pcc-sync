import type { PccAdtRecord } from '@rehabalpha/pcc-client';
import { describe, expect, it } from 'vitest';
import { toAdmissionProjections } from './admission.js';

const NOW = '2026-03-15T12:00:00.000Z';

let sequence = 0;

function adt(overrides: Partial<PccAdtRecord> = {}): PccAdtRecord {
  sequence += 1;
  return {
    adtRecordId: `adt-${String(sequence).padStart(3, '0')}`,
    patientId: '1001',
    facId: '7',
    actionCode: 'ADMISSION',
    actionType: null,
    effectiveDateTime: '2026-01-05T14:00:00Z',
    admissionDate: '2026-01-05',
    dischargeDate: null,
    unitDescription: 'North',
    roomDescription: '204',
    bedDescription: 'A',
    lastUpdateDatetime: '2026-01-05T14:05:00Z',
    ...overrides,
  };
}

function project(records: PccAdtRecord[]) {
  return toAdmissionProjections({
    pccAdtRecords: records,
    therapyOrgId: 'org_1',
    facilityId: 'fac_ferncrest',
    pccOrgUuid: 'org-uuid-1',
    pccFacId: '7',
    patientId: 'pat_1',
    pccPatientId: '1001',
    source: 'webhook',
    causedByEventId: 'evt_1',
    now: NOW,
  });
}

describe('toAdmissionProjections', () => {
  it('reconstructs a single active stay from an admission record', () => {
    const { projections } = project([adt()]);

    expect(projections).toHaveLength(1);
    expect(projections[0]!.document).toMatchObject({
      status: 'admitted',
      admitDate: '2026-01-05',
      dischargeDate: null,
      location: { unit: 'North', room: '204', bed: 'A' },
    });
  });

  it('applies a discharge that follows the admission', () => {
    const { projections } = project([
      adt(),
      adt({
        actionCode: 'DISCHARGE',
        effectiveDateTime: '2026-02-10T16:00:00Z',
        dischargeDate: '2026-02-10',
      }),
    ]);

    expect(projections).toHaveLength(1);
    expect(projections[0]!.document).toMatchObject({
      status: 'discharged',
      dischargeDate: '2026-02-10',
    });
  });

  /**
   * The readmission case from the brief. A stay is identified by the patient plus the date they were
   * admitted; keying on the patient alone collapses two stays into one record whose admit date
   * silently changes, and the earlier episode's therapy history loses its anchor.
   */
  it('keeps a readmission as a separate stay rather than mutating the first', () => {
    const { projections } = project([
      adt(),
      adt({
        actionCode: 'DISCHARGE',
        effectiveDateTime: '2026-02-10T16:00:00Z',
        dischargeDate: '2026-02-10',
      }),
      adt({
        actionCode: 'READMISSION',
        effectiveDateTime: '2026-03-01T11:00:00Z',
        admissionDate: '2026-03-01',
      }),
    ]);

    expect(projections).toHaveLength(2);
    expect(projections.map((row) => row.document.admitDate).sort()).toEqual([
      '2026-01-05',
      '2026-03-01',
    ]);
    expect(projections.map((row) => row.document.id)).toHaveLength(
      new Set(projections.map((row) => row.document.id)).size,
    );
  });

  /**
   * Leave of absence is the case that is easy to model wrongly. The resident is temporarily out of
   * the building — a hospital visit — but the stay has not ended. Treating it as a discharge drops
   * them off every caseload and then creates a duplicate stay when they come back.
   */
  it('keeps a stay active through a leave of absence', () => {
    const { projections } = project([
      adt(),
      adt({ actionCode: 'LEAVE_OF_ABSENCE', effectiveDateTime: '2026-02-01T09:00:00Z' }),
    ]);

    expect(projections[0]!.document.status).toBe('onLeaveOfAbsence');
    expect(projections[0]!.document.dischargeDate).toBeNull();
  });

  it('returns the stay to admitted when the resident comes back', () => {
    const { projections } = project([
      adt(),
      adt({ actionCode: 'LEAVE_OF_ABSENCE', effectiveDateTime: '2026-02-01T09:00:00Z' }),
      adt({ actionCode: 'RETURN_FROM_LEAVE', effectiveDateTime: '2026-02-04T15:00:00Z' }),
    ]);

    expect(projections[0]!.document.status).toBe('admitted');
  });

  /**
   * Ordering carries the meaning. Applied backwards, a leave followed by a return leaves the resident
   * permanently out of the building, off every caseload, with nothing logged — and PCC gives no
   * ordering guarantee on delivery.
   */
  it('folds events in effective-time order however they arrive', () => {
    const records = [
      adt({ actionCode: 'RETURN_FROM_LEAVE', effectiveDateTime: '2026-02-04T15:00:00Z' }),
      adt(),
      adt({ actionCode: 'LEAVE_OF_ABSENCE', effectiveDateTime: '2026-02-01T09:00:00Z' }),
    ];

    const forwards = project(records);
    const backwards = project([...records].reverse());

    expect(forwards.projections[0]!.document.status).toBe('admitted');
    expect(backwards.projections[0]!.contentHash).toBe(forwards.projections[0]!.contentHash);
  });

  it('is deterministic when two records share an effective instant', () => {
    const a = adt({
      actionCode: 'INTERNAL_TRANSFER',
      adtRecordId: 'adt-b',
      roomDescription: '310',
    });
    const b = adt({
      actionCode: 'INTERNAL_TRANSFER',
      adtRecordId: 'adt-a',
      roomDescription: '208',
    });

    expect(project([a, b]).projections[0]!.contentHash).toBe(
      project([b, a]).projections[0]!.contentHash,
    );
  });

  it('follows an internal transfer to the new room', () => {
    const { projections } = project([
      adt(),
      adt({
        actionCode: 'INTERNAL_TRANSFER',
        effectiveDateTime: '2026-01-20T10:00:00Z',
        unitDescription: 'South',
        roomDescription: '310',
        bedDescription: 'B',
      }),
    ]);

    expect(projections[0]!.document.location).toEqual({ unit: 'South', room: '310', bed: 'B' });
    expect(projections[0]!.document.status).toBe('admitted');
  });

  /**
   * A stale discharge date on an active stay is what makes a resident vanish from a caseload after
   * they have already returned.
   */
  it('clears a discharge date once the stay is active again', () => {
    const { projections } = project([
      adt(),
      adt({
        actionCode: 'DISCHARGE',
        effectiveDateTime: '2026-02-10T16:00:00Z',
        dischargeDate: '2026-02-10',
      }),
      adt({ actionCode: 'RETURN_FROM_LEAVE', effectiveDateTime: '2026-02-12T10:00:00Z' }),
    ]);

    expect(projections[0]!.document).toMatchObject({ status: 'admitted', dischargeDate: null });
  });

  it('leaves the status untouched for an ADT action it does not recognise', () => {
    const { projections } = project([
      adt(),
      adt({ actionCode: 'SOMETHING_NEW', effectiveDateTime: '2026-02-01T09:00:00Z' }),
    ]);

    expect(projections[0]!.document.status).toBe('admitted');
    expect(projections[0]!.document.lastAdt).toMatchObject({
      action: { value: 'UNKNOWN', raw: 'SOMETHING_NEW' },
    });
  });

  it('accepts the alternative field name PCC uses for the action', () => {
    const { projections } = project([adt({ actionCode: null, actionType: 'Admission' })]);

    expect(projections[0]!.document.status).toBe('admitted');
  });

  it('reports an ADT record it cannot attribute to a stay instead of dropping it', () => {
    const { projections, unattributed } = project([
      adt({ actionCode: 'DISCHARGE', admissionDate: null, dischargeDate: '2026-02-10' }),
    ]);

    expect(projections).toEqual([]);
    expect(unattributed).toEqual([
      { adtRecordId: expect.any(String), reason: 'no_admission_date_in_history' },
    ]);
  });

  it('takes the newest upstream timestamp in the stay as its watermark', () => {
    const { projections } = project([
      adt({ lastUpdateDatetime: '2026-01-05T14:05:00Z' }),
      adt({
        actionCode: 'INTERNAL_TRANSFER',
        effectiveDateTime: '2026-01-20T10:00:00Z',
        lastUpdateDatetime: '2026-01-20T10:30:00-05:00',
      }),
    ]);

    expect(projections[0]!.watermark).toBe('2026-01-20T15:30:00.000Z');
  });

  it('returns nothing at all for a patient with no ADT history', () => {
    expect(project([])).toEqual({ projections: [], unattributed: [] });
  });

  it('excludes provenance from the hash so a re-read is a no-op', () => {
    const records = [adt()];
    const first = toAdmissionProjections({
      pccAdtRecords: records,
      therapyOrgId: 'org_1',
      facilityId: 'fac_ferncrest',
      pccOrgUuid: 'org-uuid-1',
      pccFacId: '7',
      patientId: 'pat_1',
      pccPatientId: '1001',
      source: 'webhook',
      causedByEventId: 'evt_1',
      now: NOW,
    });
    const second = toAdmissionProjections({
      pccAdtRecords: records,
      therapyOrgId: 'org_1',
      facilityId: 'fac_ferncrest',
      pccOrgUuid: 'org-uuid-1',
      pccFacId: '7',
      patientId: 'pat_1',
      pccPatientId: '1001',
      source: 'reconciliation',
      causedByEventId: null,
      now: '2026-04-01T00:00:00.000Z',
    });

    expect(second.projections[0]!.contentHash).toBe(first.projections[0]!.contentHash);
  });
});
