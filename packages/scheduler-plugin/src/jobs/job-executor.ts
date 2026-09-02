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
  IIngressBehavior,
  ILogger,
  IngressContext,
  IRuntimeServices,
  RetryOptions,
  ScheduledJob,
  SchedulerJobHandler,
} from '@setu-ts/common';
import { composeBehaviorChain } from '@setu-ts/common';
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
    // N6 FIX: Remove the `?? undefined as T` pattern that defeats type safety.
    // The `data` parameter is `T | undefined`, so `T` is inferred as `unknown | undefined`
    // from the call site, and `data` passes through correctly.
    const job: ScheduledJob<T> = {
      id: jobId,
      name: jobName,
      data: data as T,
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

/**
 * Wraps one handler in the scheduler arm of the transport-neutral ingress
 * behaviour chain.
 *
 * The returned handler is what the registry stores, so the chain sits exactly
 * around the `await handler(job)` dispatch inside {@linkcode run}: the
 * existing retry machinery needs no knowledge of it, and because `run` is
 * reached only after the distributed lock has been acquired, the chain runs
 * INSIDE the lock — a replica that loses the lock runs neither the handler
 * nor any behaviour (M86 §3.10). The envelope is built PER FIRE and is
 * immutable, carrying `kind: 'scheduler'`, the job name, the delivered
 * `ScheduledJob` as `payload`, and the 1-based `attempt`.
 *
 * With an EMPTY behaviour list the original handler is invoked directly with
 * no chain allocated: a synchronous throw propagates synchronously and the
 * handler's own return value is handed back as-is, so the zero-configuration
 * dispatch is byte-identical to the unwrapped call.
 *
 * @typeParam T - The job payload type
 * @param handler - The handler to wrap
 * @param behaviors - The behaviours to run ahead of the handler, in declared
 * order. Read LIVE on every fire: entries resolved after the handler was
 * registered (the plugin's `onInit` factory arm) are picked up without
 * re-registering.
 * @returns A handler with the same signature running the chain first
 * @since 0.3.0
 */
export function withIngressBehaviors<T>(
  handler: SchedulerJobHandler<T>,
  behaviors: readonly IIngressBehavior[],
): SchedulerJobHandler<T> {
  return (job: ScheduledJob<T>): void | Promise<void> => {
    if (behaviors.length === 0) {
      // Zero-configuration dispatch — byte-identical to the pre-chain
      // behaviour: a direct invocation, no envelope, no promise mediation.
      return handler(job);
    }

    return composeBehaviorChain<IngressContext<ScheduledJob<T>>, void>(
      { kind: 'scheduler', name: job.name, payload: job, attempt: job.attempts },
      behaviors,
      () => Promise.resolve(handler(job)),
    );
  };
}
