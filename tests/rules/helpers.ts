import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));

export const ORG_A = 'org_northstar';
export const ORG_B = 'org_meridian';
export const FERNCREST = 'fac_ferncrest';
export const LAKESIDE = 'fac_lakeside';

export type Role =
  'orgAdmin' | 'facilityManager' | 'therapist' | 'biller' | 'auditor' | 'integrationOperator';

export async function createTestEnvironment(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: 'rehabalpha-rules-test',
    firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
  });
}

export type SeedUser = {
  uid: string;
  therapyOrgId: string;
  roles: Role[];
  facilityIds: string[];
  status?: 'active' | 'suspended';
  grantVersion?: number;
};

/**
 * Writes the grant document and returns a client authenticated with the matching claims.
 *
 * The grant and the token are created together on purpose: the rules require them to agree, and a
 * helper that let a test set one without the other would make it easy to write a passing test
 * against a state that cannot occur — or, worse, to miss that the agreement is being enforced.
 */
export async function asUser(env: RulesTestEnvironment, user: SeedUser) {
  const grantVersion = user.grantVersion ?? 1;

  await env.withSecurityRulesDisabled(async (context) => {
    await context
      .firestore()
      .collection('userGrants')
      .doc(user.uid)
      .set({
        uid: user.uid,
        therapyOrgId: user.therapyOrgId,
        roles: user.roles,
        facilityIds: user.facilityIds,
        disciplines: ['pt'],
        status: user.status ?? 'active',
        grantVersion,
        updatedAt: '2026-03-01T00:00:00.000Z',
        updatedByUid: 'uid_seed',
      });
  });

  return env
    .authenticatedContext(user.uid, {
      therapyOrgId: user.therapyOrgId,
      roles: user.roles,
      grantVersion,
    })
    .firestore();
}

/** A token whose claims disagree with the stored grant, as happens after a revocation. */
export function withStaleToken(
  env: RulesTestEnvironment,
  user: SeedUser & { tokenGrantVersion: number },
) {
  return env
    .authenticatedContext(user.uid, {
      therapyOrgId: user.therapyOrgId,
      roles: user.roles,
      grantVersion: user.tokenGrantVersion,
    })
    .firestore();
}

export async function seed(
  env: RulesTestEnvironment,
  documents: readonly { path: string; data: Record<string, unknown> }[],
): Promise<void> {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const document of documents) {
      await db.doc(document.path).set(document.data);
    }
  });
}

export function patientDoc(
  overrides: { id?: string; therapyOrgId?: string; facilityId?: string; personId?: string } = {},
) {
  const id = overrides.id ?? 'pat_betty';
  return {
    path: `patients/${id}`,
    data: {
      id,
      therapyOrgId: overrides.therapyOrgId ?? ORG_A,
      facilityId: overrides.facilityId ?? FERNCREST,
      personId: overrides.personId ?? null,
      personLink: null,
      pcc: {
        orgUuid: 'org-uuid-1',
        facId: '7',
        patientId: '1001',
        patientStatus: { value: 'CURRENT', raw: 'Current' },
      },
      demographics: {
        firstName: 'Betty',
        lastName: 'Alvarez',
        middleName: null,
        preferredName: null,
        birthDate: '1941-06-12',
        administrativeSex: { value: 'FEMALE', raw: 'Female' },
        medicalRecordNumber: 'MRN-77',
      },
      currentAdmissionId: null,
      sync: syncMetadata(),
    },
  };
}

export function syncMetadata() {
  return {
    source: 'webhook',
    pccLastModified: '2026-03-14T13:30:00.000Z',
    syncedAt: '2026-03-15T12:00:00.000Z',
    syncVersion: 1,
    causedByEventId: null,
    contentHash: 'hash-1',
  };
}
