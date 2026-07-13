/**
 * Job processor runner.
 *
 * Runs job processors and handles ack/requeue/dead-letter based on result.
 *
 * @module
 */

import type { IJob } from '@hono-enterprise/common';
import type { StoredJob } from '../interfaces/index.ts';
import { computeBackoffMs } from '../retry/retry-strategy.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * Internal interface for the adapter methods JobRunner needs.
 * Not barrel-exported.
 */
interface JobRunnerAdapter {
  ack(name: string, id: string): Promise<void>;
  requeue(name: string, id: string, availableAtMs: number, attempts: number): Promise<void>;
  deadLetter(name: string, id: string, nowMs: number): Promise<void>;
}

/**
 * Runs a job processor and handles the result.
 *
 * On success: calls `ack`.
 * On failure with attempts < maxAttempts: calls `requeue` with backoff.
 * On failure at maxAttempts: calls `deadLetter`.
 *
 * @param runtime - Runtime services for clock and timers
 * @param adapter - The queue adapter for ack/requeue/deadLetter
 * @param storedJob - The stored job with attempts and maxAttempts
 * @param processor - The user-provided processor function
 * @since 0.1.0
 */
export async function runJob<T>(
  runtime: IRuntimeServices,
  adapter: JobRunnerAdapter,
  storedJob: StoredJob<T>,
  processor: (job: IJob<T>) => void | Promise<void>,
): Promise<void> {
  const job: IJob<T> = {
    id: storedJob.id,
    name: storedJob.name,
    data: storedJob.data,
    attempts: storedJob.attempts,
  };

  try {
    await processor(job);
    // Success: acknowledge
    await adapter.ack(storedJob.name, storedJob.id);
  } catch {
    // Failure: requeue or dead-letter
    if (storedJob.attempts < storedJob.maxAttempts) {
      const nextAttempts = storedJob.attempts + 1;
      const backoffMs = computeBackoffMs(nextAttempts);
      const availableAtMs = runtime.now() + backoffMs;
      await adapter.requeue(storedJob.name, storedJob.id, availableAtMs, nextAttempts);
    } else {
      // At max attempts: dead-letter
      await adapter.deadLetter(storedJob.name, storedJob.id, runtime.now());
    }
  }
}
