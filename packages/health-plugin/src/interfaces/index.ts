/**
 * Health plugin options and interfaces.
 *
 * @module
 */
import type { IHealthIndicator, RegistryFactory } from '@setu-ts/common';

/**
 * The bounded, separately-controlled scheduled health collection (M98d).
 *
 * Absent by default: an omitted `scheduled` performs no scheduled work. When
 * present, it names a subset of the approved indicator names (the keys of
 * {@linkcode HealthDiagnosticsOptions.indicators}) and supplies a cadence, a
 * per-check reporting deadline, and a concurrency cap. A timeout here is a
 * REPORTING bound, not a cancellation: a check that has not settled within
 * `timeoutMs` is reported as `timed-out`, but its raw callback remains
 * in-flight until it actually settles, and no replacement check for it starts
 * before then.
 *
 * @since 0.8.0
 */
export interface HealthDiagnosticsScheduledOptions {
  /**
   * The approved indicator names to collect on a schedule. Each must be a key
   * of {@linkcode HealthDiagnosticsOptions.indicators}. At most 16 entries. A
   * name no indicator is registered under is skipped (it stays
   * `never-observed`), and the plugin logs a count-only warning at bootstrap.
   */
  readonly indicators: readonly string[];
  /**
   * The cadence between scheduled cycles, in milliseconds. `1,000`–`300,000`.
   */
  readonly intervalMs: number;
  /**
   * The per-check reporting deadline, in milliseconds. `1`–`30,000`. A check
   * that has not settled within the deadline is reported as `timed-out`; the
   * deadline does not cancel the underlying callback.
   */
  readonly timeoutMs: number;
  /**
   * The maximum number of scheduled callbacks running at once, `1`–`4`. A
   * timed-out callback that has not settled still occupies its slot, so a
   * hung indicator costs one slot and no more; the remaining slots keep
   * refreshing the other indicators. With as many hung callbacks as slots, no
   * scheduled check starts until one settles: each stalled alias keeps its
   * last observation with a growing `ageMs` (or stays `never-observed`), and
   * the snapshot's `state` turns `stale` once any retained observation ages
   * past `staleAfterMs`. Each cycle covers every scheduled indicator that is
   * not still in flight, rotating its starting point so no indicator is
   * starved.
   */
  readonly concurrency: number;
}

/**
 * The opt-in health-observation policy (M98d).
 *
 * Present only when the developer explicitly opts in to minimized health
 * observations. An omitted `diagnostics` option registers an inert, disabled
 * source and performs no capture. When present, the health plugin retains the
 * latest outcome per approved indicator alias (never a history) and, when
 * `scheduled` is present, performs bounded scheduled checks.
 *
 * Indicator names and topology are treated as sensitive: only the explicitly
 * allowlisted name-to-alias mapping is retained, aliases are unique and
 * bounded, and no indicator `data`, error text, or absolute time is ever
 * projected.
 *
 * @since 0.8.0
 */
export interface HealthDiagnosticsOptions {
  /**
   * The explicit opt-in, and deliberately the LITERAL `true` rather than a
   * `boolean`: this is an acknowledgement, not a toggle. An absent option is
   * the disabled path; `enabled: false` (or any value other than `true`) is
   * refused when `HealthPlugin(...)` is called, so a half-configured
   * composition fails loudly instead of silently opting in.
   */
  readonly enabled: true;
  /**
   * The exact registered indicator name to display-alias allowlist. At most
   * 64 entries. Each alias must be unique, `1`–`64` UTF-8 bytes, and contain
   * no control characters. An indicator whose registered name is not a key
   * here is never retained — its outcome is counted as dropped, not
   * projected. Every option is validated when `HealthPlugin(...)` is called,
   * with fixed messages that never echo a supplied value.
   */
  readonly indicators: Readonly<Record<string, string>>;
  /**
   * The snapshot's `state` is `stale` once any retained observation is older
   * than this many milliseconds, measured on the runtime's monotonic clock
   * from capture. An observation itself carries no `stale` state — only its
   * growing `ageMs`.
   *
   * @default 30000
   */
  readonly staleAfterMs?: number;
  /**
   * Optional bounded scheduled collection. Absent by default; when present it
   * must name a subset of the approved indicator names.
   */
  readonly scheduled?: HealthDiagnosticsScheduledOptions;
}

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

  /**
   * Deadline applied independently to every selected indicator, in
   * milliseconds (M90b). Must be a positive finite number; anything else —
   * zero, negative, `NaN`, `Infinity` — throws at plugin construction. The
   * identical check runs in the barrel-exported `HealthService` constructor,
   * so constructing the service directly cannot bypass it.
   *
   * An indicator that has not settled within the deadline is recorded as
   * `{ status: 'down', data: { reason: 'timeout' } }`; one that rejects is
   * recorded as `{ status: 'down', data: { reason: 'error' } }`. Either way
   * the report itself stays bounded, so a dead dependency can no longer
   * leave the whole endpoint pending.
   *
   * @default 5000
   * @since 0.5.0
   */
  readonly indicatorTimeoutMs?: number;

  /**
   * The opt-in health-observation policy (M98d). Absent by default: the
   * plugin registers an inert, disabled source under
   * `CAPABILITIES.HEALTH_DIAGNOSTICS` and performs no capture. When present,
   * the plugin retains the latest minimized outcome per approved indicator
   * alias and, when `scheduled` is present, performs bounded scheduled
   * checks. This never changes the `/health`, `/live`, or `/ready` behavior.
   *
   * @since 0.8.0
   */
  readonly diagnostics?: HealthDiagnosticsOptions;
}
