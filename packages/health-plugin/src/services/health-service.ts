/**
 * Health service implementation.
 *
 * @module
 */
import type {
  HealthCheckResult,
  HealthIndicatorFn,
  HealthObservationState,
  HealthReport,
  HealthStatus,
  IHealthService,
  IRuntimeServices,
} from '@setu-ts/common';
import type { HealthObservationCollector } from '../diagnostics/health-observation-collector.ts';

/**
 * The observation-collector attachment seam (M98d). A service is mapped to
 * the single collector that its runner reports to. Kept in a WeakMap so an
 * unattached service retains nothing and a discarded service is collected.
 * Not barrel-exported: the collector is internal to the package.
 *
 * @internal
 */
const OBSERVATION_COLLECTORS = new WeakMap<object, HealthObservationCollector>();

/**
 * Attaches the health-observation collector to a service so the service's
 * runner reports each settled indicator to it. A no-op for the public report
 * and route behavior: observation follows the authoritative evaluation and
 * never re-invokes an indicator.
 *
 * @param service - The health service to attach to
 * @param collector - The collector to report to
 * @internal
 */
export function attachHealthObservation(
  service: HealthService,
  collector: HealthObservationCollector,
): void {
  OBSERVATION_COLLECTORS.set(service, collector);
}

/** Set by `HealthService`'s static block; see {@linkcode runIndicatorRaw}. */
let rawRunner: (service: HealthService, name: string) => Promise<HealthCheckResult> | null;

/**
 * Runs one indicator by its registered name, returning the RAW result
 * promise with no deadline applied, or `null` when no indicator is
 * registered under the name (M98d). The health-observation scheduler
 * consumes this: it races the returned promise against its own reporting
 * deadline and holds the name's in-flight slot until the promise settles.
 *
 * Deliberately a module function rather than a method: the exported
 * `HealthService` class gains no public surface, and the barrel does not
 * export this. The scheduler reads only the framework-owned `status` of the
 * result — never its `data`, never a thrown value.
 *
 * @param service - The health service owning the indicator
 * @param name - The registered indicator name
 * @returns The raw result promise, or `null` for an unregistered name
 * @internal
 */
export function runIndicatorRaw(
  service: HealthService,
  name: string,
): Promise<HealthCheckResult> | null {
  return rawRunner(service, name);
}

/** Set by `HealthService`'s static block; see {@linkcode isIndicatorRegistered}. */
let registeredProbe: (service: HealthService, name: string) => boolean;

/**
 * Reports whether an indicator is registered under the name, without running
 * it (M98d). The plugin uses it at `onBootstrap` to warn about an approved
 * diagnostics name that no indicator carries. Not barrel-exported.
 *
 * @param service - The health service
 * @param name - The indicator name
 * @returns `true` when an indicator is registered under `name`
 * @internal
 */
export function isIndicatorRegistered(service: HealthService, name: string): boolean {
  return registeredProbe(service, name);
}

/**
 * Internal representation of a registered indicator.
 *
 * @since 0.2.0
 */
interface RegisteredIndicator {
  readonly name: string;
  readonly check: HealthIndicatorFn;
}

/**
 * The tagged outcome of racing one indicator against the deadline (M98d).
 * `reported` carries the indicator's own result; `timed-out` is the fixed
 * deadline outcome. A rejection is still surfaced as a rejection, as before.
 *
 * @internal
 */
type DeadlineOutcome =
  | { readonly kind: 'reported'; readonly result: HealthCheckResult }
  | { readonly kind: 'timed-out' };

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

  static {
    // The raw-runner seam (M98d), wired from inside the class body so it can
    // read the private indicator map without exposing a public method on
    // this barrel-exported class.
    rawRunner = (service, name) => {
      const indicator = service.#indicators.get(name);
      return indicator === undefined ? null : Promise.resolve().then(indicator.check);
    };
    registeredProbe = (service, name) => service.#indicators.has(name);
  }

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
        let observationState: HealthObservationState;
        try {
          const outcome = await this.#withDeadline(indicator.check);
          if (outcome.kind === 'reported') {
            result = outcome.result;
            observationState = 'reported';
          } else {
            result = { status: 'down', data: { reason: 'timeout' } };
            observationState = 'timed-out';
          }
        } catch {
          // A rejecting indicator is a failing check, not a failed report.
          // The thrown value is deliberately NOT serialized — it may carry
          // driver diagnostics (X12-3 stays closed) — and the report must
          // not depend on what a third-party indicator threw.
          result = { status: 'down', data: { reason: 'error' } };
          observationState = 'failed';
        }
        const latencyMs = this.#runtime.hrtime() - startTime;
        // Observation follows the authoritative evaluation: report the
        // already-computed outcome once, never re-invoking the indicator.
        this.#observe(name, observationState, result, latencyMs);
        return [name, result, latencyMs] as const;
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
  #withDeadline(check: HealthIndicatorFn): Promise<DeadlineOutcome> {
    return new Promise<DeadlineOutcome>((resolve, reject) => {
      const handle = this.#runtime.setTimeout(
        () => resolve({ kind: 'timed-out' }),
        this.#indicatorTimeoutMs,
      );
      Promise.resolve()
        .then(check)
        .then(
          (result) => {
            this.#runtime.clearTimeout(handle);
            resolve({ kind: 'reported', result });
          },
          (error: unknown) => {
            this.#runtime.clearTimeout(handle);
            reject(error);
          },
        );
    });
  }

  /**
   * Reports one settled indicator to the attached observation collector, if
   * any. Guarded: an observer failure must never change the report. The
   * collector reads only the framework-owned status (only when reported), the
   * fixed observation state, and the measured latency — never `result.data`
   * or any thrown value.
   */
  #observe(
    name: string,
    state: HealthObservationState,
    result: HealthCheckResult,
    latencyMs: number,
  ): void {
    const collector = OBSERVATION_COLLECTORS.get(this);
    if (collector === undefined) {
      return;
    }
    try {
      collector.report(
        name,
        {
          state,
          ...(state === 'reported' ? { status: result.status } : {}),
          latencyMs,
        },
        'application',
      );
    } catch {
      // A collector fault is dropped, not surfaced: observation must never
      // change the public report or route behavior.
    }
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
