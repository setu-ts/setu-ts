/**
 * Health plugin options and interfaces.
 *
 * @module
 */
import type { IHealthIndicator, RegistryFactory } from '@setu-ts/common';

/**
 * Options for configuring the health plugin endpoints.
 *
 * @since 0.2.0
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
 * One entry of {@linkcode HealthPluginOptions.indicators}: either a ready
 * indicator instance or a factory that builds one from the service registry.
 *
 * The factory arm exists because a health indicator often exists to probe a
 * capability — the database, the broker — that the `IHealthIndicator`
 * contract's argument-less `check()` cannot reach. The factory is called at
 * the `onInit` phase, after every plugin has registered, so the capability
 * it resolves is present regardless of plugin priority.
 *
 * Named (rather than inlining the union) because the CLI's generated
 * `src/health/index.ts` declares its array with this element type, and the
 * renderer does not add the parentheses an inline union would need.
 *
 * @since 0.1.0
 */
export type HealthIndicatorEntry = IHealthIndicator | RegistryFactory<IHealthIndicator>;

/**
 * Options for configuring the health plugin.
 *
 * @since 0.2.0
 */
export interface HealthPluginOptions {
  /**
   * Endpoint path configuration.
   *
   * Defaults to `{ health: '/health', live: '/live', ready: '/ready' }`.
   */
  readonly endpoints?: EndpointsOptions;

  /**
   * Additional indicators to register.
   *
   * An instance entry is registered during `register()`, unchanged from the
   * pre-factory behaviour. A factory entry is resolved and registered at the
   * start of the `onInit` phase — before the `CAPABILITIES.HEALTH_INDICATOR`
   * contribution drain — so it can resolve a capability registered by a
   * plugin that registers after this one. A factory that throws rejects
   * `start()`, naming the option and the entry.
   *
   * Defaults to `[]`.
   */
  readonly indicators?: readonly HealthIndicatorEntry[];
}
