/**
 * Health plugin options and interfaces.
 *
 * @module
 */
import type { IHealthIndicator } from '@hono-enterprise/common';

/**
 * Options for configuring the health plugin endpoints.
 *
 * @since 0.20.0
 */
export interface EndpointsOptions {
  /**
   * Path for the overall health endpoint.
   *
   * Defaults to `'/health'`. Set to `undefined` to skip registration.
   */
  readonly health?: string;

  /**
   * Path for the liveness endpoint.
   *
   * Defaults to `'/live'`. Set to `undefined` to skip registration.
   */
  readonly live?: string;

  /**
   * Path for the readiness endpoint.
   *
   * Defaults to `'/ready'`. Set to `undefined` to skip registration.
   */
  readonly ready?: string;
}

/**
 * Options for configuring the health plugin.
 *
 * @since 0.20.0
 */
export interface HealthPluginOptions {
  /**
   * Endpoint path configuration.
   *
   * Defaults to `{ health: '/health', live: '/live', ready: '/ready' }`.
   */
  readonly endpoints?: EndpointsOptions;

  /**
   * Additional indicators to register at plugin registration time.
   *
   * These are registered before the `onInit` drain, so they are present
   * even if the lifecycle is bypassed. Defaults to `[]`.
   */
  readonly indicators?: readonly IHealthIndicator[];
}
