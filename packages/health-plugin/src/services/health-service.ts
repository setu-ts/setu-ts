/**
 * Health service implementation.
 *
 * @module
 */
import type {
  HealthIndicatorFn,
  HealthReport,
  HealthStatus,
  IHealthService,
  IRuntimeServices,
} from '@hono-enterprise/common';

/**
 * Internal representation of a registered indicator.
 *
 * @since 0.20.0
 */
interface RegisteredIndicator {
  readonly name: string;
  readonly check: HealthIndicatorFn;
}

/**
 * Default implementation of {@linkcode IHealthService}.
 *
 * Manages indicator registration and aggregation for health checks.
 *
 * @since 0.20.0
 */
export class HealthService implements IHealthService {
  #indicators = new Map<string, RegisteredIndicator>();
  #runtime: IRuntimeServices;

  /**
   * Creates a new health service.
   *
   * @param runtime - Runtime services for time and diagnostics
   */
  constructor(runtime: IRuntimeServices) {
    this.#runtime = runtime;
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
    return this.#runAllIndicators();
  }

  /**
   * {@inheritDoc IHealthService.checkLive}
   *
   * Only runs the "self" indicator.
   */
  async checkLive(): Promise<HealthReport> {
    const selfIndicator = this.#indicators.get('self');
    if (!selfIndicator) {
      // Should never happen - self indicator is always registered
      return this.#emptyReport('up');
    }

    const startTime = this.#runtime.hrtime();
    const result = await selfIndicator.check();
    const latencyMs = this.#runtime.hrtime() - startTime;

    return {
      status: result.status,
      timestamp: new Date(this.#runtime.now()).toISOString(),
      checks: {
        [selfIndicator.name]: {
          ...result,
          latencyMs,
        },
      },
    };
  }

  /**
   * {@inheritDoc IHealthService.checkReady}
   *
   * Runs all indicators except "self".
   */
  checkReady(): Promise<HealthReport> {
    return this.#runContributedIndicators();
  }

  /**
   * Runs all registered indicators.
   */
  async #runAllIndicators(): Promise<HealthReport> {
    const checks: Record<string, Readonly<HealthCheckResultWithLatency>> = {};
    let worstStatus: HealthStatus = 'up';

    const entries = Array.from(this.#indicators.entries());

    for (const [, indicator] of entries) {
      const startTime = this.#runtime.hrtime();
      const result = await indicator.check();
      const latencyMs = this.#runtime.hrtime() - startTime;

      checks[indicator.name] = {
        ...result,
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
   * Runs all contributed indicators (excludes "self").
   */
  async #runContributedIndicators(): Promise<HealthReport> {
    const checks: Record<string, Readonly<HealthCheckResultWithLatency>> = {};
    let worstStatus: HealthStatus = 'up';

    for (const [name, indicator] of this.#indicators.entries()) {
      // Skip the self indicator for readiness
      if (name === 'self') {
        continue;
      }

      const startTime = this.#runtime.hrtime();
      const result = await indicator.check();
      const latencyMs = this.#runtime.hrtime() - startTime;

      checks[name] = {
        ...result,
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
   * Returns the worst (lowest) health status.
   *
   * Order: 'down' < 'degraded' < 'up'
   */
  #worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
    const rank: Record<HealthStatus, number> = {
      up: 2,
      degraded: 1,
      down: 0,
    };
    return rank[a] < rank[b] ? a : b;
  }

  /**
   * Returns an empty report with the given status.
   */
  #emptyReport(status: HealthStatus): HealthReport {
    return {
      status,
      timestamp: new Date(this.#runtime.now()).toISOString(),
      checks: {},
    };
  }
}

/**
 * Internal type for a health check result with latency.
 *
 * @since 0.20.0
 */
interface HealthCheckResultWithLatency {
  readonly status: HealthStatus;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
}
