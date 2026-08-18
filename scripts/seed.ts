/**
 * Seeds the emulator with demo tenant data for the ops console and Playwright E2E.
 *
 * Run via `npm run seed` from the repo root (wraps emulators:exec).
 */
import {
  createLogger,
  createMemorySink,
  documentIds,
  fixedClock,
  PermanentSyncError,
  type Facility,
  type FacilityContract,
  type PccConnection,
  type PersonMatchCandidate,
  type SyncCursor,
  type SyncTask,
  type TherapyOrg,
} from '@rehabalpha/core';
import {
  BETTY_PCC_PATIENT_ID,
  FakePccApi,
  FIXTURE_FERNCREST_FAC_ID,
  FIXTURE_LAKESIDE_FAC_ID,
  FIXTURE_ORG_UUID,
} from '@rehabalpha/pcc-client/testing';
import { AuditLog, SyncEngine, SyncStore, SyncWorker } from '@rehabalpha/sync';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const THERAPY_ORG_ID = 'org_healthpro';
const FERNCREST_ID = 'fac_ferncrest';
const LAKESIDE_ID = 'fac_lakeside';
const OPERATOR_UID = 'ops_operator';
const NOW = process.env['SEED_NOW'] ?? '2026-09-25T15:00:00.000Z';

function requireEmulator(): void {
  if (process.env['FIRESTORE_EMULATOR_HOST'] === undefined) {
    throw new Error('Seed requires the Firestore emulator. Run `npm run seed`.');
  }
}

function ferncrest(): Facility {
  return {
    id: FERNCREST_ID,
    therapyOrgId: THERAPY_ORG_ID,
    name: 'Ferncrest Skilled Nursing Facility',
    timeZone: 'America/New_York',
    pcc: { orgUuid: FIXTURE_ORG_UUID, facId: FIXTURE_FERNCREST_FAC_ID },
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

function lakeside(): Facility {
  return {
    id: LAKESIDE_ID,
    therapyOrgId: THERAPY_ORG_ID,
    name: 'Lakeside Senior Living',
    timeZone: 'America/New_York',
    pcc: { orgUuid: FIXTURE_ORG_UUID, facId: FIXTURE_LAKESIDE_FAC_ID },
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function contract(facilityId: string, effectiveFrom: string): FacilityContract {
  return {
    id: `ctr_${facilityId}`,
    therapyOrgId: THERAPY_ORG_ID,
    facilityId,
    disciplines: ['PT', 'OT', 'SLP'],
    effectiveFrom,
    effectiveTo: null,
    status: 'active',
    createdAt: effectiveFrom + 'T00:00:00.000Z',
  };
}

async function seedTenant(store: SyncStore): Promise<void> {
  const org: TherapyOrg = {
    id: THERAPY_ORG_ID,
    legalName: 'HealthPRO Rehabilitation Services LLC',
    displayName: 'HealthPRO Rehab',
    status: 'active',
    createdAt: '2026-05-01T00:00:00.000Z',
  };

  await store.therapyOrgs().doc(org.id).set(org);
  await store.facilities().doc(FERNCREST_ID).set(ferncrest());
  await store.facilities().doc(LAKESIDE_ID).set(lakeside());
  await store
    .facilityContracts()
    .doc(`ctr_${FERNCREST_ID}`)
    .set(contract(FERNCREST_ID, '2026-06-01'));
  await store
    .facilityContracts()
    .doc(`ctr_${LAKESIDE_ID}`)
    .set(contract(LAKESIDE_ID, '2026-07-15'));

  const connection: PccConnection = {
    id: 'conn_healthpro_pcc',
    therapyOrgId: THERAPY_ORG_ID,
    pccOrgUuid: FIXTURE_ORG_UUID,
    authMode: 'threeLegged',
    credentialSecretName: 'projects/demo/secrets/pcc-refresh-token/versions/3',
    activatedFacilityIds: [FIXTURE_FERNCREST_FAC_ID, FIXTURE_LAKESIDE_FAC_ID],
    consent: {
      status: 'granted',
      grantedBySubjectHash: 'sha256:demo',
      grantedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: null,
    },
    scopes: ['patient.read', 'adt.read', 'coverage.read'],
    status: 'healthy',
    lastVerifiedAt: NOW,
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  await store.pccConnections().doc(connection.id).set(connection);
}

async function seedOperatorGrant(store: SyncStore): Promise<void> {
  const clock = fixedClock(NOW);
  await store
    .userGrants()
    .doc(OPERATOR_UID)
    .set({
      uid: OPERATOR_UID,
      therapyOrgId: THERAPY_ORG_ID,
      roles: ['integrationOperator'],
      facilityIds: [],
      disciplines: [],
      status: 'active',
      grantVersion: 1,
      updatedAt: clock.now(),
      updatedByUid: 'seed',
    });
}

async function seedAuthUser(): Promise<void> {
  const auth = getAuth();
  try {
    await auth.getUser(OPERATOR_UID);
  } catch {
    await auth.createUser({
      uid: OPERATOR_UID,
      email: 'ops@healthpro.demo',
      password: 'demo-password',
      displayName: 'Integration Operator',
    });
  }

  await auth.setCustomUserClaims(OPERATOR_UID, {
    therapyOrgId: THERAPY_ORG_ID,
    roles: ['integrationOperator'],
    grantVersion: 1,
  });
}

async function seedSyncData(store: SyncStore, pcc: FakePccApi): Promise<void> {
  const clock = fixedClock(NOW);
  const { sink } = createMemorySink();
  const logger = createLogger({ service: 'seed' }, sink);
  const audit = new AuditLog(store, clock, 'seed');

  const engine = new SyncEngine({ store, pcc, clock, logger, audit });
  const worker = new SyncWorker({ engine, store, audit, clock, logger });

  await engine.sync({
    therapyOrgId: THERAPY_ORG_ID,
    pccOrgUuid: FIXTURE_ORG_UUID,
    pccFacId: FIXTURE_FERNCREST_FAC_ID,
    pccPatientId: BETTY_PCC_PATIENT_ID,
    scope: 'all',
    source: 'webhook',
    causedByEventId: 'seed_betty',
  });

  const deadLetterTask: SyncTask = {
    taskId: 'tsk_seed_dlq',
    therapyOrgId: THERAPY_ORG_ID,
    pccOrgUuid: FIXTURE_ORG_UUID,
    pccFacId: FIXTURE_FERNCREST_FAC_ID,
    entityType: 'patient',
    scope: 'all',
    entityPccId: '9999',
    reason: 'webhook',
    causedByEventId: 'seed_dead_letter',
    attempt: 3,
    enqueuedAt: NOW,
  };

  pcc.failNextCalls(
    'getPatient',
    new PermanentSyncError('pcc_forbidden', 'Consent revoked for patient'),
  );

  await worker.process(deadLetterTask);

  const bettyPatientId = documentIds.patient(FIXTURE_ORG_UUID, BETTY_PCC_PATIENT_ID);
  const bettyPersonId = (await store.getPatient(bettyPatientId))?.personId;
  if (bettyPersonId === null || bettyPersonId === undefined) {
    throw new Error('Expected Betty to be linked to a person after seed sync');
  }

  const candidate: PersonMatchCandidate = {
    id: `${bettyPatientId}__per_demo_candidate`,
    therapyOrgId: THERAPY_ORG_ID,
    facilityId: FERNCREST_ID,
    patientId: bettyPatientId,
    candidatePersonId: bettyPersonId,
    score: 0.78,
    signals: {
      birthDateMatches: true,
      lastNameMatches: true,
      firstNameSimilarity: 0.62,
      medicalRecordNumberMatches: false,
      sharesFacility: true,
    },
    status: 'pending',
    decidedByUid: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: NOW,
  };

  await store.personMatchCandidates().doc(candidate.id).set(candidate);

  const cursor: SyncCursor = {
    id: store.cursorId(THERAPY_ORG_ID, FERNCREST_ID, 'coverage'),
    therapyOrgId: THERAPY_ORG_ID,
    facilityId: FERNCREST_ID,
    entityType: 'coverage',
    deltaCursor: '2026-09-24T12:00:00.000Z',
    lastDeltaRunAt: NOW,
    lastCensusRunAt: '2026-09-20T03:00:00.000Z',
    lastSuccessAt: NOW,
    consecutiveFailures: 0,
    status: 'healthy',
  };

  await store.syncCursors().doc(cursor.id).set(cursor);
}

async function main(): Promise<void> {
  requireEmulator();

  const projectId =
    process.env['GCLOUD_PROJECT'] ??
    process.env['GOOGLE_CLOUD_PROJECT'] ??
    'rehabalpha-pcc-sync-demo';

  initializeApp({ projectId });
  const store = new SyncStore(getFirestore());
  const pcc = new FakePccApi();

  await seedTenant(store);
  await seedOperatorGrant(store);
  await seedAuthUser();
  await seedSyncData(store, pcc);

  console.log('Seed complete for ops console demo.');
  console.log(`  therapy org: ${THERAPY_ORG_ID}`);
  console.log(`  operator: ops@healthpro.demo / demo-password`);
  console.log(`  Betty coverage: /patients/demo-betty/coverage`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
