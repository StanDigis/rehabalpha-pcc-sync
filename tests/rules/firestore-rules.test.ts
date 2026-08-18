import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  createTestEnvironment,
  FERNCREST,
  LAKESIDE,
  ORG_A,
  ORG_B,
  patientDoc,
  seed,
  syncMetadata,
  withStaleToken,
} from './helpers.js';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment();
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

const therapistAtFerncrest = {
  uid: 'uid_therapist',
  therapyOrgId: ORG_A,
  roles: ['therapist' as const],
  facilityIds: [FERNCREST],
};

const orgAdmin = {
  uid: 'uid_admin',
  therapyOrgId: ORG_A,
  roles: ['orgAdmin' as const],
  facilityIds: [],
};

const operator = {
  uid: 'uid_operator',
  therapyOrgId: ORG_A,
  roles: ['integrationOperator' as const],
  facilityIds: [FERNCREST],
};

describe('unauthenticated access', () => {
  it('is denied everywhere', async () => {
    await seed(env, [patientDoc()]);
    const db = env.unauthenticatedContext().firestore();

    await assertFails(db.doc('patients/pat_betty').get());
    await assertFails(db.doc('therapyOrgs/org_northstar').get());
    await assertFails(db.collection('syncDeadLetters').get());
  });
});

describe('tenant isolation', () => {
  it('lets a therapist read a patient at their own facility', async () => {
    await seed(env, [patientDoc()]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertSucceeds(db.doc('patients/pat_betty').get());
  });

  /**
   * The failure that matters most in a multi-tenant EMR. Two therapy companies can serve the same
   * building, and a leak across that boundary is a reportable breach rather than a bug.
   */
  it('denies a read of another tenant’s patient even at a facility name the caller knows', async () => {
    await seed(env, [patientDoc({ id: 'pat_other', therapyOrgId: ORG_B, facilityId: FERNCREST })]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertFails(db.doc('patients/pat_other').get());
  });

  it('denies a query that omits the tenant filter', async () => {
    await seed(env, [patientDoc()]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertFails(db.collection('patients').get());
  });

  it('allows a query that is scoped to the caller’s tenant and facility', async () => {
    await seed(env, [patientDoc()]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertSucceeds(
      db
        .collection('patients')
        .where('therapyOrgId', '==', ORG_A)
        .where('facilityId', '==', FERNCREST)
        .get(),
    );
  });
});

describe('facility scope', () => {
  it('denies a patient at a facility outside the caller’s grant', async () => {
    await seed(env, [patientDoc({ id: 'pat_harold', facilityId: LAKESIDE })]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertFails(db.doc('patients/pat_harold').get());
  });

  it('allows a facility manager covering both facilities', async () => {
    await seed(env, [patientDoc({ id: 'pat_harold', facilityId: LAKESIDE })]);
    const db = await asUser(env, {
      uid: 'uid_manager',
      therapyOrgId: ORG_A,
      roles: ['facilityManager'],
      facilityIds: [FERNCREST, LAKESIDE],
    });

    await assertSucceeds(db.doc('patients/pat_harold').get());
  });

  it('gives an org admin the whole tenant without listing facilities', async () => {
    await seed(env, [patientDoc({ id: 'pat_harold', facilityId: LAKESIDE })]);
    const db = await asUser(env, orgAdmin);

    await assertSucceeds(db.doc('patients/pat_harold').get());
  });

  /**
   * An empty facility list means no access, not universal access. Defaulting the other way is the
   * mistake that turns a half-configured grant into tenant-wide exposure.
   */
  it('treats an empty facility list as no access', async () => {
    await seed(env, [patientDoc()]);
    const db = await asUser(env, {
      uid: 'uid_new_therapist',
      therapyOrgId: ORG_A,
      roles: ['therapist'],
      facilityIds: [],
    });

    await assertFails(db.doc('patients/pat_betty').get());
  });
});

describe('roles and permissions', () => {
  /**
   * The role that runs the pipeline must not be able to read the chart. Repairing a sync failure
   * does not require the clinical record, and under the minimum-necessary standard it should not
   * come with it.
   */
  it('lets an integration operator see the failure but not the patient', async () => {
    await seed(env, [
      patientDoc(),
      {
        path: 'syncDeadLetters/dl_1',
        data: {
          id: 'dl_1',
          therapyOrgId: ORG_A,
          facilityId: FERNCREST,
          entityType: 'coverage',
          entityPccId: '1001',
          task: {
            taskId: 'evt_1',
            therapyOrgId: ORG_A,
            pccOrgUuid: 'org-uuid-1',
            pccFacId: '7',
            entityType: 'coverage',
            scope: 'coverage',
            entityPccId: '1001',
            reason: 'webhook',
            causedByEventId: 'evt_1',
            attempt: 6,
            enqueuedAt: '2026-03-15T12:00:00.000Z',
          },
          failure: {
            kind: 'permanent',
            code: 'pcc_required_field_missing',
            message: 'PCC coverage is missing the required field payerName',
            attempts: 6,
            firstFailedAt: '2026-03-15T12:00:00.000Z',
            lastFailedAt: '2026-03-15T12:30:00.000Z',
          },
          status: 'open',
          resolution: null,
        },
      },
    ]);

    const db = await asUser(env, operator);

    await assertSucceeds(db.doc('syncDeadLetters/dl_1').get());
    await assertFails(db.doc('patients/pat_betty').get());
  });

  it('denies a therapist the dead-letter queue', async () => {
    await seed(env, [
      { path: 'syncDeadLetters/dl_1', data: { id: 'dl_1', therapyOrgId: ORG_A, status: 'open' } },
    ]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertFails(db.doc('syncDeadLetters/dl_1').get());
  });

  it('denies a biller the audit log and allows an auditor', async () => {
    await seed(env, [
      {
        path: 'auditEvents/ae_1',
        data: { id: 'ae_1', therapyOrgId: ORG_A, at: '2026-03-15T12:00:00.000Z' },
      },
    ]);

    const biller = await asUser(env, {
      uid: 'uid_biller',
      therapyOrgId: ORG_A,
      roles: ['biller'],
      facilityIds: [FERNCREST],
    });
    const auditor = await asUser(env, {
      uid: 'uid_auditor',
      therapyOrgId: ORG_A,
      roles: ['auditor'],
      facilityIds: [],
    });

    await assertFails(biller.doc('auditEvents/ae_1').get());
    await assertSucceeds(auditor.doc('auditEvents/ae_1').get());
  });

  it('gives an auditor tenant-wide read without a facility list', async () => {
    await seed(env, [patientDoc({ id: 'pat_harold', facilityId: LAKESIDE })]);
    const db = await asUser(env, {
      uid: 'uid_auditor',
      therapyOrgId: ORG_A,
      roles: ['auditor'],
      facilityIds: [],
    });

    await assertSucceeds(db.doc('patients/pat_harold').get());
  });
});

describe('cross-facility person records', () => {
  const person = (facilityIds: string[]) => ({
    path: 'persons/per_betty',
    data: {
      id: 'per_betty',
      therapyOrgId: ORG_A,
      facilityIds,
      demographics: {
        firstName: 'Betty',
        lastName: 'Alvarez',
        middleName: null,
        preferredName: null,
        birthDate: '1941-06-12',
        administrativeSex: { value: 'FEMALE', raw: 'Female' },
        medicalRecordNumber: null,
      },
      mergedIntoPersonId: null,
      createdAt: '2026-01-05T00:00:00.000Z',
    },
  });

  /**
   * A therapist at Lakeside seeing that a resident was previously treated at Ferncrest is the point
   * of having a person record at all — the prior therapy history is what they need on readmission.
   */
  it('allows a person the caller shares at least one facility with', async () => {
    await seed(env, [person([FERNCREST, LAKESIDE])]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertSucceeds(db.doc('persons/per_betty').get());
  });

  it('denies a person the caller shares no facility with', async () => {
    await seed(env, [person([LAKESIDE])]);
    const db = await asUser(env, therapistAtFerncrest);

    await assertFails(db.doc('persons/per_betty').get());
  });
});

describe('grant lifecycle', () => {
  /**
   * A Firebase ID token keeps its custom claims for up to an hour. Without comparing the grant
   * version, revoking access would not take effect until the token expired — an hour during which a
   * dismissed employee still reads charts.
   */
  it('rejects a token minted against a superseded grant', async () => {
    await seed(env, [patientDoc()]);
    await asUser(env, { ...therapistAtFerncrest, grantVersion: 2 });

    const stale = withStaleToken(env, { ...therapistAtFerncrest, tokenGrantVersion: 1 });

    await assertFails(stale.doc('patients/pat_betty').get());
  });

  it('denies a suspended grant', async () => {
    await seed(env, [patientDoc()]);
    const db = await asUser(env, { ...therapistAtFerncrest, status: 'suspended' });

    await assertFails(db.doc('patients/pat_betty').get());
  });

  it('denies a signed-in user with no grant document at all', async () => {
    await seed(env, [patientDoc()]);
    const db = env
      .authenticatedContext('uid_ghost', {
        therapyOrgId: ORG_A,
        roles: ['orgAdmin'],
        grantVersion: 1,
      })
      .firestore();

    await assertFails(db.doc('patients/pat_betty').get());
  });

  it('lets a user read their own grant and nobody else’s', async () => {
    const db = await asUser(env, therapistAtFerncrest);
    await asUser(env, orgAdmin);

    await assertSucceeds(db.doc('userGrants/uid_therapist').get());
    await assertFails(db.doc('userGrants/uid_admin').get());
  });
});

describe('write protection', () => {
  /**
   * No client writes anything, at any role. Every document here is either a projection of PCC state
   * or a record the integration produced, and both are written by the Admin SDK. Operator actions
   * that mutate state go through audited server endpoints.
   */
  it.each([
    ['patients/pat_betty', { therapyOrgId: ORG_A, facilityId: FERNCREST }],
    ['admissions/adm_1', { therapyOrgId: ORG_A, facilityId: FERNCREST }],
    ['coverages/cov_1', { therapyOrgId: ORG_A, facilityId: FERNCREST }],
    ['persons/per_betty', { therapyOrgId: ORG_A, facilityIds: [FERNCREST] }],
    ['auditEvents/ae_forged', { therapyOrgId: ORG_A }],
    ['syncDeadLetters/dl_1', { therapyOrgId: ORG_A, status: 'resolved' }],
    ['userGrants/uid_therapist', { therapyOrgId: ORG_A, roles: ['orgAdmin'] }],
  ])('denies an org admin writing %s', async (path, data) => {
    const db = await asUser(env, orgAdmin);

    await assertFails(db.doc(path).set(data));
  });

  it('denies an update to an existing patient', async () => {
    await seed(env, [patientDoc()]);
    const db = await asUser(env, orgAdmin);

    await assertFails(db.doc('patients/pat_betty').update({ 'demographics.lastName': 'Forged' }));
  });

  it('denies a delete of a coverage row', async () => {
    await seed(env, [
      {
        path: 'coverages/cov_1',
        data: { id: 'cov_1', therapyOrgId: ORG_A, facilityId: FERNCREST, sync: syncMetadata() },
      },
    ]);
    const db = await asUser(env, orgAdmin);

    await assertFails(db.doc('coverages/cov_1').delete());
  });
});

describe('credential material', () => {
  /**
   * There is no client use for a connection document that justifies putting Secret Manager
   * references and OAuth state within reach of a stolen token. The console reads connection status
   * through a server endpoint that returns only what the screen needs.
   */
  it('is unreadable even by an org admin', async () => {
    await seed(env, [
      {
        path: 'pccConnections/conn_1',
        data: {
          id: 'conn_1',
          therapyOrgId: ORG_A,
          pccOrgUuid: 'org-uuid-1',
          refreshTokenSecretName: 'projects/x/secrets/pcc-refresh/versions/3',
        },
      },
    ]);
    const db = await asUser(env, orgAdmin);

    await assertFails(db.doc('pccConnections/conn_1').get());
  });
});

describe('collections not named in the rules', () => {
  it('are denied, so a new collection has to be granted access deliberately', async () => {
    await seed(env, [
      { path: 'clinicalNotes/note_1', data: { therapyOrgId: ORG_A, facilityId: FERNCREST } },
    ]);
    const db = await asUser(env, orgAdmin);

    await assertFails(db.doc('clinicalNotes/note_1').get());
    await assertFails(db.doc('clinicalNotes/note_2').set({ therapyOrgId: ORG_A }));
  });
});

describe('agreement with the server-side model', () => {
  /**
   * The rules restate a subset of ROLE_PERMISSIONS in a different language. A silent divergence
   * between the two is a confidentiality bug, not a broken feature, so the expectation is pinned
   * here: if a role gains or loses `patient:read` in core, this fails until the rules follow.
   */
  it('matches ROLE_PERMISSIONS on who may read a patient', async () => {
    const { ROLE_PERMISSIONS } = await import('@rehabalpha/core');
    const rolesWithPatientRead = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes('patient:read'))
      .map(([role]) => role)
      .sort();

    expect(rolesWithPatientRead).toEqual([
      'auditor',
      'biller',
      'facilityManager',
      'orgAdmin',
      'therapist',
    ]);

    await seed(env, [patientDoc()]);

    for (const role of ['therapist', 'biller', 'facilityManager'] as const) {
      const db = await asUser(env, {
        uid: `uid_${role}`,
        therapyOrgId: ORG_A,
        roles: [role],
        facilityIds: [FERNCREST],
      });
      await assertSucceeds(db.doc('patients/pat_betty').get());
    }

    const operatorDb = await asUser(env, operator);
    await assertFails(operatorDb.doc('patients/pat_betty').get());
  });
});
