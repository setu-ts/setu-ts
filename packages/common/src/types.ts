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
 * Every value has a runtime implementation: `node`, `deno`, and `bun` bind a
 * socket through their HTTP adapter, while `cloudflare-workers` runs on the
 * adapter's `fetch` entry point without `listen`.
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

/**
 * A value `JSON.stringify` can serialize.
 *
 * Recursive: an array's elements and an object's property values are
 * themselves `JsonValue`s, so a nested payload is checked all the way down
 * rather than only at its top level.
 *
 * **The object arm admits `undefined` deliberately.** `JSON.stringify` drops a
 * property whose value is `undefined` rather than failing, so
 * `{ note: string | undefined }` — the shape an optional field takes once it is
 * written out — is serializable and is accepted here. What the type rejects is
 * the set `JSON.stringify` cannot represent: `bigint` (which throws), plus
 * functions and symbols (which it silently drops, losing data the caller
 * believed it was sending).
 *
 * **Three limits are worth knowing before you reach them, and none is
 * expressible in a type.** A circular structure throws at runtime; no type can
 * express acyclicity. A named `interface` is not assignable, because TypeScript
 * grants implicit index signatures only to object-literal types — declare the
 * payload with a `type` alias, or extend `Record<string, JsonValue |
 * undefined>`. And `NaN`, `Infinity` and `-Infinity` are members of `number`
 * that JSON has no representation for: `JSON.stringify` normalizes each of them
 * to `null` rather than failing, so the value is silently changed rather than
 * refused. TypeScript cannot exclude them from `number`, and a runtime check
 * would mean walking every payload on the hot path — send the number as a
 * string when the distinction matters.
 *
 * @example
 * ```typescript
 * const payload: JsonValue = { build: 412, tags: ['live'], note: undefined };
 * ```
 * @since 0.4.0
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };
