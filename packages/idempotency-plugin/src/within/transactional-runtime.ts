/**
 * The tier-C plugin wiring (M109b §3.5): resolve the store at `onInit`,
 * `verify()` it under the store timeout, schedule the retention purge, and
 * remove the job at shutdown. The M108 `inbox` shape, already audited.
 *
 * @module
 */
import type {
  ILogger,
  IPluginContext,
  IScheduler,
  ITransactionalIdempotencyStore,
  RegistryFactory,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  resolveProbeTiming,
  resolveRegistryEntry,
  withDeadline,
} from '@setu-ts/common';
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_PURGE_BATCH,
  DEFAULT_PURGE_INTERVAL_MS,
  DEFAULT_STORE_TIMEOUT_MS,
  DEFAULT_TTL_MS,
} from '../constants.ts';
import { errorKind } from '../core/error-kind.ts';
import { safeLog } from '../core/safe-log.ts';
import {
  IdempotencyConfigurationError,
  IdempotencyVerifyTimeoutError,
  IdempotencyWithinError,
} from '../errors.ts';
import type { TransactionalIdempotencyOptions } from '../interfaces/index.ts';

/** The tier-C state a `within` call reads once the plugin is initialised. */
export interface TransactionalRuntimeState {
  /** The verified transactional store. */
  readonly store: ITransactionalIdempotencyStore;
  /** Default record eligibility age. */
  readonly ttlMs: number;
  /** Bound on each store call except the transaction itself. */
  readonly storeTimeoutMs: number;
  /** Largest storable result in UTF-8 bytes. */
  readonly maxResultBytes: number;
  /** Records deleted per purge. */
  readonly purgeBatch: number;
}

/** The tier-C options with every default applied. */
export interface ResolvedTransactionalOptions {
  readonly store: ITransactionalIdempotencyStore | RegistryFactory<ITransactionalIdempotencyStore>;
  readonly ttlMs: number;
  readonly storeTimeoutMs: number;
  readonly maxResultBytes: number;
  readonly schedule: boolean;
  readonly intervalMs: number;
  readonly batch: number;
}

/** The live tier-C wiring: a reader for the activated state. */
export interface TransactionalRuntime {
  /** The active state, or `undefined` before `onInit` completed. */
  readonly state: () => TransactionalRuntimeState | undefined;
}

/**
 * Applies the tier-C defaults (M109b §3.13).
 *
 * @param options - The configured tier-C options
 * @returns The options with every default applied
 */
export function resolveTransactionalOptions(
  options: TransactionalIdempotencyOptions,
): ResolvedTransactionalOptions {
  return {
    store: options.store,
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    storeTimeoutMs: options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS,
    maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    schedule: options.purge?.schedule ?? true,
    intervalMs: options.purge?.intervalMs ?? DEFAULT_PURGE_INTERVAL_MS,
    batch: options.purge?.batch ?? DEFAULT_PURGE_BATCH,
  };
}

/**
 * Runs one retention purge, bounded by the store timeout and logged by class
 * only. A store failure is reported as a value-free `'store-failed'`.
 *
 * @param state - The active tier-C state
 * @param logger - The logger thunk, read at call time
 * @param runtime - The runtime services (clock, timers)
 * @returns The number of records deleted
 */
export async function purgeOnce(
  state: TransactionalRuntimeState,
  logger: () => ILogger | undefined,
  runtime: IPluginContext['runtime'],
): Promise<number> {
  try {
    return await withDeadline(() => state.store.purge(runtime.now(), state.purgeBatch), {
      timeoutMs: state.storeTimeoutMs,
      onTimeout: () =>
        new IdempotencyWithinError(
          'store-failed',
          'idempotency: the transactional store did not answer while purging',
        ),
      timing: resolveProbeTiming(runtime),
    });
  } catch (error) {
    safeLog(logger, 'warn', 'idempotency: the transactional purge failed', {
      errorKind: errorKind(error),
    });
    if (error instanceof IdempotencyWithinError) throw error;
    throw new IdempotencyWithinError(
      'store-failed',
      'idempotency: the transactional store failed while purging',
    );
  }
}

/**
 * Wires the tier-C store into the plugin lifecycle.
 *
 * At `onInit` it reads the scheduler capability (refusing by name when a
 * scheduled purge has no scheduler), resolves and verifies the store, activates
 * it, and schedules the purge. `onShutdown` and `onClose` remove the job.
 *
 * @param ctx - The plugin context
 * @param options - The resolved tier-C options
 * @param logger - The logger thunk, read at call time
 * @param purgeJobName - The scheduled purge job's name
 * @returns The runtime whose `state()` the service reads
 */
export function setupTransactional(
  ctx: IPluginContext,
  options: ResolvedTransactionalOptions,
  logger: () => ILogger | undefined,
  purgeJobName: string,
): TransactionalRuntime {
  let state: TransactionalRuntimeState | undefined;
  let scheduler: IScheduler | undefined;

  const unschedule = async (): Promise<void> => {
    const active = scheduler;
    scheduler = undefined;
    if (active === undefined) return;
    try {
      await active.remove(purgeJobName);
    } catch (error) {
      safeLog(logger, 'warn', 'idempotency: could not remove the tier-C purge job', {
        errorKind: errorKind(error),
      });
    }
  };
  ctx.lifecycle.onShutdown(unschedule);
  ctx.lifecycle.onClose(unschedule);

  ctx.lifecycle.onInit(async () => {
    let purgeScheduler: IScheduler | undefined;
    if (options.schedule) {
      if (!ctx.services.has(CAPABILITIES.SCHEDULER)) {
        throw new IdempotencyConfigurationError(
          'transactional.purge.schedule',
          'idempotency: transactional purge is scheduled but no scheduler is registered',
        );
      }
      purgeScheduler = ctx.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
    }
    const store = resolveRegistryEntry(
      options.store,
      ctx.services,
      'IdempotencyPlugin({ transactional: { store } })',
    );
    try {
      await withDeadline(() => store.verify(), {
        timeoutMs: options.storeTimeoutMs,
        onTimeout: () => new IdempotencyVerifyTimeoutError(options.storeTimeoutMs),
        timing: resolveProbeTiming(ctx.runtime),
      });
    } catch (error) {
      safeLog(logger, 'warn', 'idempotency: the transactional store failed verification', {
        errorKind: errorKind(error),
      });
      throw error;
    }
    state = {
      store,
      ttlMs: options.ttlMs,
      storeTimeoutMs: options.storeTimeoutMs,
      maxResultBytes: options.maxResultBytes,
      purgeBatch: options.batch,
    };
    if (purgeScheduler === undefined) return;
    await purgeScheduler.every(purgeJobName, options.intervalMs, async () => {
      const active = state;
      if (active === undefined) return;
      await purgeOnce(active, logger, ctx.runtime);
    });
    scheduler = purgeScheduler;
  });

  return { state: () => state };
}
