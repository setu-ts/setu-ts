/**
 * The framework's health-status vocabulary and the ONE rule for trusting an
 * indicator's result. `HealthService` (the `/health` report) and the
 * observation collector (M98d) both read an indicator result through this
 * module, so the report and the observation cannot disagree about what a
 * valid result is.
 *
 * Not barrel-exported: internal to the package.
 *
 * @module
 * @internal
 */
import type { HealthCheckResult, HealthStatus } from '@setu-ts/common';

/** The framework's fixed health-status vocabulary. */
const HEALTH_STATUSES: ReadonlySet<unknown> = new Set<unknown>(['up', 'degraded', 'down']);

/**
 * Reports whether a value is one of the framework's own health statuses.
 * Anything else an indicator returned is untrusted application data.
 *
 * @param value - The candidate status
 * @returns `true` for `up`, `degraded`, or `down`
 * @internal
 */
export function isHealthStatus(value: unknown): value is HealthStatus {
  return HEALTH_STATUSES.has(value);
}

/**
 * Reads an indicator's settled result into the declared `HealthCheckResult`
 * shape, or reports that it is not one.
 *
 * `HealthCheckResult.status` is typed, but an indicator is application code
 * and TypeScript's type does not reach a JavaScript caller or a cast. A value
 * outside `up`/`degraded`/`down` has no severity rank, so aggregating it would
 * compare `undefined` and let it mask another indicator's `down` — `/health`
 * answered `200 degraded` with a check `down` before this existed — and
 * publishing it would echo arbitrary application data onto `/health`.
 *
 * `status` and `data` are each read exactly once; a throwing getter
 * propagates to the caller, which records the check as failed. A `data` value
 * that is not an object is omitted, since the contract types it as a record.
 *
 * @param raw - The value the indicator resolved with
 * @returns The projected result, or `null` when `raw` is not a framework
 *   result (not an object, or a `status` outside the vocabulary)
 * @internal
 */
export function normalizeIndicatorResult(raw: unknown): HealthCheckResult | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const { status, data } = raw as { readonly status?: unknown; readonly data?: unknown };
  if (!isHealthStatus(status)) {
    return null;
  }
  return data !== null && typeof data === 'object'
    ? { status, data: data as Readonly<Record<string, unknown>> }
    : { status };
}
