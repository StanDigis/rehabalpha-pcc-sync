import { PermanentSyncError, type Logger } from '@rehabalpha/core';
import {
  pccActivationSchema,
  pccAdtRecordSchema,
  pccCoverageSchema,
  pccFacilitySchema,
  pccMasterPatientSchema,
  pccPageSchema,
  pccPatientMatchResultSchema,
  pccPatientSchema,
  pccWebhookSubscriptionSchema,
  type PccActivation,
  type PccAdtRecord,
  type PccCoverage,
  type PccFacility,
  type PccMasterPatient,
  type PccPatient,
  type PccPatientMatchResult,
  type PccWebhookSubscription,
} from './schemas.js';
import type { PccRequest, PccTransport } from './transport.js';

export type ListPatientsOptions = {
  /** Delta pulls ask only for what changed, which is what keeps a nightly sweep affordable. */
  modifiedSince?: string;
  pageSize?: number;
};

export type PatientMatchCriteria = {
  firstName: string;
  lastName: string;
  birthDate: string | null;
  facId?: string;
};

export type CreateWebhookSubscriptionInput = {
  eventTypes: readonly string[];
  targetUrl: string;
};

/**
 * The PCC surface this integration depends on.
 *
 * Declared as an interface so the sync engine can be exercised against recorded fixtures with
 * no network, and so a partner-specific quirk stays behind one seam. It is intentionally narrow:
 * every endpoint here is one the synchronisation of patients, admissions and coverage actually
 * needs, and nothing more. Requesting scopes or reading collections beyond that would fail the
 * minimum-necessary standard, and a narrow surface is also what makes the request for partner
 * scopes easy to justify.
 */
export interface PccApi {
  listActivations(orgUuid: string): Promise<PccActivation[]>;
  listFacilities(orgUuid: string): Promise<PccFacility[]>;
  getPatient(orgUuid: string, patientId: string): Promise<PccPatient>;
  listPatients(
    orgUuid: string,
    facId: string,
    options?: ListPatientsOptions,
  ): AsyncIterable<PccPatient>;
  matchPatient(orgUuid: string, criteria: PatientMatchCriteria): Promise<PccPatientMatchResult>;
  getOrganizationMasterPatient(
    orgUuid: string,
    patientId: string,
  ): Promise<PccMasterPatient | null>;
  listAdtRecords(orgUuid: string, patientId: string): Promise<PccAdtRecord[]>;
  listFacilityAdtRecords(
    orgUuid: string,
    facId: string,
    options?: ListPatientsOptions,
  ): AsyncIterable<PccAdtRecord>;
  listCoverages(orgUuid: string, patientId: string): Promise<PccCoverage[]>;
  listWebhookSubscriptions(orgUuid: string): Promise<PccWebhookSubscription[]>;
  createWebhookSubscription(
    orgUuid: string,
    input: CreateWebhookSubscriptionInput,
  ): Promise<PccWebhookSubscription>;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Guard against an unbounded read.
 *
 * If the paging contract is misread — an endpoint that ignores `offset`, say — the loop below
 * would otherwise walk the same page forever, quietly burning the organisation's rate budget.
 * Failing loudly at a generous ceiling turns that into an alert instead of an incident.
 */
const MAX_PAGES = 500;

export class PccClient implements PccApi {
  constructor(
    private readonly transport: PccTransport,
    private readonly logger: Logger,
  ) {}

  async listActivations(orgUuid: string): Promise<PccActivation[]> {
    const page = await this.transport.request(
      { route: 'activations', params: { orgUuid } },
      pccPageSchema(pccActivationSchema),
    );
    return page.data;
  }

  async listFacilities(orgUuid: string): Promise<PccFacility[]> {
    const page = await this.transport.request(
      { route: 'facilities', params: { orgUuid } },
      pccPageSchema(pccFacilitySchema),
    );
    return page.data;
  }

  async getPatient(orgUuid: string, patientId: string): Promise<PccPatient> {
    return this.transport.request(
      { route: 'patient', params: { orgUuid, patientId } },
      pccPatientSchema,
    );
  }

  listPatients(
    orgUuid: string,
    facId: string,
    options: ListPatientsOptions = {},
  ): AsyncIterable<PccPatient> {
    return this.paginate(
      { route: 'patients', params: { orgUuid, facId } },
      pccPatientSchema,
      options,
    );
  }

  async matchPatient(
    orgUuid: string,
    criteria: PatientMatchCriteria,
  ): Promise<PccPatientMatchResult> {
    return this.transport.request(
      {
        route: 'patientMatch',
        params: { orgUuid },
        method: 'POST',
        body: {
          firstName: criteria.firstName,
          lastName: criteria.lastName,
          birthDate: criteria.birthDate,
          ...(criteria.facId !== undefined ? { facId: criteria.facId } : {}),
        },
      },
      pccPatientMatchResultSchema,
    );
  }

  /**
   * PCC's cross-facility identity record for a patient.
   *
   * A 404 here is an ordinary answer, not a failure: plenty of patients have only ever been
   * seen at one facility and have no master record. Returning null keeps the identity policy
   * free of exception handling for a normal case.
   */
  async getOrganizationMasterPatient(
    orgUuid: string,
    patientId: string,
  ): Promise<PccMasterPatient | null> {
    try {
      return await this.transport.request(
        { route: 'organizationMasterPatient', params: { orgUuid }, query: { patientId } },
        pccMasterPatientSchema,
      );
    } catch (error) {
      if (error instanceof PermanentSyncError && error.code === 'pcc_not_found') {
        return null;
      }
      throw error;
    }
  }

  async listAdtRecords(orgUuid: string, patientId: string): Promise<PccAdtRecord[]> {
    const page = await this.transport.request(
      { route: 'adtRecords', params: { orgUuid, patientId } },
      pccPageSchema(pccAdtRecordSchema),
    );
    return page.data;
  }

  listFacilityAdtRecords(
    orgUuid: string,
    facId: string,
    options: ListPatientsOptions = {},
  ): AsyncIterable<PccAdtRecord> {
    return this.paginate(
      { route: 'facilityAdtRecords', params: { orgUuid, facId } },
      pccAdtRecordSchema,
      options,
    );
  }

  async listCoverages(orgUuid: string, patientId: string): Promise<PccCoverage[]> {
    const page = await this.transport.request(
      { route: 'coverages', params: { orgUuid, patientId } },
      pccPageSchema(pccCoverageSchema),
    );
    return page.data;
  }

  async listWebhookSubscriptions(orgUuid: string): Promise<PccWebhookSubscription[]> {
    const page = await this.transport.request(
      { route: 'webhookSubscriptions', params: { orgUuid } },
      pccPageSchema(pccWebhookSubscriptionSchema),
    );
    return page.data;
  }

  async createWebhookSubscription(
    orgUuid: string,
    input: CreateWebhookSubscriptionInput,
  ): Promise<PccWebhookSubscription> {
    return this.transport.request(
      {
        route: 'webhookSubscriptions',
        params: { orgUuid },
        method: 'POST',
        body: { eventTypes: [...input.eventTypes], targetUrl: input.targetUrl },
      },
      pccWebhookSubscriptionSchema,
    );
  }

  /**
   * Offset pagination exposed as an async iterable.
   *
   * Streaming rather than accumulating: a facility census is thousands of patients, and holding
   * all of them in memory to then loop over them is both wasteful and the reason batch jobs get
   * OOM-killed halfway through. The consumer decides its own batching.
   *
   * The stop condition is a short page, with an explicit `hasMore: false` honoured when present.
   * Relying on paging metadata alone would be fragile across PCC collections that report it
   * differently, and reading only the first page of a census is a failure that looks like
   * success.
   */
  private async *paginate<T extends { lastUpdateDatetime?: string | null | undefined }>(
    request: PccRequest,
    itemSchema: Parameters<typeof pccPageSchema>[0],
    options: ListPatientsOptions,
  ): AsyncIterable<T> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    let offset = 0;

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.transport.request(
        {
          ...request,
          query: {
            ...request.query,
            'page[limit]': pageSize,
            'page[offset]': offset,
            ...(options.modifiedSince !== undefined
              ? { modifiedSince: options.modifiedSince }
              : {}),
          },
        },
        pccPageSchema(itemSchema),
      );

      for (const item of page.data) {
        yield item as T;
      }

      const explicitlyDone = page.paging?.hasMore === false;
      if (explicitlyDone || page.data.length < pageSize) {
        return;
      }

      offset += page.data.length;
    }

    this.logger.error('PCC pagination exceeded its page ceiling', {
      route: request.route,
      maxPages: MAX_PAGES,
    });
    throw new PermanentSyncError(
      'pcc_pagination_runaway',
      `Pagination for ${request.route} exceeded ${MAX_PAGES} pages`,
    );
  }
}
