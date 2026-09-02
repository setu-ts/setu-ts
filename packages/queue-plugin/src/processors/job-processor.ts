/**
 * Job processor runner.
 *
 * Runs job processors and handles ack/requeue/dead-letter based on result.
 *
 * @module
 */

import type { IIngressBehavior, IJob, IngressContext } from '@setu-ts/common';
import { composeBehaviorChain } from '@setu-ts/common';
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
 * How a job settled, as reported to {@linkcode JobRunnerHooks.onOutcome}.
 *
 * `retried` and `dead_lettered` are separate because they answer different
 * questions: retries measure flakiness, dead letters measure LOST WORK, and
 * collapsing them into one failure count hides the second behind the first.
 *
 * @since 0.3.0
 */
export type JobOutcome = 'completed' | 'retried' | 'dead_lettered';

/**
 * Observers the queue service threads into {@linkcode runJob}.
 *
 * @typeParam T - The job payload type
 * @since 0.3.0
 */
export interface JobRunnerHooks<T> {
  /**
   * The application's `ProcessOptions.onFailed`, invoked once on the final
   * attempt, immediately before the job is dead-lettered.
   */
  readonly onFailed?: (job: IJob<T>, error: unknown) => void | Promise<void>;
  /** The service's instrumentation sink; invoked for every settled job. */
  readonly onOutcome?: (name: string, outcome: JobOutcome) => void;
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
 * @param hooks - Optional observers. `onFailed` is the application's callback,
 * invoked ONCE on the final attempt before the job is dead-lettered; `onOutcome`
 * is the service's own instrumentation sink. Both are guarded: a throwing
 * observer is reported and swallowed, because losing the job as well as the
 * notification would be strictly worse than losing the notification.
 * @since 0.1.0
 */
export async function runJob<T>(
  runtime: IRuntimeServices,
  adapter: JobRunnerAdapter,
  storedJob: StoredJob<T>,
  processor: (job: IJob<T>) => void | Promise<void>,
  report?: (message: string, error: unknown, meta?: Record<string, unknown>) => void,
  hooks?: JobRunnerHooks<T>,
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
      notifyOutcome(hooks, storedJob.name, 'retried', report);
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
      // BEFORE the dead-letter, so an application that compensates in the
      // callback still sees the job in flight rather than already discarded.
      await notifyFailed(hooks, job, error, report);
      notifyOutcome(hooks, storedJob.name, 'dead_lettered', report);
      await adapter.deadLetter(storedJob.name, storedJob.id, runtime.now(), claimToken);
      return;
    }
  }

  // Success: acknowledge (outside the try/catch so ack errors don't trigger requeue)
  notifyOutcome(hooks, storedJob.name, 'completed', report);
  await adapter.ack(storedJob.name, storedJob.id, claimToken);
}

/**
 * Wraps one processor in the queue arm of the transport-neutral ingress
 * behaviour chain.
 *
 * The returned processor is what the worker dispatches, so the chain sits
 * exactly around the `await processor(job)` dispatch in {@linkcode runJob}:
 * the existing retry/dead-letter machinery needs no knowledge of it. The
 * envelope is built PER JOB and is immutable — under `concurrency` above 1
 * every in-flight job sees its own `IngressContext` instance — carrying
 * `kind: 'queue'`, the job name, the delivered `IJob` as `payload`, and
 * `attempt` equal to `IJob.attempts`.
 *
 * With an EMPTY behaviour list the original processor is invoked directly
 * with no chain allocated: a synchronous throw propagates synchronously and a
 * returned promise is handed back as-is, so the zero-configuration dispatch
 * is byte-identical to the unwrapped call.
 *
 * @typeParam T - The job payload type
 * @param processor - The processor to wrap
 * @param behaviors - The behaviours to run ahead of the processor, in
 * declared order. Read LIVE on every delivery: entries resolved after the
 * processor was registered (the plugin's `onInit` factory arm) are picked up
 * without re-registering.
 * @returns A processor with the same signature running the chain first
 * @since 0.3.0
 */
export function withIngressBehaviors<T>(
  processor: (job: IJob<T>) => void | Promise<void>,
  behaviors: readonly IIngressBehavior[],
): (job: IJob<T>) => void | Promise<void> {
  return (job: IJob<T>): void | Promise<void> => {
    if (behaviors.length === 0) {
      // Zero-configuration dispatch — byte-identical to the pre-chain
      // behaviour: a direct invocation, no envelope, no promise mediation.
      return processor(job);
    }

    return composeBehaviorChain<IngressContext<IJob<T>>, void>(
      { kind: 'queue', name: job.name, payload: job, attempt: job.attempts },
      behaviors,
      () => Promise.resolve(processor(job)),
    );
  };
}

/**
 * Invokes the application's `onFailed`, guarded.
 *
 * A callback that throws — or returns a rejecting promise — must not abort the
 * dead-letter that follows it: the job would then be neither retried nor
 * recorded, which is a worse outcome than a lost notification.
 *
 * @typeParam T - The job payload type
 * @param hooks - The observers, when any were supplied
 * @param job - The job as its processor received it
 * @param error - What the processor threw on the final attempt
 * @param report - Sink for a failure inside the callback itself
 */
async function notifyFailed<T>(
  hooks: JobRunnerHooks<T> | undefined,
  job: IJob<T>,
  error: unknown,
  report?: (message: string, error: unknown, meta?: Record<string, unknown>) => void,
): Promise<void> {
  if (hooks?.onFailed === undefined) {
    return;
  }
  try {
    await hooks.onFailed(job, error);
  } catch (callbackError) {
    report?.('queue onFailed callback threw', callbackError, {
      job: job.id,
      name: job.name,
    });
  }
}

/**
 * Records a settled job with the instrumentation sink, guarded for the same
 * reason as {@linkcode notifyFailed}: an instrument write is a throwing call
 * (a metrics service validates its labels), and observing the work must never
 * be able to lose it.
 *
 * @typeParam T - The job payload type
 * @param hooks - The observers, when any were supplied
 * @param name - The job name
 * @param outcome - How the job settled
 * @param report - Sink for a failure inside the sink itself
 */
function notifyOutcome<T>(
  hooks: JobRunnerHooks<T> | undefined,
  name: string,
  outcome: JobOutcome,
  report?: (message: string, error: unknown, meta?: Record<string, unknown>) => void,
): void {
  try {
    hooks?.onOutcome?.(name, outcome);
  } catch (sinkError) {
    report?.('queue outcome sink threw', sinkError, { name, outcome });
  }
}
