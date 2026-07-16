/**
 * Job executor with retry and backoff.
 *
 * Runs the handler, and on rejection with `attempt < retry.limit`
 * waits the computed backoff (via `runtime.setTimeout`) and retries.
 * At `attempt === retry.limit` it gives up.
 *
 * @module
 */
import type {
  ILogger,
  IRuntimeServices,
  RetryOptions,
  ScheduledJob,
  SchedulerJobHandler,
} from '@hono-enterprise/common';
import { computeBackoffMs } from '../retry/retry-handler.ts';

/**
 * Options passed to `run()`.
 */
interface RunOptions {
  runtime: IRuntimeServices;
  logger?: ILogger | undefined;
}

/**
 * Runs a handler with retry and backoff.
 *
 * @param jobId - Unique job identifier
 * @param jobName - Human-readable job name
 * @param handler - The handler to invoke
 * @param data - Optional payload
 * @param retry - Optional retry configuration
 * @param options - Runtime and optional logger
 * @returns The final settled result
 */
export async function run<T = unknown>(
  jobId: string,
  jobName: string,
  handler: SchedulerJobHandler<T>,
  data: T | undefined,
  retry: RetryOptions | undefined,
  options: RunOptions,
): Promise<void> {
  const { runtime, logger } = options;
  const limit = retry?.limit ?? 1;
  let attempt = 0;

  while (true) {
    attempt++;
    const job: ScheduledJob<T> = {
      id: jobId,
      name: jobName,
      data: data ?? undefined as T,
      attempts: attempt,
    };

    try {
      await handler(job);
      return;
    } catch (error) {
      if (attempt < limit) {
        const backoffMs = retry !== undefined ? computeBackoffMs(attempt, retry) : 1000;
        logger?.warn(
          `Job '${jobName}' attempt ${attempt} failed, retrying in ${backoffMs}ms`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        await new Promise<void>((resolve) => {
          runtime.setTimeout(resolve, backoffMs);
        });
      } else {
        logger?.error(
          `Job '${jobName}' failed after ${attempt} attempt(s)`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        throw error;
      }
    }
  }
}
