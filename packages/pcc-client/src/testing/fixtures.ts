import type {
  PccActivation,
  PccAdtRecord,
  PccCoverage,
  PccFacility,
  PccMasterPatient,
  PccPatient,
  PccWebhookSubscription,
} from '../schemas.js';

/**
 * Recorded PCC payloads for local runs, integration tests and the demo.
 *
 * The scenario is the one from the challenge brief, because it exercises every case the design
 * claims to handle rather than a happy path:
 *
 *   Betty Abernathy breaks her hip and is admitted to Ferncrest. She goes out to hospital for
 *   two days — a leave of absence, not a discharge — and returns. Her Medicare Part A coverage
 *   ends and Medicaid takes over as primary, so the coverage timeline has a real transition in
 *   it instead of a single open-ended row. She later appears at a second facility the same
 *   therapy company serves, under a different medical record number, which is the identity
 *   resolution case.
 *
 * Harold has two payers of the same rank over overlapping dates, which is the upstream data
 * problem the coverage policy is expected to warn about rather than silently accept.
 */

export const FIXTURE_ORG_UUID = 'a7f1c2d4-9b3e-4c81-8f27-5d6a0e1b3c94';
export const FIXTURE_FERNCREST_FAC_ID = '22';
export const FIXTURE_LAKESIDE_FAC_ID = '31';

export const BETTY_PCC_PATIENT_ID = '1001';
export const HAROLD_PCC_PATIENT_ID = '1002';
export const BETTY_LAKESIDE_PCC_PATIENT_ID = '2001';

export const fixtureActivations: PccActivation[] = [
  {
    orgUuid: FIXTURE_ORG_UUID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    activationStatus: 'ACTIVE',
    activatedDate: '2026-06-01',
  },
  {
    orgUuid: FIXTURE_ORG_UUID,
    facId: FIXTURE_LAKESIDE_FAC_ID,
    activationStatus: 'ACTIVE',
    activatedDate: '2026-07-15',
  },
];

export const fixtureFacilities: PccFacility[] = [
  {
    facId: FIXTURE_FERNCREST_FAC_ID,
    facilityName: 'Ferncrest Skilled Nursing Facility',
    timeZone: 'America/New_York',
    stateCode: 'NY',
  },
  {
    facId: FIXTURE_LAKESIDE_FAC_ID,
    facilityName: 'Lakeside Senior Living',
    timeZone: 'America/New_York',
    stateCode: 'NY',
  },
];

export const fixturePatients: PccPatient[] = [
  {
    patientId: BETTY_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    firstName: 'Betty',
    lastName: 'Abernathy',
    middleName: 'Jean',
    preferredName: 'Betty',
    birthDate: '1948-09-11',
    gender: 'FEMALE',
    medicalRecordNumber: 'FC-100244',
    patientStatus: 'CURRENT',
    lastUpdateDatetime: '2026-08-11T14:05:00Z',
  },
  {
    patientId: HAROLD_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    firstName: 'Harold',
    lastName: 'Nguyen',
    // Middle name is absent upstream, which is the common case and must not fail validation.
    birthDate: '1939-02-04',
    gender: 'MALE',
    medicalRecordNumber: 'FC-100251',
    patientStatus: 'CURRENT',
    lastUpdateDatetime: '2026-08-04T09:12:00Z',
  },
  {
    patientId: BETTY_LAKESIDE_PCC_PATIENT_ID,
    facId: FIXTURE_LAKESIDE_FAC_ID,
    firstName: 'Betty',
    lastName: 'Abernathy',
    birthDate: '1948-09-11',
    gender: 'FEMALE',
    // A different facility assigns its own medical record number to the same human.
    medicalRecordNumber: 'LS-55120',
    patientStatus: 'CURRENT',
    lastUpdateDatetime: '2026-09-20T10:00:00Z',
  },
];

export const fixtureAdtRecords: PccAdtRecord[] = [
  {
    adtRecordId: '9001',
    patientId: BETTY_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    actionCode: 'ADMISSION',
    effectiveDateTime: '2026-08-01T16:30:00Z',
    admissionDate: '2026-08-01',
    unitDescription: 'Rehab Wing',
    roomDescription: '204',
    bedDescription: 'A',
    lastUpdateDatetime: '2026-08-01T16:35:00Z',
  },
  {
    adtRecordId: '9002',
    patientId: BETTY_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    actionCode: 'LEAVE_OF_ABSENCE',
    effectiveDateTime: '2026-08-09T08:00:00Z',
    admissionDate: '2026-08-01',
    lastUpdateDatetime: '2026-08-09T08:05:00Z',
  },
  {
    adtRecordId: '9003',
    patientId: BETTY_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    actionCode: 'RETURN_FROM_LEAVE',
    effectiveDateTime: '2026-08-11T13:45:00Z',
    admissionDate: '2026-08-01',
    unitDescription: 'Rehab Wing',
    roomDescription: '207',
    bedDescription: 'B',
    lastUpdateDatetime: '2026-08-11T14:05:00Z',
  },
  {
    adtRecordId: '9010',
    patientId: HAROLD_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    actionCode: 'ADMISSION',
    effectiveDateTime: '2026-07-15T11:00:00Z',
    admissionDate: '2026-07-15',
    lastUpdateDatetime: '2026-07-15T11:10:00Z',
  },
  {
    adtRecordId: '9011',
    patientId: HAROLD_PCC_PATIENT_ID,
    facId: FIXTURE_FERNCREST_FAC_ID,
    actionCode: 'DISCHARGE',
    effectiveDateTime: '2026-08-04T15:20:00Z',
    admissionDate: '2026-07-15',
    dischargeDate: '2026-08-04',
    lastUpdateDatetime: '2026-08-04T15:25:00Z',
  },
  {
    adtRecordId: '9020',
    patientId: BETTY_LAKESIDE_PCC_PATIENT_ID,
    facId: FIXTURE_LAKESIDE_FAC_ID,
    actionCode: 'ADMISSION',
    effectiveDateTime: '2026-09-20T09:30:00Z',
    admissionDate: '2026-09-20',
    lastUpdateDatetime: '2026-09-20T10:00:00Z',
  },
];

export const fixtureCoverages: Record<string, PccCoverage[]> = {
  /**
   * Betty's Part A benefit ends and Medicaid becomes primary the next day. Two rows for the
   * same patient with the same rank and non-overlapping dates: correct, and the case a
   * current-value-only model cannot represent.
   */
  [BETTY_PCC_PATIENT_ID]: [
    {
      payerId: 'PAYER-MCARE-A',
      payerName: 'Medicare Part A',
      payerType: 'MEDICARE',
      payerRank: 'PRIMARY',
      planName: 'Part A Skilled Benefit',
      effectiveDate: '2026-08-01',
      expirationDate: '2026-09-15',
      authorizationRequired: false,
      approvedVisits: null,
      lastUpdateDatetime: '2026-09-16T07:00:00Z',
    },
    {
      payerId: 'PAYER-MEDICAID-NY',
      payerName: 'New York Medicaid',
      payerType: 'MEDICAID',
      payerRank: 'PRIMARY',
      effectiveDate: '2026-09-16',
      expirationDate: null,
      authorizationRequired: true,
      authorizationNumber: 'AUTH-77-2026',
      authorizationEffectiveDate: '2026-09-16',
      authorizationExpirationDate: '2026-12-15',
      approvedVisits: 24,
      lastUpdateDatetime: '2026-09-16T07:00:00Z',
    },
    {
      payerId: 'PAYER-BLUESHIELD',
      payerName: 'Blue Shield Supplemental',
      payerType: 'INSURANCE',
      payerRank: 'SECONDARY',
      effectiveDate: '2026-08-01',
      expirationDate: null,
      authorizationRequired: false,
      lastUpdateDatetime: '2026-08-01T16:35:00Z',
    },
    {
      payerId: 'PAYER-RESP-PARTY',
      payerName: 'Responsible Party — Daughter',
      payerType: 'PRIVATE_PAY',
      informationalOnly: true,
      effectiveDate: '2026-08-01',
      expirationDate: null,
      lastUpdateDatetime: '2026-08-01T16:35:00Z',
    },
  ],

  /** Two primaries over overlapping dates: upstream data problem, must produce a warning. */
  [HAROLD_PCC_PATIENT_ID]: [
    {
      payerId: 'PAYER-MCARE-A',
      payerName: 'Medicare Part A',
      payerType: 'MEDICARE',
      payerRank: 'PRIMARY',
      effectiveDate: '2026-07-15',
      expirationDate: '2026-08-04',
      lastUpdateDatetime: '2026-08-04T15:25:00Z',
    },
    {
      payerId: 'PAYER-MA-PLAN',
      payerName: 'Aetna Medicare Advantage',
      payerType: 'INSURANCE',
      payerRank: 'PRIMARY',
      effectiveDate: '2026-07-20',
      expirationDate: '2026-08-04',
      lastUpdateDatetime: '2026-08-04T15:25:00Z',
    },
  ],

  [BETTY_LAKESIDE_PCC_PATIENT_ID]: [
    {
      payerId: 'PAYER-MEDICAID-NY',
      payerName: 'New York Medicaid',
      payerType: 'MEDICAID',
      payerRank: 'PRIMARY',
      effectiveDate: '2026-09-20',
      expirationDate: null,
      authorizationRequired: true,
      authorizationNumber: 'AUTH-91-2026',
      approvedVisits: 18,
      lastUpdateDatetime: '2026-09-20T10:00:00Z',
    },
  ],
};

/**
 * PCC's organisation master patient record ties Betty's two facility records together, which is
 * the authoritative answer the identity policy prefers over any local scoring.
 */
export const fixtureMasterPatients: Record<string, PccMasterPatient> = {
  [BETTY_PCC_PATIENT_ID]: {
    organizationMasterPatientId: 'OMP-4410',
    patients: [
      { patientId: BETTY_PCC_PATIENT_ID, facId: FIXTURE_FERNCREST_FAC_ID },
      { patientId: BETTY_LAKESIDE_PCC_PATIENT_ID, facId: FIXTURE_LAKESIDE_FAC_ID },
    ],
  },
  [BETTY_LAKESIDE_PCC_PATIENT_ID]: {
    organizationMasterPatientId: 'OMP-4410',
    patients: [
      { patientId: BETTY_PCC_PATIENT_ID, facId: FIXTURE_FERNCREST_FAC_ID },
      { patientId: BETTY_LAKESIDE_PCC_PATIENT_ID, facId: FIXTURE_LAKESIDE_FAC_ID },
    ],
  },
};

export const fixtureWebhookSubscriptions: PccWebhookSubscription[] = [
  {
    subscriptionId: 'SUB-1',
    eventTypes: ['patient.updated', 'adt.created', 'coverage.updated'],
    targetUrl: 'https://sync.rehabalpha.example/pcc/webhook',
    status: 'ACTIVE',
  },
];

export type PccFixtureData = {
  activations: PccActivation[];
  facilities: PccFacility[];
  patients: PccPatient[];
  adtRecords: PccAdtRecord[];
  coverages: Record<string, PccCoverage[]>;
  masterPatients: Record<string, PccMasterPatient>;
  webhookSubscriptions: PccWebhookSubscription[];
};

export function createFixtureData(): PccFixtureData {
  // Deep-cloned so a test that mutates a fixture cannot leak into the next one.
  return structuredClone({
    activations: fixtureActivations,
    facilities: fixtureFacilities,
    patients: fixturePatients,
    adtRecords: fixtureAdtRecords,
    coverages: fixtureCoverages,
    masterPatients: fixtureMasterPatients,
    webhookSubscriptions: fixtureWebhookSubscriptions,
  });
}
