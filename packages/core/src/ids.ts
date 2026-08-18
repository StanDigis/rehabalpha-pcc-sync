declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** RehabAlpha customer: the contract therapy company. Also the tenant boundary. */
export type TherapyOrgId = Brand<string, 'TherapyOrgId'>;
/** A skilled nursing facility, identified by RehabAlpha. */
export type FacilityId = Brand<string, 'FacilityId'>;
/** The human being, stable across facilities and admissions. */
export type PersonId = Brand<string, 'PersonId'>;
/** A PCC patient record as projected into RehabAlpha. */
export type PatientId = Brand<string, 'PatientId'>;
export type AdmissionId = Brand<string, 'AdmissionId'>;
export type CoverageId = Brand<string, 'CoverageId'>;
export type SyncEventId = Brand<string, 'SyncEventId'>;

export const asTherapyOrgId = (value: string): TherapyOrgId => value as TherapyOrgId;
export const asFacilityId = (value: string): FacilityId => value as FacilityId;
export const asPersonId = (value: string): PersonId => value as PersonId;
export const asPatientId = (value: string): PatientId => value as PatientId;
export const asAdmissionId = (value: string): AdmissionId => value as AdmissionId;
export const asCoverageId = (value: string): CoverageId => value as CoverageId;
export const asSyncEventId = (value: string): SyncEventId => value as SyncEventId;

const MAX_DOCUMENT_ID_BYTES = 1500;

/**
 * Firestore document ids may not contain `/`, may not be `.` or `..`, and may not match
 * `__.*__`. PCC identifiers are opaque strings that we do not control, so they are
 * percent-encoded before being used in an id. Encoding rather than hashing is deliberate:
 * ids stay legible in the console and in logs, which matters a great deal when someone is
 * debugging a stuck sync at 2am.
 */
export function encodeIdSegment(raw: string): string {
  if (raw.length === 0) {
    throw new RangeError('Identifier segment must not be empty');
  }

  const encoded = raw.replace(/[^A-Za-z0-9._~-]/g, (character) => {
    const bytes = new TextEncoder().encode(character);
    return Array.from(bytes, (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(
      '',
    );
  });

  if (encoded === '.' || encoded === '..') {
    throw new RangeError(`Identifier segment ${JSON.stringify(raw)} is reserved by Firestore`);
  }

  return encoded;
}

function buildId(prefix: string, ...segments: string[]): string {
  const id = [prefix, ...segments.map(encodeIdSegment)].join('_');

  if (new TextEncoder().encode(id).length > MAX_DOCUMENT_ID_BYTES) {
    throw new RangeError(
      `Derived document id exceeds Firestore's ${MAX_DOCUMENT_ID_BYTES}-byte limit`,
    );
  }

  return id;
}

/**
 * Every synchronised document derives its id from the upstream PCC identity, which makes
 * every write an idempotent `set` and every lookup a direct `get`. The alternative —
 * generated ids plus a `where('pccPatientId', '==', ...)` lookup — needs an index, costs a
 * query per event, and leaves a window where a retry creates a duplicate.
 *
 * The PCC organisation uuid is part of the id because PCC patient ids are only unique
 * within an organisation.
 */
export const documentIds = {
  patient: (pccOrgUuid: string, pccPatientId: string): PatientId =>
    buildId('pat', pccOrgUuid, pccPatientId) as PatientId,

  admission: (pccOrgUuid: string, pccAdmissionId: string): AdmissionId =>
    buildId('adm', pccOrgUuid, pccAdmissionId) as AdmissionId,

  /**
   * A person record created because no existing human matched.
   *
   * Derived from the patient projection that caused the creation, so retrying the same sync cannot
   * create a second person for the same human. A random id would make the identity step
   * non-idempotent, which is the one place it must not be: duplicate people are the failure this
   * whole subsystem exists to avoid.
   */
  person: (pccOrgUuid: string, pccPatientId: string): PersonId =>
    buildId('per', pccOrgUuid, pccPatientId) as PersonId,

  /**
   * Coverage has no stable upstream id in every PCC response, so it is keyed by the
   * tuple that PCC itself treats as identifying: the patient, the payer and the date the
   * coverage became effective. A payer re-added with a new effective date is a new
   * coverage row, which is exactly the behaviour billing needs.
   */
  coverage: (pccPatientId: string, pccPayerId: string, effectiveFrom: string): CoverageId =>
    buildId('cov', pccPatientId, pccPayerId, effectiveFrom) as CoverageId,

  facility: (pccOrgUuid: string, pccFacId: string): FacilityId =>
    buildId('fac', pccOrgUuid, pccFacId) as FacilityId,

  /** Webhook envelope id, used as the deduplication key for at-least-once delivery. */
  syncEvent: (pccMessageId: string): SyncEventId => buildId('evt', pccMessageId) as SyncEventId,
} as const;
