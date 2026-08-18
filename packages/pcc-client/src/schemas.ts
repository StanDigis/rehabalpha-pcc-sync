import { z } from 'zod';

/**
 * PointClickCare response shapes.
 *
 * Two deliberate choices run through this file.
 *
 * Unknown fields are dropped rather than rejected. Zod's default object behaviour strips keys
 * it does not know about, which is exactly what a client of a third-party API wants: PCC adding
 * a field to a patient payload must not break every sync. Fields we do read are validated, so a
 * field changing type still fails loudly.
 *
 * Almost everything except identifiers is optional. Partner integrations report that PCC omits
 * fields the facility has not filled in, and a therapy company cannot make Ferncrest's
 * admissions clerk complete a middle name. Requiring a field we do not strictly need converts
 * somebody else's data-entry gap into our outage.
 */

/** PCC exposes the upstream modification instant under this name. It is our watermark. */
const lastUpdate = z.string().min(1).nullish();

export const pccPatientSchema = z.object({
  patientId: z.union([z.string(), z.number()]).transform(String),
  facId: z.union([z.string(), z.number()]).transform(String).nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  middleName: z.string().nullish(),
  preferredName: z.string().nullish(),
  birthDate: z.string().nullish(),
  gender: z.string().nullish(),
  medicalRecordNumber: z.string().nullish(),
  patientStatus: z.string().nullish(),
  lastUpdateDatetime: lastUpdate,
});
export type PccPatient = z.infer<typeof pccPatientSchema>;

/**
 * ADT records are how PCC expresses the lifecycle of a stay: admission, discharge, internal
 * transfer, leave of absence and death all arrive here rather than as mutations of a single
 * admission object. Field names for the action differ between PCC surfaces, so both spellings
 * are accepted and normalised by the caller.
 */
export const pccAdtRecordSchema = z.object({
  adtRecordId: z.union([z.string(), z.number()]).transform(String),
  patientId: z.union([z.string(), z.number()]).transform(String),
  facId: z.union([z.string(), z.number()]).transform(String).nullish(),
  actionCode: z.string().nullish(),
  actionType: z.string().nullish(),
  effectiveDateTime: z.string().nullish(),
  admissionDate: z.string().nullish(),
  dischargeDate: z.string().nullish(),
  unitDescription: z.string().nullish(),
  roomDescription: z.string().nullish(),
  bedDescription: z.string().nullish(),
  lastUpdateDatetime: lastUpdate,
});
export type PccAdtRecord = z.infer<typeof pccAdtRecordSchema>;

/**
 * A payer on the patient's coverage tree.
 *
 * `payerRank` carries the billing order, and PCC also returns payers marked informational,
 * which must never be billed. Effective and expiration dates are the reason the local model is
 * bitemporal: coverage is a dated fact, not a current-value field.
 */
export const pccCoverageSchema = z.object({
  payerId: z.union([z.string(), z.number()]).transform(String),
  payerName: z.string().min(1),
  payerType: z.string().nullish(),
  payerRank: z.string().nullish(),
  planName: z.string().nullish(),
  effectiveDate: z.string().nullish(),
  expirationDate: z.string().nullish(),
  informationalOnly: z.boolean().nullish(),
  authorizationRequired: z.boolean().nullish(),
  authorizationNumber: z.string().nullish(),
  authorizationEffectiveDate: z.string().nullish(),
  authorizationExpirationDate: z.string().nullish(),
  approvedVisits: z.number().int().nonnegative().nullish(),
  lastUpdateDatetime: lastUpdate,
});
export type PccCoverage = z.infer<typeof pccCoverageSchema>;

export const pccFacilitySchema = z.object({
  facId: z.union([z.string(), z.number()]).transform(String),
  facilityName: z.string().min(1),
  timeZone: z.string().nullish(),
  stateCode: z.string().nullish(),
});
export type PccFacility = z.infer<typeof pccFacilitySchema>;

/**
 * Which organisations and facilities have switched this application on.
 *
 * This is the multi-tenant onboarding signal, and it is also the offboarding one. A facility
 * that deactivates the integration stops appearing here, which has to stop the sync for that
 * facility — continuing to pull would be accessing PHI without authorisation, whatever the
 * cached credential still permits technically.
 */
export const pccActivationSchema = z.object({
  orgUuid: z.string().min(1),
  facId: z.union([z.string(), z.number()]).transform(String).nullish(),
  activationStatus: z.string().nullish(),
  activatedDate: z.string().nullish(),
});
export type PccActivation = z.infer<typeof pccActivationSchema>;

/**
 * PCC's own cross-facility identity record. Preferred over any local matching: it is
 * authoritative within the organisation and it has evidence we do not have.
 */
export const pccMasterPatientSchema = z.object({
  organizationMasterPatientId: z.union([z.string(), z.number()]).transform(String),
  patients: z
    .array(
      z.object({
        patientId: z.union([z.string(), z.number()]).transform(String),
        facId: z.union([z.string(), z.number()]).transform(String).nullish(),
      }),
    )
    .default([]),
});
export type PccMasterPatient = z.infer<typeof pccMasterPatientSchema>;

export const pccPatientMatchResultSchema = z.object({
  matches: z
    .array(
      z.object({
        patientId: z.union([z.string(), z.number()]).transform(String),
        facId: z.union([z.string(), z.number()]).transform(String).nullish(),
        organizationMasterPatientId: z.union([z.string(), z.number()]).transform(String).nullish(),
      }),
    )
    .default([]),
});
export type PccPatientMatchResult = z.infer<typeof pccPatientMatchResultSchema>;

export const pccWebhookSubscriptionSchema = z.object({
  subscriptionId: z.union([z.string(), z.number()]).transform(String),
  eventTypes: z.array(z.string()).default([]),
  targetUrl: z.string().nullish(),
  status: z.string().nullish(),
});
export type PccWebhookSubscription = z.infer<typeof pccWebhookSubscriptionSchema>;

/**
 * Paged collection envelope.
 *
 * The paging metadata PCC returns is not identical across every collection, so the reader
 * below treats both conventions as advisory and relies on page size as the authoritative
 * stop condition. Being tolerant here is cheaper than a sync that silently reads only the
 * first page — the failure mode of getting this wrong is a partial census that looks
 * successful.
 */
export function pccPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item).default([]),
    paging: z
      .object({
        hasMore: z.boolean().nullish(),
        nextOffset: z.number().int().nonnegative().nullish(),
        total: z.number().int().nonnegative().nullish(),
      })
      .nullish(),
  });
}

/**
 * Inbound webhook notification.
 *
 * Modelled as a notification, not as a payload of record: it tells us which entity changed,
 * and the worker re-reads the current state from the API. Trusting the body would mean applying
 * whatever was true when the notification was generated, and PCC retries deliveries — so the
 * body is precisely the state most likely to be stale by the time we act on it.
 */
export const pccWebhookNotificationSchema = z.object({
  messageId: z.string().min(1),
  eventType: z.string().min(1),
  orgUuid: z.string().min(1),
  facId: z.union([z.string(), z.number()]).transform(String).nullish(),
  patientId: z.union([z.string(), z.number()]).transform(String).nullish(),
  adtRecordId: z.union([z.string(), z.number()]).transform(String).nullish(),
  eventDateTime: z.string().nullish(),
});
export type PccWebhookNotification = z.infer<typeof pccWebhookNotificationSchema>;
