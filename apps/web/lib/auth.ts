import {
  authorize,
  authClaimsSchema,
  fixedClock,
  permissionsFor,
  type Permission,
  type Role,
  type UserGrant,
} from '@rehabalpha/core';
import { cookies } from 'next/headers';
import { DEFAULT_THERAPY_ORG_ID, isEmulator } from './config';
import { getAdminAuth } from './firebase-admin';
import { getStore } from './store';

export type SessionUser = {
  uid: string;
  therapyOrgId: string;
  roles: Role[];
  grantVersion: number;
  email: string | null;
};

export type Session = {
  user: SessionUser;
  grant: UserGrant;
};

const SESSION_COOKIE = '__session';

export async function getSession(): Promise<Session | null> {
  if (process.env['OPS_CONSOLE_DEV_BYPASS'] === '1' && isEmulator) {
    return devBypassSession();
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token === '') return null;

  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    const claims = authClaimsSchema.safeParse(decoded);
    if (!claims.success) return null;

    const grantSnapshot = await getStore().userGrants().doc(decoded.uid).get();
    if (!grantSnapshot.exists) return null;

    const grant = grantSnapshot.data();
    if (grant === undefined || grant.status !== 'active') return null;
    if (grant.grantVersion !== claims.data.grantVersion) return null;

    return {
      user: {
        uid: decoded.uid,
        therapyOrgId: claims.data.therapyOrgId,
        roles: claims.data.roles,
        grantVersion: claims.data.grantVersion,
        email: decoded.email ?? null,
      },
      grant,
    };
  } catch {
    return null;
  }
}

async function devBypassSession(): Promise<Session> {
  const store = getStore();
  const uid = 'ops_operator';
  const grantSnapshot = await store.userGrants().doc(uid).get();
  const grant = grantSnapshot.data();

  if (grant !== undefined && grant.status === 'active') {
    return {
      user: {
        uid,
        therapyOrgId: grant.therapyOrgId,
        roles: grant.roles,
        grantVersion: grant.grantVersion,
        email: 'ops@healthpro.demo',
      },
      grant,
    };
  }

  return {
    user: {
      uid,
      therapyOrgId: DEFAULT_THERAPY_ORG_ID,
      roles: ['integrationOperator'],
      grantVersion: 1,
      email: 'ops@healthpro.demo',
    },
    grant: {
      uid,
      therapyOrgId: DEFAULT_THERAPY_ORG_ID,
      roles: ['integrationOperator'],
      facilityIds: [],
      disciplines: [],
      status: 'active',
      grantVersion: 1,
      updatedAt: fixedClock('2026-09-25T15:00:00.000Z').now(),
      updatedByUid: 'seed',
    },
  };
}

export function sessionHasPermission(session: Session, permission: Permission): boolean {
  return permissionsFor(session.grant.roles).has(permission);
}

export function requirePermission(session: Session, permission: Permission): void {
  const decision = authorize(session.grant, {
    permission,
    therapyOrgId: session.user.therapyOrgId,
  });

  if (!decision.allowed) {
    throw new Error(`forbidden:${decision.reason}`);
  }
}

export { SESSION_COOKIE };
