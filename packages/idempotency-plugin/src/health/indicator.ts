/**
 * The `idempotency` health indicator: lifecycle truth first, then a cached
 * store probe (plan §3.14).
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthIndicatorFn,
  IIdempotencyStore,
  IRuntimeServices,
} from '@setu-ts/common';
import { createCachedProbe, resolveProbeTiming } from '@setu-ts/common';

/** The plugin's lifecycle state. */
export type IdempotencyLifecycleState = 'pending' | 'connected' | 'closed';

/**
 * Builds the health indicator for a store.
 *
 * Lifecycle truth is reported first for EVERY store arm: a store that is not
 * `connected` is `down`. A store with no `isHealthy` reports `up` with
 * `reachable: 'unknown'`; otherwise a cached, time-bounded probe answers.
 *
 * @param store - The store
 * @param runtime - The runtime services (for the probe clock/timers)
 * @param lifecycle - A thunk returning the current lifecycle state
 * @returns The health indicator function
 * @since 0.9.0
 */
export function createIdempotencyIndicator(
  store: IIdempotencyStore,
  runtime: IRuntimeServices,
  lifecycle: () => IdempotencyLifecycleState,
): HealthIndicatorFn {
  const isHealthy = store.isHealthy;
  const probe = isHealthy === undefined ? undefined : createCachedProbe({
    probe: () => isHealthy.call(store),
    ttlMs: 5_000,
    timeoutMs: 2_000,
    ...resolveProbeTiming(runtime),
  });

  return async (): Promise<HealthCheckResult> => {
    const state = lifecycle();
    if (state !== 'connected') {
      return { status: 'down', data: { store: store.name, state } };
    }
    if (probe === undefined) {
      return { status: 'up', data: { store: store.name, reachable: 'unknown' } };
    }
    const reachable = await probe();
    return { status: reachable ? 'up' : 'down', data: { store: store.name, reachable } };
  };
}
