import type { SyncTask } from '@rehabalpha/core';

export type EnqueueOptions = {
  delayMs?: number;
  /**
   * Names the task so the queue can reject a duplicate. Cloud Tasks deduplicates by task name for
   * roughly an hour after completion, which turns a redelivered webhook into a no-op at the queue
   * rather than at the worker.
   */
  dedupeKey?: string;
};

/**
 * The boundary between "decided to do work" and "work happens later".
 *
 * A port rather than a direct Cloud Tasks call for a practical reason as much as a design one:
 * Cloud Tasks has no local emulator. Without this seam the ingest path could not be exercised end
 * to end on a developer machine or in CI, and the tests that matter most — a duplicate delivery, a
 * retry storm, a poison message reaching the dead-letter queue — are exactly the ones that need it.
 *
 * The production adapter lives in the functions app, next to the runtime configuration it needs.
 */
export interface TaskQueue {
  enqueue(task: SyncTask, options?: EnqueueOptions): Promise<void>;
}

/** Records enqueued work without running it, so a test can assert on what was scheduled. */
export class RecordingTaskQueue implements TaskQueue {
  readonly enqueued: { task: SyncTask; options: EnqueueOptions }[] = [];
  private readonly seenDedupeKeys = new Set<string>();

  async enqueue(task: SyncTask, options: EnqueueOptions = {}): Promise<void> {
    if (options.dedupeKey !== undefined) {
      if (this.seenDedupeKeys.has(options.dedupeKey)) return;
      this.seenDedupeKeys.add(options.dedupeKey);
    }
    this.enqueued.push({ task, options });
  }

  reset(): void {
    this.enqueued.length = 0;
    this.seenDedupeKeys.clear();
  }
}

/**
 * Runs the handler immediately, in process.
 *
 * Used for local runs and for integration tests that want the whole pipeline in one call. It is
 * emphatically not a production strategy: it collapses the acknowledgement budget that the queue
 * exists to protect, and it loses the work if the process dies. The distinction is worth keeping
 * visible in the type name.
 */
export class InlineTaskQueue implements TaskQueue {
  constructor(private readonly handler: (task: SyncTask) => Promise<void>) {}

  async enqueue(task: SyncTask): Promise<void> {
    await this.handler(task);
  }
}
