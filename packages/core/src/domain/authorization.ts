import { z } from 'zod';
import { disciplineSchema, type Discipline } from './discipline.js';
import { isoDateTime } from '../schema-primitives.js';

export const roleSchema = z.enum([
  /** Full authority inside one therapy organisation. Cannot cross tenants. */
  'orgAdmin',
  /** Operational authority over the facilities named in the grant. */
  'facilityManager',
  /** Clinical access, limited to granted facilities and granted disciplines. */
  'therapist',
  /** Coverage, authorisation and stay data for billing. No clinical documentation. */
  'biller',
  /** Read-only across the tenant, including the audit log. Cannot mutate anything. */
  'auditor',
  /** Runs the integration: sync health, dead letters, identity review. Minimal PHI. */
  'integrationOperator',
]);
export type Role = z.infer<typeof roleSchema>;

export const permissionSchema = z.enum([
  'patient:read',
  'admission:read',
  'coverage:read',
  'clinical:read',
  'clinical:write',
  'syncHealth:read',
  'deadLetter:read',
  'deadLetter:replay',
  'identityReview:read',
  'identityReview:decide',
  'auditLog:read',
  'connection:manage',
  'grant:manage',
]);
export type Permission = z.infer<typeof permissionSchema>;

/**
 * Roles are expanded to permissions in one place so that the API layer, the operations
 * console and the Firestore rules cannot drift into disagreeing about what a role means.
 * The rules file necessarily re-states a subset of this in its own language; the rules test
 * suite asserts the two agree.
 *
 * Note what `integrationOperator` deliberately lacks: it can see that patient
 * `pat_…7f3a` failed to sync and replay the event, but it cannot read the chart. Fixing a
 * pipeline should not require access to the clinical record, and HIPAA's minimum-necessary
 * standard means the role that runs the pipeline should not have it.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  orgAdmin: [
    'patient:read',
    'admission:read',
    'coverage:read',
    'clinical:read',
    'clinical:write',
    'syncHealth:read',
    'deadLetter:read',
    'deadLetter:replay',
    'identityReview:read',
    'identityReview:decide',
    'auditLog:read',
    'connection:manage',
    'grant:manage',
  ],
  facilityManager: [
    'patient:read',
    'admission:read',
    'coverage:read',
    'clinical:read',
    'syncHealth:read',
    'identityReview:read',
    'identityReview:decide',
  ],
  therapist: ['patient:read', 'admission:read', 'coverage:read', 'clinical:read', 'clinical:write'],
  biller: ['patient:read', 'admission:read', 'coverage:read'],
  auditor: ['patient:read', 'admission:read', 'coverage:read', 'clinical:read', 'auditLog:read'],
  integrationOperator: [
    'syncHealth:read',
    'deadLetter:read',
    'deadLetter:replay',
    'identityReview:read',
    'connection:manage',
  ],
};

/**
 * Authorisation grant for one user.
 *
 * Held in Firestore rather than entirely in Firebase Auth custom claims because claims are
 * capped at roughly 1000 bytes once serialised, and a regional manager covering forty
 * facilities does not fit. The claim therefore carries only the tenant, the roles and a
 * `grantVersion`; the facility scope is read from this document. Firestore rules can `get()`
 * it, at the cost of one extra document read per rule evaluation — a cost worth paying to
 * avoid a scope model that silently breaks past a certain customer size.
 *
 * `grantVersion` exists to make revocation prompt. Custom claims live in the client's ID
 * token for up to an hour; bumping the version on every grant change lets both the rules and
 * the server reject a token minted against a stale grant instead of honouring it.
 */
export const userGrantSchema = z.object({
  uid: z.string().min(1),
  therapyOrgId: z.string().min(1),
  roles: z.array(roleSchema).min(1),
  /** Empty means "no facility access", never "all facilities". Deny by default. */
  facilityIds: z.array(z.string().min(1)),
  /** Relevant to therapists only; other roles ignore it. */
  disciplines: z.array(disciplineSchema),
  status: z.enum(['active', 'suspended']),
  grantVersion: z.number().int().positive(),
  updatedAt: isoDateTime,
  updatedByUid: z.string().min(1),
});
export type UserGrant = z.infer<typeof userGrantSchema>;

/** The subset of the grant mirrored into the Firebase ID token. Must stay small. */
export const authClaimsSchema = z.object({
  therapyOrgId: z.string().min(1),
  roles: z.array(roleSchema),
  grantVersion: z.number().int().positive(),
});
export type AuthClaims = z.infer<typeof authClaimsSchema>;

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const permissions = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      permissions.add(permission);
    }
  }
  return permissions;
}

export type AccessRequest = {
  permission: Permission;
  therapyOrgId: string;
  facilityId?: string;
  discipline?: Discipline;
};

export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The single server-side authorisation check. Every decision is explicit and every denial
 * carries a reason, because "why can this user not see this patient" is a support question
 * that gets asked weekly and should not require reading code to answer.
 */
export function authorize(grant: UserGrant, request: AccessRequest): AccessDecision {
  if (grant.status !== 'active') {
    return { allowed: false, reason: 'grant_suspended' };
  }

  if (grant.therapyOrgId !== request.therapyOrgId) {
    return { allowed: false, reason: 'tenant_mismatch' };
  }

  if (!permissionsFor(grant.roles).has(request.permission)) {
    return { allowed: false, reason: 'missing_permission' };
  }

  if (request.facilityId !== undefined) {
    const tenantWide = grant.roles.includes('orgAdmin') || grant.roles.includes('auditor');
    if (!tenantWide && !grant.facilityIds.includes(request.facilityId)) {
      return { allowed: false, reason: 'facility_out_of_scope' };
    }
  }

  if (request.discipline !== undefined && grant.roles.includes('therapist')) {
    const otherRoleCovers = grant.roles.some((role) => role !== 'therapist');
    if (!otherRoleCovers && !grant.disciplines.includes(request.discipline)) {
      return { allowed: false, reason: 'discipline_out_of_scope' };
    }
  }

  return { allowed: true };
}
