/**
 * Health check contracts, consumed by the HealthPlugin.
 *
 * @module
 */
import type { HealthStatus } from '../types.ts';

/**
 * The outcome of one health check.
 *
 * @since 0.1.0
 */
export interface HealthCheckResult {
  /** The reported health state. */
  readonly status: HealthStatus;
  /** Optional diagnostic details (response times, versions, …). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Function form of a health indicator.
 *
 * @returns The health check result
 * @since 0.1.0
 */
export type HealthIndicatorFn = () => Promise<HealthCheckResult>;

/**
 * A named health indicator contributing to `/health`, `/live`, and
 * `/ready`.
 *
 * @example
 * ```typescript
 * const dbIndicator: IHealthIndicator = {
 *   name: 'database',
 *   async check() {
 *     const healthy = await db.ping();
 *     return { status: healthy ? 'up' : 'down' };
 *   },
 * };
 * ```
 * @since 0.1.0
 */
export interface IHealthIndicator {
  /** Indicator name, unique per application. */
  readonly name: string;
  /**
   * Performs the health check.
   *
   * @returns The health check result
   */
  check(): Promise<HealthCheckResult>;
}

/**
 * The aggregated health report returned by {@linkcode IHealthService.check()}.
 *
 * @since 0.20.0
 */
export interface HealthReport {
  /** Overall health status (worst of all participating indicators). */
  readonly status: HealthStatus;
  /** ISO 8601 timestamp of when the check was performed. */
  readonly timestamp: string;
  /** Per-indicator results with optional latency measurements. */
  readonly checks: Readonly<
    Record<string, Readonly<HealthCheckResult & { readonly latencyMs?: number }>>
  >;
}

/**
 * Health service contract for registering and checking health indicators.
 *
 * Resolved via {@linkcode CAPABILITIES.HEALTH} (`'health'`).
 *
 * @example
 * ```typescript
 * const health = ctx.services.get<IHealthService>('health');
 * health.registerIndicator('custom', async () => ({ status: 'up' }));
 * const report = await health.check();
 * ```
 *
 * @since 0.20.0
 */
export interface IHealthService {
  /**
   * Registers a health indicator.
   *
   * @param name - Indicator name (must be unique; throws on duplicate)
   * @param indicator - Health check function
   * @throws {Error} If an indicator with the same name is already registered
   */
  registerIndicator(name: string, indicator: HealthIndicatorFn): void;

  /**
   * Runs all registered indicators and returns the aggregated report.
   *
   * @returns The full health report
   */
  check(): Promise<HealthReport>;

  /**
   * Runs only the liveness indicator (the built-in "self" indicator).
   *
   * @returns The liveness report
   */
  checkLive(): Promise<HealthReport>;

  /**
   * Runs all contributed indicators for readiness.
   *
   * @returns The readiness report
   */
  checkReady(): Promise<HealthReport>;
}
