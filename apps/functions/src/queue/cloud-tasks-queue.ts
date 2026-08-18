import { CloudTasksClient } from '@google-cloud/tasks';
import { syncTaskSchema, type SyncTask } from '@rehabalpha/core';
import type { EnqueueOptions, TaskQueue } from '@rehabalpha/sync';
import type { FunctionsConfig } from '../config.js';

/**
 * Hands work to Cloud Tasks so the webhook can acknowledge in milliseconds.
 *
 * Cloud Tasks has no local emulator, which is why the sync package defines `TaskQueue` as a port and
 * tests use an in-memory implementation. Production gets durable delivery, OIDC-authenticated calls
 * to the worker, and deduplication by task name for roughly an hour after completion.
 */
export class CloudTasksQueue implements TaskQueue {
  private readonly client: CloudTasksClient;

  constructor(
    private readonly config: FunctionsConfig,
    client?: CloudTasksClient,
  ) {
    this.client = client ?? new CloudTasksClient();
  }

  async enqueue(task: SyncTask, options: EnqueueOptions = {}): Promise<void> {
    const parsed = syncTaskSchema.parse(task);
    const scheduleSeconds =
      options.delayMs !== undefined && options.delayMs > 0
        ? Math.floor(Date.now() / 1000) + Math.ceil(options.delayMs / 1000)
        : undefined;

    const taskName =
      options.dedupeKey !== undefined
        ? `${this.config.syncTasksQueue}/tasks/${encodeTaskName(options.dedupeKey)}`
        : undefined;

    await this.client.createTask({
      parent: this.config.syncTasksQueue,
      task: {
        ...(taskName !== undefined ? { name: taskName } : {}),
        ...(scheduleSeconds !== undefined ? { scheduleTime: { seconds: scheduleSeconds } } : {}),
        httpRequest: {
          httpMethod: 'POST',
          url: this.config.syncWorkerUrl,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(parsed)).toString('base64'),
          oidcToken: {
            serviceAccountEmail: this.config.syncTasksInvokerServiceAccount,
          },
        },
      },
    });
  }
}

/** Cloud Tasks task names may contain only letters, numbers, hyphens and underscores. */
function encodeTaskName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 500);
}

/**
 * Runs the worker in-process. Used in tests and in the emulator where Cloud Tasks does not exist.
 *
 * This is emphatically not a production strategy: it collapses the acknowledgement budget the queue
 * exists to protect, and it loses the work if the process dies. The name makes that visible.
 */
export class InlineTaskQueue implements TaskQueue {
  constructor(private readonly handler: (task: SyncTask) => Promise<void>) {}

  async enqueue(task: SyncTask, _options?: EnqueueOptions): Promise<void> {
    await this.handler(task);
  }
}
