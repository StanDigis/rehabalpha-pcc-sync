import { documentIds } from '@rehabalpha/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleSyncWorker } from '../src/handlers/http.js';
import { handlePccWebhook } from '../src/handlers/pcc-webhook.js';
import {
  BETTY_PCC_PATIENT_ID,
  FIXTURE_FERNCREST_FAC_ID,
  FIXTURE_ORG_UUID,
  createHarness,
  mockRequest,
  mockResponse,
  type Harness,
} from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.reset();
});

const notification = {
  messageId: 'msg-fn-1',
  eventType: 'patient.updated',
  orgUuid: FIXTURE_ORG_UUID,
  facId: FIXTURE_FERNCREST_FAC_ID,
  patientId: BETTY_PCC_PATIENT_ID,
  eventDateTime: '2026-09-25T14:58:00Z',
};

describe('pccWebhook HTTP handler', () => {
  it('acknowledges quickly and enqueues work', async () => {
    const res = mockResponse();
    await handlePccWebhook(mockRequest(notification) as never, res as never, h.runtime);

    expect(res.state.statusCode).toBe(200);
    expect(res.state.body).toMatchObject({ status: 'queued' });
    expect(h.queue.enqueued).toHaveLength(1);
  });

  it('writes the patient when the inline queue drains', async () => {
    const res = mockResponse();
    await handlePccWebhook(mockRequest(notification) as never, res as never, h.runtime);

    const patientId = documentIds.patient(FIXTURE_ORG_UUID, BETTY_PCC_PATIENT_ID);
    expect(await h.store.getPatient(patientId)).not.toBeNull();
  });

  it('rejects requests when a shared secret is configured and missing', async () => {
    h.runtime.config.webhookSharedSecret = 'expected';
    const res = mockResponse();
    await handlePccWebhook(mockRequest(notification) as never, res as never, h.runtime);
    expect(res.state.statusCode).toBe(401);
    h.runtime.config.webhookSharedSecret = null;
  });
});

describe('syncWorker HTTP handler', () => {
  it('processes a task posted directly to the worker endpoint', async () => {
    const task = {
      taskId: 'tsk_direct',
      therapyOrgId: 'org_healthpro',
      pccOrgUuid: FIXTURE_ORG_UUID,
      pccFacId: FIXTURE_FERNCREST_FAC_ID,
      entityType: 'patient' as const,
      scope: 'all' as const,
      entityPccId: BETTY_PCC_PATIENT_ID,
      reason: 'webhook' as const,
      causedByEventId: null,
      attempt: 1,
      enqueuedAt: '2026-09-25T15:00:00.000Z',
    };

    const res = mockResponse();
    await handleSyncWorker(mockRequest(task) as never, res as never, h.runtime);

    expect(res.state.statusCode).toBe(200);
    expect(
      await h.store.getPatient(documentIds.patient(FIXTURE_ORG_UUID, BETTY_PCC_PATIENT_ID)),
    ).not.toBeNull();
  });
});
