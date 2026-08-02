/**
 * @module
 */
import type { ConfigPluginOptions } from '@hono-enterprise/config-plugin';
import type { LoggerPluginOptions } from '@hono-enterprise/logger-plugin';
import type { ValidationPluginOptions } from '@hono-enterprise/validation-plugin';
import type { HttpSecurityPluginOptions } from '@hono-enterprise/http-security-plugin';
import type { HealthPluginOptions } from '@hono-enterprise/health-plugin';
import type { MetricsPluginOptions } from '@hono-enterprise/metrics-plugin';
import type { OpenApiPluginOptions } from '@hono-enterprise/openapi-plugin';
import type { DecoratorPluginOptions } from '@hono-enterprise/decorator-plugin';
import type { DatabasePluginOptions } from '@hono-enterprise/database-plugin';
import type { AuthPluginOptions } from '@hono-enterprise/auth-plugin';
import type { DiPluginOptions } from '@hono-enterprise/di-plugin';
import type { WebSocketPluginOptions } from '@hono-enterprise/websocket-plugin';
import type { SsePluginOptions } from '@hono-enterprise/sse-plugin';
import type { RealtimeBackplanePluginOptions } from '@hono-enterprise/realtime-backplane-plugin';
import type { SessionPluginOptions } from '@hono-enterprise/session-plugin';

/**
 * The real-time arm: one option grouping the three plugins that together make a
 * connection-oriented application work, each added only when its sub-arm is
 * present.
 *
 * Grouped rather than flattened into three unrelated-looking top-level options
 * so the real-time story stays discoverable as a unit. `realtime: {}` adds
 * nothing and is not an error.
 *
 * @example Rooms fanned out across replicas
 * ```typescript
 * const app = createRestApp({
 *   realtime: {
 *     websocket: { routes: [] },
 *     backplane: { transport: 'redis', url: 'redis://localhost:6379' },
 *   },
 * });
 * ```
 * @see {@linkcode RestStarterOptions.realtime}
 */
export interface RealtimeArm {
  /**
   * Options for `WebSocketPlugin`. Present → the plugin is registered.
   *
   * On Node and Bun a WebSocket upgrade needs a real listening server, so the
   * plugin registers with `available: false` under `app.inject()`; the same
   * application code is correct on Deno and Cloudflare Workers.
   */
  websocket?: WebSocketPluginOptions;
  /** Options for `SsePlugin`. Present → the plugin is registered. */
  sse?: SsePluginOptions;
  /**
   * Options for `RealtimeBackplanePlugin`, which fans WebSocket rooms and SSE
   * channels out across replicas. Present → the plugin is registered at
   * `PLUGIN_PRIORITY.HIGH`, so it precedes both consumers.
   *
   * Absent → the WebSocket and SSE plugins emit their scaling notice, because
   * their broadcast membership stays in-process.
   *
   * `{}` selects the `'memory'` transport, whose discriminant is optional.
   * `{ transport: 'messaging' }` requires a `MessagingPlugin` in the same
   * application — the microservice and full-stack tiers supply one; on the REST
   * tier the backplane's own `register()` throws naming it.
   */
  backplane?: RealtimeBackplanePluginOptions;
}

/**
 * Options for {@linkcode createRestApp}. Per-plugin optional arms are threaded
 * straight through to each plugin factory. Omitted plugins use their default
 * configuration (no arguments required).
 *
 * @see {@linkcode RestStarterOptions}
 */
export interface RestStarterOptions {
  /**
   * Options for {@linkcode ConfigPlugin}. Omitted → defaults.
   */
  config?: ConfigPluginOptions;
  /**
   * Options for {@linkcode LoggerPlugin}. Omitted → defaults.
   */
  logger?: LoggerPluginOptions;
  /**
   * Options for {@linkcode ValidationPlugin}. Omitted → defaults.
   */
  validation?: ValidationPluginOptions;
  /**
   * Options for {@linkcode HttpSecurityPlugin}. Omitted → defaults.
   */
  httpSecurity?: HttpSecurityPluginOptions;
  /**
   * Options for {@linkcode HealthPlugin}. Omitted → defaults.
   */
  health?: HealthPluginOptions;
  /**
   * Options for {@linkcode MetricsPlugin}. Omitted → defaults.
   */
  metrics?: MetricsPluginOptions;
  /**
   * Options for {@linkcode OpenApiPlugin}. Omitted → defaults.
   */
  openapi?: OpenApiPluginOptions;
  /**
   * Options for {@linkcode DecoratorPlugin}. Omitted → defaults.
   */
  decorators?: DecoratorPluginOptions;
  /**
   * Optional arm: {@linkcode DatabasePlugin}. Provided only when the caller
   * supplies database credentials; omitted → database not registered.
   */
  database?: DatabasePluginOptions;
  /**
   * Optional arm: {@linkcode AuthPlugin}. Provided only when the caller supplies
   * auth configuration (jwt + rbac); omitted → auth not registered.
   */
  auth?: AuthPluginOptions;
  /**
   * Optional arm: the real-time plugins, one per sub-arm. Omitted → none of the
   * three is registered.
   *
   * @see {@linkcode RealtimeArm}
   */
  realtime?: RealtimeArm;
  /**
   * Optional arm: `SessionPlugin`. Omitted → the application has no cookie
   * session and no session-backed form CSRF.
   *
   * Gated because a session needs a secret nobody can default: the plugin
   * throws during `register()` without one, so an always-on arm would make
   * every starter application fail to boot until it supplied one. It is also
   * genuinely optional — a token-authenticated API has no use for cookies,
   * which is what `auth` covers.
   *
   * Setting `csrf` additionally registers the synchronizer-token middleware at
   * priority 275, which is the check a progressive-enhancement `<Form>` post
   * can satisfy — unlike the stateless Origin/Referer check that
   * `httpSecurity` performs, which a form structurally cannot. Running both is
   * intended.
   *
   * @example
   * ```typescript
   * const app = createRestApp({
   *   session: { secret: mySecret, csrf: {} },
   * });
   * ```
   */
  session?: SessionPluginOptions;
  /**
   * Optional arm: `DiPlugin`. Omitted → decorated services are constructed
   * directly and registered in the kernel's `ServiceRegistry`, which is the
   * default and needs no container.
   *
   * Supplying this arm **changes how every decorated service in the application
   * is constructed**: `DecoratorPlugin` branches on the presence of a container,
   * so with this arm each `@Injectable` class becomes a container provider that
   * honors its `scope`. That is why it is gated rather than always-on — the
   * default composition stays identical to a starter app without it.
   */
  di?: DiPluginOptions;
}
