/**
 * Job processor runner.
 *
 * Runs job processors and handles ack/requeue/dead-letter based on result.
 *
 * @module
 */

import type { IJob } from '@setu-ts/common';
import type { StoredJob } from '../interfaces/index.ts';
import { computeBackoffMs } from '../retry/retry-strategy.ts';
import type { IRuntimeServices } from '@setu-ts/common';

/**
 * Internal interface for the adapter methods JobRunner needs.
 * Not barrel-exported.
 */
interface JobRunnerAdapter {
  ack(name: string, id: string, claimToken: string): Promise<void>;
  requeue(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
    claimToken: string,
  ): Promise<void>;
  deadLetter(name: string, id: string, nowMs: number, claimToken: string): Promise<void>;
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
 * @param report - Optional sink for the processor's failure. Without it a
 * failing job is completely silent: the error was caught to drive
 * requeue/dead-letter and then discarded, so nothing logged it anywhere.
 * @since 0.1.0
 */
export async function runJob<T>(
  runtime: IRuntimeServices,
  adapter: JobRunnerAdapter,
  storedJob: StoredJob<T>,
  processor: (job: IJob<T>) => void | Promise<void>,
  report?: (message: string, error: unknown, meta?: Record<string, unknown>) => void,
): Promise<void> {
  const job: IJob<T> = {
    id: storedJob.id,
    name: storedJob.name,
    data: storedJob.data,
    attempts: storedJob.attempts,
  };

  // The claim token identifies THIS delivery, so an adapter can reject a settle
  // that belongs to a superseded one. Adapters with no transport-level claim
  // (memory, redis, rabbitmq) leave `claimToken` unset and ignore the argument,
  // so the job id is a serviceable stand-in; SQS sets it in `reserve` and
  // validates it on every settle. Passing the id unconditionally made every SQS
  // settle fail its own claim check, so nothing was ever deleted, requeued, or
  // dead-lettered.
  const claimToken = storedJob.claimToken ?? storedJob.id;

  // Execute the processor - if it fails, requeue or dead-letter
  try {
    await processor(job);
  } catch (error) {
    // Failure: requeue or dead-letter — and say so, rather than discarding the
    // reason the job failed.
    if (storedJob.attempts < storedJob.maxAttempts) {
      const nextAttempts = storedJob.attempts + 1;
      const backoffMs = computeBackoffMs(nextAttempts);
      const availableAtMs = runtime.now() + backoffMs;
      report?.('queue job failed — retrying', error, {
        job: storedJob.id,
        name: storedJob.name,
        attempts: storedJob.attempts,
        maxAttempts: storedJob.maxAttempts,
        retryInMs: backoffMs,
      });
      await adapter.requeue(
        storedJob.name,
        storedJob.id,
        availableAtMs,
        nextAttempts,
        claimToken,
      );
      return;
    } else {
      // At max attempts: dead-letter
      report?.('queue job failed — dead-lettered', error, {
        job: storedJob.id,
        name: storedJob.name,
        attempts: storedJob.attempts,
        maxAttempts: storedJob.maxAttempts,
      });
      await adapter.deadLetter(storedJob.name, storedJob.id, runtime.now(), claimToken);
      return;
    }
  }

  // Success: acknowledge (outside the try/catch so ack errors don't trigger requeue)
  await adapter.ack(storedJob.name, storedJob.id, claimToken);
}
