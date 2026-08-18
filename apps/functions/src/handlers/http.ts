import { syncTaskSchema } from '@rehabalpha/core';
import type { Request, Response } from 'express';
import {
  processSyncTask,
  replayDeadLetterForOperator,
  resolveOperator,
  operatorMayReplay,
} from './sync-worker.js';
import type { Runtime } from '../runtime.js';

/** Cloud Tasks target: runs one sync task and schedules a delayed retry when appropriate. */
export async function handleSyncWorker(
  req: Request,
  res: Response,
  runtime: Runtime,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const parsed = syncTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_task' });
    return;
  }

  try {
    const result = await processSyncTask(parsed.data, {
      config: runtime.config,
      store: runtime.store,
      clock: runtime.clock,
      audit: runtime.audit,
      secretStore: runtime.secretStore,
      queue: runtime.queue,
    });

    if (result.status === 'retry') {
      // A new task was scheduled with the computed backoff; tell Cloud Tasks this delivery succeeded.
      res.status(200).json({ status: 'retry_scheduled', delayMs: result.delayMs });
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: 'worker_failed',
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** Operator action: replay a dead-lettered unit of work after fixing the underlying problem. */
export async function handleReplayDeadLetter(
  req: Request,
  res: Response,
  runtime: Runtime,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const deadLetterId =
    typeof req.body === 'object' && req.body !== null && 'deadLetterId' in req.body
      ? String((req.body as { deadLetterId: unknown }).deadLetterId)
      : null;

  if (deadLetterId === null || deadLetterId === '') {
    res.status(400).json({ error: 'missing_dead_letter_id' });
    return;
  }

  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const operator = await resolveOperator(runtime.store, token);
  if (operator === null) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  const therapyOrgId =
    typeof req.body === 'object' && req.body !== null && 'therapyOrgId' in req.body
      ? String((req.body as { therapyOrgId: unknown }).therapyOrgId)
      : operator.therapyOrgId;

  if (!operatorMayReplay(operator, therapyOrgId)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const note =
    typeof req.body === 'object' && req.body !== null && 'note' in req.body
      ? String((req.body as { note: unknown }).note)
      : '';

  const result = await replayDeadLetterForOperator(
    { therapyOrgId, deadLetterId, actorUid: operator.uid, note },
    {
      config: runtime.config,
      store: runtime.store,
      clock: runtime.clock,
      audit: runtime.audit,
      secretStore: runtime.secretStore,
      queue: runtime.queue,
    },
  );

  if (result.status === 'notFound') {
    res.status(404).json(result);
    return;
  }

  res.status(200).json(result);
}
