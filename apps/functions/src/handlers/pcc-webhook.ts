import { pccWebhookNotificationSchema } from '@rehabalpha/pcc-client';
import type { Request, Response } from 'express';
import type { Runtime } from '../runtime.js';

/**
 * PointClickCare expects acknowledgement within a few seconds. This handler validates, records the
 * envelope, enqueues, and returns — nothing else. Every expensive step happens in the worker.
 */
export async function handlePccWebhook(
  req: Request,
  res: Response,
  runtime: Runtime,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  if (!verifyWebhookSecret(req, runtime.config.webhookSharedSecret)) {
    res.status(401).send('Unauthorized');
    return;
  }

  const parsed = pccWebhookNotificationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_notification' });
    return;
  }

  const connection = await runtime.store.findConnectionByPccOrg(parsed.data.orgUuid);
  if (connection === null) {
    // Acknowledge anyway: retrying cannot onboard a facility nobody configured.
    res.status(202).json({ status: 'ignored', reason: 'connection_not_found' });
    return;
  }

  const result = await runtime.ingest.accept(connection, parsed.data);
  res.status(200).json(result);
}

function verifyWebhookSecret(req: Request, secret: string | null): boolean {
  if (secret === null) return true;
  const header = req.header('x-pcc-webhook-secret');
  return header === secret;
}
