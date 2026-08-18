/**
 * Every PointClickCare URL the integration knows about, in one file.
 *
 * The exact path prefix and the singular-versus-plural spelling of some collections are
 * published on the PointClickCare developer portal, which is behind partner registration.
 * Public partner listings confirm the collection names used below — `activations`,
 * `adt-records`, `coverages`, `facs`, `patients`, `patients/match`,
 * `organization-master-patient` and `webhook-subscriptions` — and the two-legged versus
 * three-legged authentication split. Centralising them means confirming the prefix against the
 * portal is a one-file change rather than a search-and-replace across the codebase, and it
 * keeps every caller from hand-assembling URLs with a patient id in them.
 *
 * `DEFAULT_PATH_PREFIX` is the value to verify first when standing this up against a real
 * sandbox tenant.
 */

export const DEFAULT_BASE_URL = 'https://connect.pointclickcare.com';
export const DEFAULT_PATH_PREFIX = '/api/public/preview1';
export const DEFAULT_TOKEN_URL = 'https://connect.pointclickcare.com/auth/token';
export const DEFAULT_AUTHORIZE_URL = 'https://connect.pointclickcare.com/auth/authorize';

/**
 * Path templates keep the raw identifier out of log lines and metric labels. A metric
 * cardinality explosion is the mundane consequence; a patient id in a dashboard label is the
 * one that matters.
 */
export const PCC_ROUTES = {
  activations: '/org/{orgUuid}/activations',
  facilities: '/org/{orgUuid}/facs',
  facility: '/org/{orgUuid}/facs/{facId}',
  patients: '/org/{orgUuid}/facs/{facId}/patients',
  patient: '/org/{orgUuid}/patients/{patientId}',
  patientMatch: '/org/{orgUuid}/patients/match',
  organizationMasterPatient: '/org/{orgUuid}/organization-master-patient',
  adtRecords: '/org/{orgUuid}/patients/{patientId}/adt-records',
  facilityAdtRecords: '/org/{orgUuid}/facs/{facId}/adt-records',
  coverages: '/org/{orgUuid}/patients/{patientId}/coverages',
  webhookSubscriptions: '/org/{orgUuid}/webhook-subscriptions',
} as const;

export type PccRouteName = keyof typeof PCC_ROUTES;

/**
 * Substitutes path parameters and percent-encodes each one.
 *
 * Encoding is not optional here: PCC identifiers are opaque, and an unencoded value
 * containing a slash would silently address a different resource. That is a path-traversal
 * bug with a patient chart at the end of it.
 */
export function buildPath(route: PccRouteName, params: Record<string, string> = {}): string {
  return PCC_ROUTES[route].replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined || value === '') {
      throw new Error(`Missing path parameter ${key} for PCC route ${route}`);
    }
    return encodeURIComponent(value);
  });
}
