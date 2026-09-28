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
import type {
  SchedulerAttemptObserver,
  SchedulerAttemptSettle,
} from '../diagnostics/scheduler-observations.ts';

/**
 * The handlers {@linkcode withIngressBehaviors} returned (M98k). Such a
 * function is the behaviour CHAIN, not the application's handler: a
 * behaviour may decline the dispatch, call `next()` more than once, or call
 * it after its own step returned, so {@linkcode run} must not treat invoking
 * the chain as a handler attempt. The chain measures the handler itself,
 * through {@linkcode invokeHandler}.
 */
const CHAIN_WRAPPED = new WeakSet<object>();

/**
 * The attempt observer's `begin` for each OBSERVED job object, registered by
 * {@linkcode run}. Every handler invocation for that job — however many the
 * chain makes, and whenever it makes them — begins and settles its own
 * attempt. Only an observed dispatch registers one, so an unobserved
 * dispatch pays one `WeakMap.get` and no allocation.
 */
const ATTEMPT_BEGINS = new WeakMap<object, () => SchedulerAttemptSettle>();

/**
 * Invokes the application's handler — the one place it runs — and, for an
 * observed job, records that invocation as one attempt, settled by the
 * handler's OWN result: fulfilled, rejected, or a synchronous throw. The
 * handler's result and error identity reach the caller unchanged.
 *
 * @param handler - The application's handler
 * @param job - The delivered job
 * @returns The handler's result
 */
function invokeHandler<T>(
  handler: SchedulerJobHandler<T>,
  job: ScheduledJob<T>,
): void | Promise<void> {
  const begin = ATTEMPT_BEGINS.get(job);
  if (begin === undefined) {
    return handler(job);
  }
  const settle = begin();
  let result: void | Promise<void>;
  try {
    result = handler(job);
  } catch (error) {
    settle(false);
    throw error;
  }
  if (result === undefined || result === null || typeof result.then !== 'function') {
    settle(true);
    return result;
  }
  return Promise.resolve(result).then(
    () => settle(true),
    (error: unknown) => {
      settle(false);
      throw error;
    },
  );
}

/**
 * Options passed to `run()`.
 */
interface RunOptions {
  runtime: IRuntimeServices;
  logger?: ILogger | undefined;
  /**
   * The M98k attempt observer for an observed dispatch. Absent — the
   * default — the executor runs exactly the pre-M98k path: no observation
   * object is allocated. Present, the observer times each attempt itself.
   */
  attempts?: SchedulerAttemptObserver | undefined;
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
  const { runtime, logger, attempts } = options;
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

    // M98k: an attempt is one INVOCATION of the application's handler,
    // begun and settled around that invocation by `invokeHandler` — inside
    // the behaviour chain when one is configured, so a declined dispatch
    // records none and a late or repeated `next()` records its own. The
    // observer measures through the collector's guarded clock; the executor
    // reads no clock, so a throwing clock can never fail or retry a handler
    // that succeeded.
    if (attempts !== undefined) {
      const isRetry = attempt > 1;
      ATTEMPT_BEGINS.set(job, () => attempts.begin(isRetry));
    }
    try {
      await (attempts === undefined || CHAIN_WRAPPED.has(handler)
        ? handler(job)
        : invokeHandler(handler, job));
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
 * dispatch is byte-identical to the unwrapped call. (An OBSERVED dispatch —
 * M98k diagnostics — returns a promise settling with the handler's own
 * result and error instead, so the attempt can be settled by it.)
 *
 * @typeParam T - The job payload type
 * @param handler - The handler to wrap
 * @param behaviors - The behaviours to run ahead of the handler, in declared
 * order. Read LIVE on every fire: entries resolved after the handler was
 * registered (the plugin's `onInit` factory arm) are picked up without
 * re-registering.
 * @param chainReady - Held while behaviour FACTORIES are unresolved, so a
 * short-delay job armed during startup cannot fire through a PARTIAL chain.
 * Supplied only when a factory is declared; omitted, a fire is never
 * deferred. It gates the plugin's own declared jobs AND any a later plugin
 * schedules imperatively through the resolved scheduler.
 * @returns A handler with the same signature running the chain first
 * @since 0.3.0
 */
export function withIngressBehaviors<T>(
  handler: SchedulerJobHandler<T>,
  behaviors: readonly IIngressBehavior[],
  chainReady?: Promise<void>,
): SchedulerJobHandler<T> {
  let gate = chainReady;
  // Clear the gate once open so the steady state costs nothing. A REJECTED
  // gate is deliberately left in place: startup failed, the chain is never
  // completed, and running through a partial chain is what this prevents.
  void chainReady?.then(() => {
    gate = undefined;
  }, () => {});

  const dispatch = (job: ScheduledJob<T>): void | Promise<void> => {
    if (behaviors.length === 0) {
      // Zero-configuration dispatch — byte-identical to the pre-chain
      // behaviour: a direct invocation, no envelope, no promise mediation.
      return invokeHandler(handler, job);
    }

    return composeBehaviorChain<IngressContext<ScheduledJob<T>>, void>(
      { kind: 'scheduler', name: job.name, payload: job, attempt: job.attempts },
      behaviors,
      // The terminal step: the one place the application's handler runs.
      () => Promise.resolve(invokeHandler(handler, job)),
    );
  };

  const wrapped = (job: ScheduledJob<T>): void | Promise<void> => {
    // The deferred result is RETURNED so a handler failure still reaches the
    // executor's retry path rather than becoming an unhandled rejection.
    return gate === undefined ? dispatch(job) : gate.then(() => dispatch(job));
  };
  CHAIN_WRAPPED.add(wrapped);
  return wrapped;
}
