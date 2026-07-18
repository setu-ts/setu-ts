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
   * Runs indicators filtered by the provided predicate.
   */
  async #runIndicators(filter: (name: string) => boolean): Promise<HealthReport> {
    const checks: Record<string, Readonly<HealthCheckResult & { latencyMs?: number }>> = {};
    let worstStatus: HealthStatus = 'up';

    for (const [name, indicator] of this.#indicators.entries()) {
      if (!filter(name)) {
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
}
