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
