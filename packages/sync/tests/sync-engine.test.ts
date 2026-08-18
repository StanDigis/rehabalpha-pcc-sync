import { documentIds, PermanentSyncError } from '@rehabalpha/core';
import {
  BETTY_LAKESIDE_PCC_PATIENT_ID,
  BETTY_PCC_PATIENT_ID,
  FIXTURE_FERNCREST_FAC_ID,
  FIXTURE_LAKESIDE_FAC_ID,
  FIXTURE_ORG_UUID,
  HAROLD_PCC_PATIENT_ID,
} from '@rehabalpha/pcc-client/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/firestore/collections.js';
import {
  createHarness,
  FERNCREST_ID,
  LAKESIDE_ID,
  THERAPY_ORG_ID,
  type Harness,
} from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ namespace: 'sync-engine' });
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.reset();
});

const bettyRequest = {
  therapyOrgId: THERAPY_ORG_ID,
  pccOrgUuid: FIXTURE_ORG_UUID,
  pccFacId: FIXTURE_FERNCREST_FAC_ID,
  pccPatientId: BETTY_PCC_PATIENT_ID,
  scope: 'all' as const,
  source: 'webhook' as const,
  causedByEventId: 'evt_1',
};

const bettyPatientId = documentIds.patient(FIXTURE_ORG_UUID, BETTY_PCC_PATIENT_ID);

describe('syncing a patient end to end', () => {
  it('writes the patient, their stay and their coverage timeline', async () => {
    const outcomes = await h.engine.sync(bettyRequest);

    expect(outcomes.map((outcome) => outcome.entityType)).toEqual(
      expect.arrayContaining(['patient', 'admission', 'coverage']),
    );

    const patient = await h.store.getPatient(bettyPatientId);
    expect(patient).toMatchObject({
      therapyOrgId: THERAPY_ORG_ID,
      facilityId: FERNCREST_ID,
      demographics: { firstName: 'Betty', lastName: 'Abernathy', birthDate: '1948-09-11' },
    });
  });

  /**
   * Betty goes out to hospital for two days and comes back. That is one stay with a leave in the
   * middle, not two stays and not a discharge — and a discharged resident drops off every caseload.
   */
  it('reconstructs the leave of absence as one continuous stay', async () => {
    await h.engine.sync(bettyRequest);

    const admissions = await h.store.listAdmissionsForPatient(THERAPY_ORG_ID, bettyPatientId);

    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      status: 'admitted',
      admitDate: '2026-08-01',
      dischargeDate: null,
      // The return-from-leave record moved her to a different room.
      location: { unit: 'Rehab Wing', room: '207', bed: 'B' },
    });
  });

  it('points the patient at their current stay so a caseload needs no second query', async () => {
    await h.engine.sync(bettyRequest);

    const patient = await h.store.getPatient(bettyPatientId);
    const admissions = await h.store.listAdmissionsForPatient(THERAPY_ORG_ID, bettyPatientId);

    expect(patient!.currentAdmissionId).toBe(admissions[0]!.id);
  });

  /**
   * Betty's Part A benefit ends on 15 September and Medicaid takes over on the 16th. Both rows must
   * exist with their real dates: a current-value model would show only Medicaid and could no longer
   * explain what was billable in August.
   */
  it('keeps both sides of a payer transition with their effective dates', async () => {
    await h.engine.sync(bettyRequest);

    const coverages = await h.store.listCoveragesForPatient(THERAPY_ORG_ID, bettyPatientId);
    const byPayer = new Map(coverages.map((row) => [row.payer.pccPayerId, row]));

    expect(coverages).toHaveLength(4);
    expect(byPayer.get('PAYER-MCARE-A')).toMatchObject({
      rank: 'primary',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-09-15',
    });
    expect(byPayer.get('PAYER-MEDICAID-NY')).toMatchObject({
      rank: 'primary',
      effectiveFrom: '2026-09-16',
      effectiveTo: null,
    });
  });

  it('marks the responsible party as informational so it is never billed', async () => {
    await h.engine.sync(bettyRequest);

    const coverages = await h.store.listCoveragesForPatient(THERAPY_ORG_ID, bettyPatientId);
    const responsibleParty = coverages.find((row) => row.payer.pccPayerId === 'PAYER-RESP-PARTY');

    expect(responsibleParty!.rank).toBe('informational');
  });

  it('carries the authorisation details billing needs', async () => {
    await h.engine.sync(bettyRequest);

    const coverages = await h.store.listCoveragesForPatient(THERAPY_ORG_ID, bettyPatientId);
    const medicaid = coverages.find((row) => row.payer.pccPayerId === 'PAYER-MEDICAID-NY');

    expect(medicaid!.authorization).toMatchObject({
      required: true,
      number: 'AUTH-77-2026',
      approvedVisits: 24,
    });
  });

  it('records what it did in the audit log', async () => {
    await h.engine.sync(bettyRequest);

    const snapshot = await h.db
      .collection(COLLECTIONS.auditEvents)
      .where('therapyOrgId', '==', THERAPY_ORG_ID)
      .get();

    const actions = snapshot.docs.map((doc) => String(doc.get('action')));
    expect(actions).toContain('patient.created');
    expect(snapshot.docs.every((doc) => doc.get('actor.kind') === 'system')).toBe(true);
  });

  /**
   * The audit log records that `demographics.lastName` changed. It must not record what it changed
   * to, or the audit collection becomes the largest unmanaged store of PHI in the system.
   */
  it('keeps patient data out of the audit detail', async () => {
    await h.engine.sync(bettyRequest);

    const snapshot = await h.db.collection(COLLECTIONS.auditEvents).get();
    const serialised = JSON.stringify(snapshot.docs.map((doc) => doc.get('detail')));

    expect(serialised).not.toContain('Abernathy');
    expect(serialised).not.toContain('1948-09-11');
  });

  it('keeps patient data out of the logs', async () => {
    await h.engine.sync(bettyRequest);

    const serialised = JSON.stringify(h.logs);

    expect(serialised).not.toContain('Abernathy');
    expect(serialised).not.toContain('FC-100244');
  });
});

describe('idempotency', () => {
  /**
   * PCC delivers at least once, so the same notification arriving twice is normal traffic rather
   * than an error. The second pass has to be a no-op: writes cost money, and an audit trail full of
   * entries that changed nothing is an audit trail nobody reads.
   */
  it('applies a repeated delivery as a no-op', async () => {
    await h.engine.sync(bettyRequest);
    const auditsAfterFirst = (await h.db.collection(COLLECTIONS.auditEvents).count().get()).data()
      .count;

    const second = await h.engine.sync(bettyRequest);
    const auditsAfterSecond = (await h.db.collection(COLLECTIONS.auditEvents).count().get()).data()
      .count;

    expect(second.every((outcome) => !outcome.applied)).toBe(true);
    expect(auditsAfterSecond).toBe(auditsAfterFirst);
  });

  it('leaves the stored document byte-identical on a repeated delivery', async () => {
    await h.engine.sync(bettyRequest);
    const first = await h.store.getPatient(bettyPatientId);

    await h.engine.sync(bettyRequest);
    const second = await h.store.getPatient(bettyPatientId);

    expect(second).toEqual(first);
  });

  /**
   * Out-of-order delivery is the case that corrupts data silently. A slow delivery of an old change
   * arriving after a new one must not overwrite the newer state.
   */
  it('refuses to apply an older version of the record over a newer one', async () => {
    h.pcc.patchPatient(BETTY_PCC_PATIENT_ID, {
      lastName: 'Abernathy-Reyes',
      lastUpdateDatetime: '2026-09-24T10:00:00Z',
    });
    await h.engine.sync(bettyRequest);

    h.pcc.patchPatient(BETTY_PCC_PATIENT_ID, {
      lastName: 'Abernathy',
      lastUpdateDatetime: '2026-08-11T14:05:00Z',
    });
    const outcomes = await h.engine.sync({ ...bettyRequest, scope: 'patient' });

    const patient = await h.store.getPatient(bettyPatientId);
    expect(patient!.demographics.lastName).toBe('Abernathy-Reyes');
    expect(outcomes[0]!.decision).toBe('staleWatermark');
  });

  it('applies a genuine upstream change', async () => {
    await h.engine.sync(bettyRequest);

    h.pcc.patchPatient(BETTY_PCC_PATIENT_ID, {
      preferredName: 'Bee',
      lastUpdateDatetime: '2026-09-24T10:00:00Z',
    });
    const outcomes = await h.engine.sync({ ...bettyRequest, scope: 'patient' });

    const patient = await h.store.getPatient(bettyPatientId);
    expect(patient!.demographics.preferredName).toBe('Bee');
    expect(outcomes[0]!.applied).toBe(true);
  });
});

describe('field ownership', () => {
  /**
   * A confirmed identity link must survive every later demographic edit. Resetting it would send an
   * already reviewed patient back to the review queue on each pass, which is how a review queue
   * becomes something operators stop looking at.
   */
  it('preserves the identity link across an upstream demographic change', async () => {
    await h.engine.sync(bettyRequest);
    const linked = await h.store.getPatient(bettyPatientId);
    expect(linked!.personId).not.toBeNull();

    h.pcc.patchPatient(BETTY_PCC_PATIENT_ID, {
      preferredName: 'Bee',
      lastUpdateDatetime: '2026-09-24T10:00:00Z',
    });
    await h.engine.sync({ ...bettyRequest, scope: 'patient' });

    const after = await h.store.getPatient(bettyPatientId);
    expect(after!.personId).toBe(linked!.personId);
    expect(after!.currentAdmissionId).toBe(linked!.currentAdmissionId);
  });
});

describe('coverage that disappears upstream', () => {
  /**
   * PCC returns the current payer tree, so a coverage that is simply absent is ambiguous: it may
   * have ended, or been corrected away, or the response may be partial. It is closed as of today
   * rather than deleted, and flagged, because every claim already submitted rests on it.
   */
  it('closes the row instead of deleting it, and says the end date was inferred', async () => {
    await h.engine.sync(bettyRequest);

    h.pcc.setCoverages(BETTY_PCC_PATIENT_ID, [
      h.pcc.data.coverages[BETTY_PCC_PATIENT_ID]![0]!, // Medicare Part A only
    ]);
    const outcomes = await h.engine.sync({ ...bettyRequest, scope: 'coverage' });

    const coverages = await h.store.listCoveragesForPatient(THERAPY_ORG_ID, bettyPatientId);
    const medicaid = coverages.find((row) => row.payer.pccPayerId === 'PAYER-MEDICAID-NY');

    expect(coverages).toHaveLength(4);
    expect(medicaid).toMatchObject({
      status: 'ended',
      effectiveTo: '2026-09-25',
      closure: { reason: 'withdrawnUpstream', inferred: true },
    });

    const coverageOutcome = outcomes.find((outcome) => outcome.entityType === 'coverage');
    expect(coverageOutcome!.warnings.map((warning) => warning.code)).toContain(
      'coverage.withdrawnWithoutEndDate',
    );
  });

  it('opens a drift record so somebody has to look at the inferred closure', async () => {
    await h.engine.sync(bettyRequest);
    h.pcc.setCoverages(BETTY_PCC_PATIENT_ID, [h.pcc.data.coverages[BETTY_PCC_PATIENT_ID]![0]!]);
    await h.engine.sync({ ...bettyRequest, scope: 'coverage' });

    const drift = await h.db
      .collection(COLLECTIONS.driftRecords)
      .where('therapyOrgId', '==', THERAPY_ORG_ID)
      .get();

    expect(drift.empty).toBe(false);
    expect(drift.docs.some((doc) => doc.get('kind') === 'missingUpstream')).toBe(true);
  });

  it('reopens the coverage when PCC asserts it again', async () => {
    const original = h.pcc.data.coverages[BETTY_PCC_PATIENT_ID]!;
    await h.engine.sync(bettyRequest);

    h.pcc.setCoverages(BETTY_PCC_PATIENT_ID, [original[0]!]);
    await h.engine.sync({ ...bettyRequest, scope: 'coverage' });

    h.pcc.setCoverages(BETTY_PCC_PATIENT_ID, original);
    await h.engine.sync({ ...bettyRequest, scope: 'coverage' });

    const coverages = await h.store.listCoveragesForPatient(THERAPY_ORG_ID, bettyPatientId);
    const medicaid = coverages.find((row) => row.payer.pccPayerId === 'PAYER-MEDICAID-NY');

    expect(medicaid).toMatchObject({ status: 'active', effectiveTo: null, closure: null });
  });
});

describe('upstream data problems', () => {
  /**
   * Harold has two payers claiming primary over overlapping dates. Billing cannot resolve that, and
   * neither can a transformer — picking one would be a billing decision made by a mapping table. It
   * is surfaced as a warning against a record that is still written.
   */
  it('warns about two primaries over overlapping dates rather than choosing one', async () => {
    const outcomes = await h.engine.sync({
      ...bettyRequest,
      pccPatientId: HAROLD_PCC_PATIENT_ID,
      causedByEventId: 'evt_harold',
    });

    const coverage = outcomes.find((outcome) => outcome.entityType === 'coverage');
    expect(coverage!.warnings.map((warning) => warning.code)).toContain('coverage.overlappingRank');

    const haroldId = documentIds.patient(FIXTURE_ORG_UUID, HAROLD_PCC_PATIENT_ID);
    const rows = await h.store.listCoveragesForPatient(THERAPY_ORG_ID, haroldId);
    expect(rows).toHaveLength(2);
  });

  it('records a discharged stay with its discharge date', async () => {
    await h.engine.sync({
      ...bettyRequest,
      pccPatientId: HAROLD_PCC_PATIENT_ID,
      causedByEventId: 'evt_harold',
    });

    const haroldId = documentIds.patient(FIXTURE_ORG_UUID, HAROLD_PCC_PATIENT_ID);
    const admissions = await h.store.listAdmissionsForPatient(THERAPY_ORG_ID, haroldId);

    expect(admissions[0]).toMatchObject({ status: 'discharged', dischargeDate: '2026-08-04' });
  });
});

describe('identity resolution', () => {
  /**
   * Betty turns up at a second facility the same therapy company serves, under that facility's own
   * medical record number. PCC's organisation master patient record ties the two together, and it is
   * authoritative — preferring it over local scoring is what makes this an automatic link rather
   * than a review.
   */
  it('links a readmission at a sister facility to the same person', async () => {
    await h.engine.sync(bettyRequest);
    const ferncrestPatient = await h.store.getPatient(bettyPatientId);

    await h.engine.sync({
      ...bettyRequest,
      pccFacId: FIXTURE_LAKESIDE_FAC_ID,
      pccPatientId: BETTY_LAKESIDE_PCC_PATIENT_ID,
      causedByEventId: 'evt_lakeside',
    });

    const lakesideId = documentIds.patient(FIXTURE_ORG_UUID, BETTY_LAKESIDE_PCC_PATIENT_ID);
    const lakesidePatient = await h.store.getPatient(lakesideId);

    expect(lakesidePatient!.facilityId).toBe(LAKESIDE_ID);
    expect(lakesidePatient!.personId).toBe(ferncrestPatient!.personId);
    expect(lakesidePatient!.personLink!.method).toBe('pccMasterPatient');
  });

  it('creates one person record, not two', async () => {
    await h.engine.sync(bettyRequest);
    await h.engine.sync({
      ...bettyRequest,
      pccFacId: FIXTURE_LAKESIDE_FAC_ID,
      pccPatientId: BETTY_LAKESIDE_PCC_PATIENT_ID,
      causedByEventId: 'evt_lakeside',
    });

    const persons = await h.db.collection(COLLECTIONS.persons).count().get();
    expect(persons.data().count).toBe(1);
  });

  it('does not link two different residents who happen to share a facility', async () => {
    await h.engine.sync(bettyRequest);
    await h.engine.sync({
      ...bettyRequest,
      pccPatientId: HAROLD_PCC_PATIENT_ID,
      causedByEventId: 'evt_harold',
    });

    const persons = await h.db.collection(COLLECTIONS.persons).get();
    expect(persons.size).toBe(2);
  });
});

describe('authorisation to synchronise', () => {
  /**
   * In contract therapy the right to a facility's patient data comes from an active contract. When
   * it lapses the data stops being the therapy company's to pull, whatever the cached PCC credential
   * still permits technically.
   */
  it('stops pulling a facility whose contract has expired', async () => {
    await h.store
      .facilityContracts()
      .doc(`ctr_${FERNCREST_ID}`)
      .set({
        id: `ctr_${FERNCREST_ID}`,
        therapyOrgId: THERAPY_ORG_ID,
        facilityId: FERNCREST_ID,
        disciplines: ['PT'],
        effectiveFrom: '2026-06-01',
        effectiveTo: '2026-08-31',
        status: 'expired',
        createdAt: '2026-06-01T00:00:00.000Z',
      });

    const outcomes = await h.engine.sync(bettyRequest);

    expect(outcomes).toEqual([
      expect.objectContaining({ applied: false, decision: 'contractInactive' }),
    ]);
    expect(await h.store.getPatient(bettyPatientId)).toBeNull();
  });

  /**
   * Already-synchronised history stays readable after a contract ends — it is needed for the
   * retention period and for claims already submitted. Only new pulls stop.
   */
  it('leaves already-synchronised records in place when a contract lapses', async () => {
    await h.engine.sync(bettyRequest);

    await h.store.facilityContracts().doc(`ctr_${FERNCREST_ID}`).update({ status: 'terminated' });
    await h.engine.sync(bettyRequest);

    expect(await h.store.getPatient(bettyPatientId)).not.toBeNull();
  });

  /**
   * A webhook for a facility nobody onboarded is not a transient problem. Retrying cannot help, and
   * it needs an operator to notice — so it is permanent and lands in the dead-letter queue.
   */
  it('fails permanently for a facility that was never onboarded', async () => {
    // The facility comes from the patient record, not the notification, so that is where an unmapped
    // facility has to appear. A notification naming a facility the patient is not in is a stale hint,
    // and following it would apply the change against the facility they just left.
    h.pcc.patchPatient(BETTY_PCC_PATIENT_ID, { facId: '999' });

    await expect(h.engine.sync(bettyRequest)).rejects.toThrow(PermanentSyncError);
  });

  it('follows the patient record when a notification names the wrong facility', async () => {
    const outcomes = await h.engine.sync({ ...bettyRequest, pccFacId: FIXTURE_LAKESIDE_FAC_ID });

    const patient = await h.store.getPatient(bettyPatientId);
    expect(patient!.facilityId).toBe(FERNCREST_ID);
    expect(outcomes[0]!.applied).toBe(true);
  });
});

describe('upstream request volume', () => {
  /**
   * A sync that reads coverage once per patient in a loop is functionally correct and operationally
   * unacceptable against an API that reserves the right to throttle us. The assertion has to be on
   * the call count, because the result looks identical either way.
   */
  it('reads each upstream collection once for a full patient sync', async () => {
    await h.engine.sync(bettyRequest);

    expect(h.pcc.callCount('getPatient')).toBe(1);
    expect(h.pcc.callCount('listAdtRecords')).toBe(1);
    expect(h.pcc.callCount('listCoverages')).toBe(1);
  });

  /**
   * A coverage notification for a 90-bed facility should not become 90 full patient refreshes,
   * which is what a single "just sync everything" scope would produce.
   */
  it('does not read the ADT history for a coverage-only notification', async () => {
    await h.engine.sync(bettyRequest);
    h.pcc.resetCalls();

    await h.engine.sync({ ...bettyRequest, scope: 'coverage' });

    expect(h.pcc.callCount('listCoverages')).toBe(1);
    expect(h.pcc.callCount('listAdtRecords')).toBe(0);
  });

  /**
   * A coverage event for a patient we have never seen still has to work. Failing and waiting for a
   * retry to overtake a patient event that may never arrive is how an event-type ordering dependency
   * turns into a permanently missing chart.
   */
  it('handles a coverage notification for a patient it has never seen', async () => {
    const outcomes = await h.engine.sync({ ...bettyRequest, scope: 'coverage' });

    expect(await h.store.getPatient(bettyPatientId)).not.toBeNull();
    expect(outcomes.some((outcome) => outcome.entityType === 'coverage' && outcome.applied)).toBe(
      true,
    );
  });
});

describe('reading coverage for a caseload', () => {
  /**
   * The query that stops a caseload screen from issuing one read per patient. Ninety residents
   * should cost three chunked queries, not ninety round trips — the defect is invisible until the
   * dataset is real.
   */
  it('fetches coverage for many patients in chunks and groups it by patient', async () => {
    await h.engine.sync(bettyRequest);
    await h.engine.sync({
      ...bettyRequest,
      pccPatientId: HAROLD_PCC_PATIENT_ID,
      causedByEventId: 'evt_harold',
    });

    const haroldId = documentIds.patient(FIXTURE_ORG_UUID, HAROLD_PCC_PATIENT_ID);
    const grouped = await h.store.listCoveragesForPatients(THERAPY_ORG_ID, [
      bettyPatientId,
      haroldId,
      // A duplicate and an unknown id, because a caller assembling ids from a list will produce both.
      bettyPatientId,
      'pat_does_not_exist',
    ]);

    expect(grouped.get(bettyPatientId)).toHaveLength(4);
    expect(grouped.get(haroldId)).toHaveLength(2);
    expect(grouped.has('pat_does_not_exist')).toBe(false);
  });

  it('returns an empty result for an empty request without querying', async () => {
    expect(await h.store.listCoveragesForPatients(THERAPY_ORG_ID, [])).toEqual(new Map());
  });
});
