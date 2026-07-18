/**
 * Shared primitive types used across the framework.
 *
 * All enumerations are string literal unions, never TypeScript enums
 * (AI_GUIDELINES §5.5) — unions are tree-shakeable and structurally typed.
 *
 * @module
 */

/**
 * HTTP request methods supported by the router.
 *
 * @since 0.1.0
 */
export type HttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS';

/**
 * JavaScript runtimes the framework can execute on.
 *
 * `cloudflare-workers` is reserved for the planned edge adapter.
 *
 * @since 0.1.0
 */
export type RuntimePlatform = 'node' | 'deno' | 'bun' | 'cloudflare-workers';

/**
 * Log severity levels, ordered from most to least severe.
 *
 * @since 0.1.0
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Application lifecycle phases, in execution order.
 *
 * See `ILifecycleApi` for the hooks that fire in each phase.
 *
 * @since 0.1.0
 */
export type LifecyclePhase =
  | 'register'
  | 'init'
  | 'bootstrap'
  | 'active'
  | 'shutdown'
  | 'close';

/**
 * Health state reported by a health indicator.
 *
 * @since 0.1.0
 */
export type HealthStatus = 'up' | 'down' | 'degraded';

/**
 * Metric instrument kinds supported by the metrics capability.
 *
 * @since 0.1.0
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

/**
 * Well-known plugin registration priorities. Lower numbers register first.
 *
 * Any number is a valid priority; these constants mark the conventional
 * bands so plugins order themselves predictably relative to first-party
 * middleware (see ARCHITECTURE.md §10 for the middleware priority table).
 *
 * @since 0.1.0
 */
export const PLUGIN_PRIORITY = {
  /** Runtime and other must-run-first infrastructure. */
  HIGHEST: 0,
  /** Logging, configuration — capabilities most plugins consume. */
  HIGH: 100,
  /** Default band for ordinary capability plugins. */
  NORMAL: 500,
  /** OpenAPI plugin — generates spec after routes are registered. */
  OPENAPI: 700,
  /** Plugins that want most capabilities available before they register. */
  LOW: 900,
  /** Observers that must register after everything else. */
  LOWEST: 1000,
} as const;

/**
 * Union of the well-known priority values in {@linkcode PLUGIN_PRIORITY}.
 *
 * @since 0.1.0
 */
export type PluginPriority = (typeof PLUGIN_PRIORITY)[keyof typeof PLUGIN_PRIORITY];
