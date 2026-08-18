import { z } from 'zod';
import { disciplineSchema } from './discipline.js';
import { isoDate, isoDateTime } from '../schema-primitives.js';

/**
 * RehabAlpha's customer is the contract therapy company, not the facility. That inversion
 * is the single most important modelling consequence of the briefing: Ferncrest operates the
 * building and owns the PCC tenant, while HealthPRO staffs the therapists and uses
 * RehabAlpha. So the tenant boundary is the therapy company, and access to a facility's
 * PCC data is something the facility grants and can revoke.
 */
export const therapyOrgSchema = z.object({
  id: z.string().min(1),
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(['active', 'suspended']),
  createdAt: isoDateTime,
});
export type TherapyOrg = z.infer<typeof therapyOrgSchema>;

/**
 * A facility as seen by one therapy organisation.
 *
 * Deliberately tenant-scoped rather than global. Two therapy companies can both work inside
 * Ferncrest, each with its own PCC activation, its own contract terms and its own consent
 * state. A shared global facility record would either leak one tenant's connection state
 * into the other's view or need a second layer of per-tenant overlay documents. Duplicating
 * the handful of descriptive fields is the cheaper trade.
 */
export const facilitySchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  name: z.string().min(1),
  timeZone: z.string().min(1),
  pcc: z.object({
    /** PCC organisation uuid. PCC patient and facility ids are only unique within it. */
    orgUuid: z.string().min(1),
    facId: z.string().min(1),
  }),
  createdAt: isoDateTime,
});
export type Facility = z.infer<typeof facilitySchema>;

/**
 * The therapy company's right to work in a facility, scoped by discipline and by date.
 *
 * This drives authorisation, not just reporting. When a contract lapses, the therapists lose
 * access to that facility's patients and the sync stops pulling them, but the already
 * synchronised clinical and billing history must remain readable for the retention period.
 * That is why the contract is date-ranged instead of being deleted.
 */
export const facilityContractSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  facilityId: z.string().min(1),
  disciplines: z.array(disciplineSchema).min(1),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),
  status: z.enum(['active', 'expired', 'terminated']),
  createdAt: isoDateTime,
});
export type FacilityContract = z.infer<typeof facilityContractSchema>;

/**
 * How this tenant talks to PCC for a given organisation.
 *
 * PCC supports a system-to-system (two-legged) model and a user-delegated (three-legged)
 * model, and has been moving marketplace partners onto the latter. They have materially
 * different failure modes, and the integration has to survive both:
 *
 *   twoLegged    One app credential per organisation. Sync runs unattended. Simple, but the
 *                blast radius of a leaked credential is the whole organisation.
 *   threeLegged  Access is delegated by a named PCC user and is limited to what that user
 *                may see. Tokens can be revoked at any moment and refresh tokens expire, so
 *                the sync must degrade to "cannot pull, alert an operator" rather than fail
 *                silently, and it must never be the only path to data a therapist needs.
 *
 * Tokens themselves are never stored here. This document holds a reference to a Secret
 * Manager version; the ciphertext stays out of Firestore so that a Firestore read, a backup
 * export or an over-broad rule cannot leak a credential.
 */
export const pccConnectionSchema = z.object({
  id: z.string().min(1),
  therapyOrgId: z.string().min(1),
  pccOrgUuid: z.string().min(1),
  authMode: z.enum(['twoLegged', 'threeLegged']),
  /** Resource name of the Secret Manager version holding the credential or refresh token. */
  credentialSecretName: z.string().min(1),
  /** Facilities PCC reports as having activated this application. */
  activatedFacilityIds: z.array(z.string().min(1)),
  consent: z.object({
    status: z.enum(['granted', 'revoked', 'expired', 'pending']),
    /** Pseudonymised PCC user reference for three-legged grants. Never the username. */
    grantedBySubjectHash: z.string().nullable(),
    grantedAt: isoDateTime.nullable(),
    expiresAt: isoDateTime.nullable(),
  }),
  scopes: z.array(z.string().min(1)),
  status: z.enum(['healthy', 'degraded', 'disconnected']),
  lastVerifiedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type PccConnection = z.infer<typeof pccConnectionSchema>;

/** True when the contract permits work at the facility on the given calendar date. */
export function isContractActiveOn(contract: FacilityContract, date: string): boolean {
  if (contract.status === 'terminated') return false;
  if (date < contract.effectiveFrom) return false;
  return contract.effectiveTo === null || date <= contract.effectiveTo;
}
