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
  ConnectionErrorReporter,
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
 * @param reporter - Logs probe failure and recovery through the owning plugin
 * @returns The indicator: `down` once closed or when the probe fails, `up` with
 *   `reachable: 'unknown'` for an adapter without `isHealthy` or one that could
 *   not tell
 */
export function createVectorStoreIndicator(
  adapter: IVectorStoreAdapter,
  runtime: IRuntimeServices,
  closed: () => boolean,
  reporter?: ConnectionErrorReporter,
): HealthIndicatorFn {
  const isHealthy = adapter.isHealthy;
  const timing = resolveProbeTiming(runtime);
  let expireProbe: (() => void) | undefined;
  const reportedProbe = (): Promise<boolean | undefined> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean | undefined, report: () => void): void => {
        if (settled) return;
        settled = true;
        expireProbe = undefined;
        timing.clearTimer(timer);
        report();
        resolve(value);
      };
      const expire = (): void =>
        finish(false, () =>
          reporter?.report(new Error(`did not answer within ${PROBE_TIMEOUT_MS} ms`)),
        );
      expireProbe = expire;
      const timer = timing.setTimer(expire, PROBE_TIMEOUT_MS);
      Promise.resolve()
        .then(() => isHealthy!.call(adapter))
        .then(
          (value) =>
            finish(value, () => {
              if (value === false) reporter?.report(new Error('reported unreachable'));
              else if (value === true) reporter?.recovered();
            }),
          (error: unknown) => finish(false, () => reporter?.report(error)),
        );
    });
  const probe =
    isHealthy === undefined
      ? undefined
      : createCachedProbe({
          probe: reportedProbe,
          // A timeout or rejection is unreachable; only the adapter's own
          // `undefined` (it could not tell) leaves readiness alone.
          fallback: false as boolean | undefined,
          ttlMs: PROBE_TTL_MS,
          timeoutMs: PROBE_TIMEOUT_MS,
          ...timing,
          // The cache arms its timer first. It must settle this wrapper too,
          // so a driver response between the two timer callbacks stays late.
          setTimer: (callback, ms) =>
            timing.setTimer(() => {
              expireProbe?.();
              callback();
            }, ms),
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
