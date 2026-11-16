/**
 * The `vector-store` readiness indicator: the adapter's own reachability probe,
 * cached and time-bounded, so a replica whose vector backend stops answering
 * leaves readiness instead of answering 503 on every vector call.
 *
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthIndicatorFn,
  IRuntimeServices,
  IVectorStoreAdapter,
} from '@setu-ts/common';
import { createCachedProbe, resolveProbeTiming } from '@setu-ts/common';

/** How long one probe outcome is reused, so a readiness poller does not hit the backend per poll. */
export const PROBE_TTL_MS = 5_000;
/** How long one probe may take before it counts as unreachable. */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Builds the indicator.
 *
 * @param adapter - The registered adapter
 * @param runtime - Runtime services, for the probe's monotonic clock and timers
 * @param closed - Whether the application has closed the adapter
 * @returns The indicator: `down` once closed or when the probe fails, `up` with
 *   `reachable: 'unknown'` for an adapter without `isHealthy` or one that could
 *   not tell
 */
export function createVectorStoreIndicator(
  adapter: IVectorStoreAdapter,
  runtime: IRuntimeServices,
  closed: () => boolean,
): HealthIndicatorFn {
  const isHealthy = adapter.isHealthy;
  const probe =
    isHealthy === undefined
      ? undefined
      : createCachedProbe({
          probe: () => isHealthy.call(adapter),
          // A timeout or rejection is unreachable; only the adapter's own
          // `undefined` (it could not tell) leaves readiness alone.
          fallback: false as boolean | undefined,
          ttlMs: PROBE_TTL_MS,
          timeoutMs: PROBE_TIMEOUT_MS,
          ...resolveProbeTiming(runtime),
        });
  const closedResult = (): HealthCheckResult => ({
    status: 'down',
    data: { adapter: adapter.name, state: 'closed' },
  });
  return async (): Promise<HealthCheckResult> => {
    if (closed()) return closedResult();
    if (probe === undefined) {
      return { status: 'up', data: { adapter: adapter.name, reachable: 'unknown' } };
    }
    const reachable = await probe();
    // Shutdown can close the adapter while the probe is in flight.
    if (closed()) return closedResult();
    if (reachable === undefined) {
      return { status: 'up', data: { adapter: adapter.name, reachable: 'unknown' } };
    }
    return { status: reachable ? 'up' : 'down', data: { adapter: adapter.name, reachable } };
  };
}
