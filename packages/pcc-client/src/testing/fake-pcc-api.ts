import { PermanentSyncError } from '@rehabalpha/core';
import type {
  CreateWebhookSubscriptionInput,
  ListPatientsOptions,
  PatientMatchCriteria,
  PccApi,
} from '../pcc-client.js';
import type {
  PccActivation,
  PccAdtRecord,
  PccCoverage,
  PccFacility,
  PccMasterPatient,
  PccPatient,
  PccPatientMatchResult,
  PccWebhookSubscription,
} from '../schemas.js';
import { createFixtureData, type PccFixtureData } from './fixtures.js';

export type FakeCall = { method: string; detail: Record<string, string | undefined> };

/**
 * An in-memory PointClickCare, good enough to drive the whole sync engine.
 *
 * This exists so the interesting tests can be written at all. The behaviour worth testing —
 * a duplicate webhook, a coverage that disappears upstream, a 429 mid-sweep, the same human
 * appearing at a second facility — is behaviour of the *upstream*, and it cannot be provoked
 * against a real sandbox on demand. Making PCC programmable moves those cases from "we reasoned
 * about it" to "there is a failing test if we break it".
 *
 * It also records every call, which is how the tests assert on request volume. A sync that
 * fetches coverage once per patient in a loop is functionally correct and operationally
 * unacceptable against an API that reserves the right to throttle us; the assertion has to be on
 * the call count, not on the result.
 */
export class FakePccApi implements PccApi {
  readonly calls: FakeCall[] = [];

  private readonly failures = new Map<string, { error: Error; remaining: number }>();

  constructor(readonly data: PccFixtureData = createFixtureData()) {}

  /** Makes the next `times` calls to `method` fail, so retry and dead-letter paths are testable. */
  failNextCalls(method: keyof PccApi, error: Error, times = 1): void {
    this.failures.set(method, { error, remaining: times });
  }

  private record(method: string, detail: Record<string, string | undefined> = {}): void {
    this.calls.push({ method, detail });

    const failure = this.failures.get(method);
    if (failure === undefined) return;

    if (failure.remaining <= 1) {
      this.failures.delete(method);
    } else {
      failure.remaining -= 1;
    }
    throw failure.error;
  }

  callCount(method: keyof PccApi): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  /**
   * Restores the fixture data, the call log and any programmed failures.
   *
   * A test that patches a patient or withdraws a coverage has mutated shared state, and without this
   * the next test inherits it — the failure mode where a suite passes one test at a time and fails as
   * a run, or worse, passes in the order it was written and breaks when a test is inserted above.
   */
  reset(): void {
    Object.assign(this.data, createFixtureData());
    this.calls.length = 0;
    this.failures.clear();
  }

  async listActivations(orgUuid: string): Promise<PccActivation[]> {
    this.record('listActivations', { orgUuid });
    return this.data.activations.filter((activation) => activation.orgUuid === orgUuid);
  }

  async listFacilities(orgUuid: string): Promise<PccFacility[]> {
    this.record('listFacilities', { orgUuid });
    return this.data.facilities;
  }

  async getPatient(orgUuid: string, patientId: string): Promise<PccPatient> {
    this.record('getPatient', { orgUuid, patientId });
    const patient = this.data.patients.find((candidate) => candidate.patientId === patientId);
    if (patient === undefined) {
      throw new PermanentSyncError('pcc_not_found', `No fixture patient ${patientId}`);
    }
    return patient;
  }

  async *listPatients(
    orgUuid: string,
    facId: string,
    options: ListPatientsOptions = {},
  ): AsyncIterable<PccPatient> {
    this.record('listPatients', { orgUuid, facId, modifiedSince: options.modifiedSince });

    for (const patient of this.data.patients) {
      if (patient.facId !== facId) continue;
      if (
        options.modifiedSince !== undefined &&
        patient.lastUpdateDatetime != null &&
        patient.lastUpdateDatetime <= options.modifiedSince
      ) {
        continue;
      }
      yield patient;
    }
  }

  async matchPatient(
    orgUuid: string,
    criteria: PatientMatchCriteria,
  ): Promise<PccPatientMatchResult> {
    this.record('matchPatient', { orgUuid, lastName: criteria.lastName });

    const matches = this.data.patients
      .filter(
        (patient) =>
          patient.lastName?.toLowerCase() === criteria.lastName.toLowerCase() &&
          patient.birthDate === criteria.birthDate,
      )
      .map((patient) => ({
        patientId: patient.patientId,
        facId: patient.facId ?? null,
        organizationMasterPatientId:
          this.data.masterPatients[patient.patientId]?.organizationMasterPatientId ?? null,
      }));

    return { matches };
  }

  async getOrganizationMasterPatient(
    orgUuid: string,
    patientId: string,
  ): Promise<PccMasterPatient | null> {
    this.record('getOrganizationMasterPatient', { orgUuid, patientId });
    return this.data.masterPatients[patientId] ?? null;
  }

  async listAdtRecords(orgUuid: string, patientId: string): Promise<PccAdtRecord[]> {
    this.record('listAdtRecords', { orgUuid, patientId });
    return this.data.adtRecords.filter((record) => record.patientId === patientId);
  }

  async *listFacilityAdtRecords(
    orgUuid: string,
    facId: string,
    options: ListPatientsOptions = {},
  ): AsyncIterable<PccAdtRecord> {
    this.record('listFacilityAdtRecords', { orgUuid, facId, modifiedSince: options.modifiedSince });

    for (const record of this.data.adtRecords) {
      if (record.facId !== facId) continue;
      if (
        options.modifiedSince !== undefined &&
        record.lastUpdateDatetime != null &&
        record.lastUpdateDatetime <= options.modifiedSince
      ) {
        continue;
      }
      yield record;
    }
  }

  async listCoverages(orgUuid: string, patientId: string): Promise<PccCoverage[]> {
    this.record('listCoverages', { orgUuid, patientId });
    return this.data.coverages[patientId] ?? [];
  }

  async listWebhookSubscriptions(orgUuid: string): Promise<PccWebhookSubscription[]> {
    this.record('listWebhookSubscriptions', { orgUuid });
    return this.data.webhookSubscriptions;
  }

  async createWebhookSubscription(
    orgUuid: string,
    input: CreateWebhookSubscriptionInput,
  ): Promise<PccWebhookSubscription> {
    this.record('createWebhookSubscription', { orgUuid, targetUrl: input.targetUrl });

    const subscription: PccWebhookSubscription = {
      subscriptionId: `SUB-${this.data.webhookSubscriptions.length + 1}`,
      eventTypes: [...input.eventTypes],
      targetUrl: input.targetUrl,
      status: 'ACTIVE',
    };
    this.data.webhookSubscriptions.push(subscription);
    return subscription;
  }

  // --- Test-facing mutators: these are how a test makes "PCC changed" happen. ---

  patchPatient(patientId: string, patch: Partial<PccPatient>): void {
    const index = this.data.patients.findIndex((patient) => patient.patientId === patientId);
    if (index === -1) throw new Error(`No fixture patient ${patientId}`);
    const existing = this.data.patients[index]!;
    this.data.patients[index] = { ...existing, ...patch };
  }

  setCoverages(patientId: string, coverages: PccCoverage[]): void {
    this.data.coverages[patientId] = coverages;
  }

  appendAdtRecord(record: PccAdtRecord): void {
    this.data.adtRecords.push(record);
  }

  /** Removes a facility's activation, which is how PCC signals the integration was switched off. */
  deactivateFacility(facId: string): void {
    this.data.activations = this.data.activations.filter(
      (activation) => activation.facId !== facId,
    );
  }
}
