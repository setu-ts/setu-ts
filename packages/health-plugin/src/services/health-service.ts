/**
 * Health service implementation.
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthIndicatorFn,
  HealthReport,
  HealthStatus,
  IHealthService,
  IRuntimeServices,
} from '@setu-ts/common';

/**
 * Internal representation of a registered indicator.
 *
 * @since 0.2.0
 */
interface RegisteredIndicator {
  readonly name: string;
  readonly check: HealthIndicatorFn;
}

/** Severity ranking used to compute the worst status. Lower is worse. */
const STATUS_RANK: Readonly<Record<HealthStatus, number>> = {
  up: 2,
  degraded: 1,
  down: 0,
};

/** Default per-indicator deadline when none is configured (M90b), in ms. */
const DEFAULT_INDICATOR_TIMEOUT_MS = 5000;

/**
 * Validates the per-indicator deadline (M90b).
 *
 * Lives here, beside the only reader of the value, because there are TWO
 * entry points to it — `HealthPlugin({ indicatorTimeoutMs })` and direct
 * `new HealthService(runtime, { indicatorTimeoutMs })`, which is barrel-
 * exported — and both must honour the same rule. A plugin-side check alone
 * left the exported class storing `0`, a negative, `NaN` or `Infinity` and
 * passing it to `IRuntimeServices.setTimeout`: a non-positive deadline
 * times an unsettled indicator out on the next timer turn, and a non-finite
 * one is not the documented positive finite bound at all.
 *
 * Not barrel-exported — internal to the package.
 *
 * @param raw - The configured value, or `undefined` for the default
 * @returns The validated deadline in milliseconds
 * @throws {Error} When the value is not a positive finite number
 * @internal
 */
export function resolveIndicatorTimeout(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_INDICATOR_TIMEOUT_MS;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `indicatorTimeoutMs must be a positive finite number of milliseconds, received ${
        String(raw)
      }`,
    );
  }
  return raw;
}

/**
 * Default implementation of {@linkcode IHealthService}.
 *
 * Manages indicator registration and aggregation for health checks.
 *
 * M90b: selected indicators run CONCURRENTLY, each raced against a
 * runtime-owned deadline (`indicatorTimeoutMs`, default 5,000). Sequential
 * awaiting multiplied outage latency — a 2-second outage across six
 * dependency indicators took 12+ seconds, the measured X29-2 `/health` —
 * and one never-settling indicator left the whole endpoint pending
 * forever. A timeout is recorded as `{ status: 'down', data: { reason:
 * 'timeout' } }`, a rejection as `{ status: 'down', data: { reason:
 * 'error' } }` with the thrown value never serialized into the report;
 * each indicator's latency is measured individually; and `checks` is
 * assembled in registration order so the report's shape is stable even
 * though execution is not.
 *
 * @since 0.2.0
 */
export class HealthService implements IHealthService {
  #indicators = new Map<string, RegisteredIndicator>();
  #runtime: IRuntimeServices;
  readonly #indicatorTimeoutMs: number;

  /**
   * Creates a new health service.
   *
   * @param runtime - Runtime services for time and diagnostics
   * @param options - Aggregation options
   * @param options.indicatorTimeoutMs - Per-indicator deadline in ms
   *   (default 5,000). Must be a positive finite number.
   * @throws {Error} When `indicatorTimeoutMs` is not a positive finite number
   */
  constructor(runtime: IRuntimeServices, options?: { indicatorTimeoutMs?: number }) {
    this.#runtime = runtime;
    // Validated HERE, not only in `HealthPlugin`: this class is barrel-
    // exported, so a caller can construct it directly and bypass the
    // plugin's check entirely.
    this.#indicatorTimeoutMs = resolveIndicatorTimeout(options?.indicatorTimeoutMs);
  }

  /**
   * {@inheritDoc IHealthService.registerIndicator}
   *
   * @throws {Error} If an indicator with the same name is already registered
   */
  registerIndicator(name: string, indicator: HealthIndicatorFn): void {
    if (this.#indicators.has(name)) {
      throw new Error(`Duplicate health indicator name: "${name}"`);
    }
    this.#indicators.set(name, { name, check: indicator });
  }

  /**
   * {@inheritDoc IHealthService.check}
   */
  check(): Promise<HealthReport> {
    return this.#runIndicators(() => true);
  }

  /**
   * {@inheritDoc IHealthService.checkLive}
   *
   * Only runs the "self" indicator.
   */
  checkLive(): Promise<HealthReport> {
    return this.#runIndicators((name) => name === 'self');
  }

  /**
   * {@inheritDoc IHealthService.checkReady}
   *
   * Runs all indicators except "self".
   */
  checkReady(): Promise<HealthReport> {
    return this.#runIndicators((name) => name !== 'self');
  }

  /**
   * Runs indicators filtered by the provided predicate — concurrently, and
   * deadline-bounded per indicator.
   */
  async #runIndicators(filter: (name: string) => boolean): Promise<HealthReport> {
    const selected = [...this.#indicators.entries()].filter(([name]) => filter(name));

    const settled = await Promise.all(
      selected.map(async ([name, indicator]) => {
        const startTime = this.#runtime.hrtime();
        let result: HealthCheckResult;
        try {
          result = await this.#withDeadline(indicator.check);
        } catch {
          // A rejecting indicator is a failing check, not a failed report.
          // The thrown value is deliberately NOT serialized — it may carry
          // driver diagnostics (X12-3 stays closed) — and the report must
          // not depend on what a third-party indicator threw.
          result = { status: 'down', data: { reason: 'error' } };
        }
        return [name, result, this.#runtime.hrtime() - startTime] as const;
      }),
    );

    const checks: Record<string, Readonly<HealthCheckResult & { latencyMs?: number }>> = {};
    let worstStatus: HealthStatus = 'up';

    // `settled` preserves registration order (Map iteration order), so the
    // report's key order is stable even though execution ran concurrently.
    for (const [name, result, latencyMs] of settled) {
      // Project to the declared `HealthCheckResult` shape: `status` and
      // `data` (when present). Anything else an indicator returns — a typo'd
      // field, a caller-supplied `latencyMs` — is dropped, not published on
      // `/health`. `exactOptionalPropertyTypes` is on, so `data` is spread
      // conditionally rather than assigned `undefined`.
      checks[name] = {
        status: result.status,
        ...(result.data !== undefined && { data: result.data }),
        latencyMs,
      };

      worstStatus = this.#worstStatus(worstStatus, result.status);
    }

    return {
      status: worstStatus,
      timestamp: new Date(this.#runtime.now()).toISOString(),
      checks,
    };
  }

  /**
   * Races one indicator against the runtime-owned deadline (M90b).
   *
   * The timer is created on `IRuntimeServices` so a custom runtime's timers
   * are honoured, and cleared on either settle path so no handle leaks per
   * report. The losing branch never runs its resolve after the winner
   * settled — a `Promise` settles once — and a deadline hit resolves
   * `down`/`timeout` rather than rejecting, so the caller treats it as a
   * recorded outcome, not an exception. The invocation is deferred through
   * `Promise.resolve().then(check)` — the exact shape of `createCachedProbe`'s
   * `runProbe` — so an indicator that throws SYNCHRONOUSLY becomes a
   * rejection on the microtask queue and can never skip the clear.
   *
   * @param check - The indicator to run
   * @returns The indicator's outcome, or the timeout outcome
   */
  #withDeadline(check: HealthIndicatorFn): Promise<HealthCheckResult> {
    return new Promise<HealthCheckResult>((resolve, reject) => {
      const handle = this.#runtime.setTimeout(
        () => resolve({ status: 'down', data: { reason: 'timeout' } }),
        this.#indicatorTimeoutMs,
      );
      Promise.resolve()
        .then(check)
        .then(
          (result) => {
            this.#runtime.clearTimeout(handle);
            resolve(result);
          },
          (error: unknown) => {
            this.#runtime.clearTimeout(handle);
            reject(error);
          },
        );
    });
  }

  /**
   * Returns the worst (lowest) health status.
   *
   * Order: 'down' < 'degraded' < 'up'
   */
  #worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
    return STATUS_RANK[a] < STATUS_RANK[b] ? a : b;
  }
}
