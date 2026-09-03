/**
 * Public option types for the WebSocket plugin.
 *
 * @module
 * @since 0.1.0
 */

import type {
  IIngressBehavior,
  RegistryFactory,
  WebSocketHandlers,
  WebSocketRouteOptions,
} from '@setu-ts/common';

/**
 * Configuration for {@linkcode WebSocketPlugin}.
 *
 * Every option defaults to the inert value, so `WebSocketPlugin()` with no
 * arguments enables no limits and no timers.
 *
 * @since 0.1.0
 */
export interface WebSocketPluginOptions {
  /**
   * Maximum number of simultaneously open connections across all routes.
   * `0` (the default) means unlimited. At the limit, further upgrade requests
   * are refused with HTTP 503 before any socket is created.
   */
  readonly maxConnections?: number;
  /**
   * Interval in milliseconds at which {@linkcode WebSocketPluginOptions.heartbeatPayload}
   * is sent to every open connection. `0` (the default) disables the heartbeat
   * entirely and creates no timer.
   *
   * The heartbeat is an application-level message, not an RFC 6455 ping frame:
   * the web `WebSocket` API exposed by Deno and Cloudflare Workers has no
   * `ping()`, so a protocol ping would silently no-op on half the supported
   * runtimes.
   */
  readonly heartbeatMs?: number;
  /**
   * The text frame sent on each heartbeat tick. Defaults to `'ping'`. Read only
   * when {@linkcode WebSocketPluginOptions.heartbeatMs} is above `0`.
   */
  readonly heartbeatPayload?: string;
  /**
   * Milliseconds of inbound silence after which a connection is closed with
   * code `1001`. `0` (the default) disables idle closing.
   *
   * Requires {@linkcode WebSocketPluginOptions.heartbeatMs} above `0`, since the
   * heartbeat tick is what performs the sweep. Configuring an idle timeout
   * without a heartbeat throws at registration rather than silently doing
   * nothing.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Maximum size in bytes of a single inbound frame. `0` (the default) means
   * unlimited. A larger frame closes the connection with code `1009`
   * (message too big) and is never delivered to `onMessage`.
   */
  readonly maxMessageBytes?: number;
  /**
   * Whether to log one `info` line at registration when no realtime backplane
   * is registered, stating that rooms broadcast in-process only. Defaults to
   * `true`.
   *
   * Set `false` to silence it — appropriate when you have decided single-replica
   * fan-out is correct for this deployment and do not want the line on every
   * startup. It suppresses only the message: room delivery is unaffected either
   * way, and the notice never appears once a backplane is registered.
   *
   * @since 0.2.0
   */
  readonly scalingNotice?: boolean;
  /**
   * Routes registered declaratively, as an alternative to calling
   * `service.route(...)` imperatively after `start()`. Each entry — instance
   * or `RegistryFactory` — produces one `route()` call, so a route can be
   * declared where the plugin is composed instead of after the application
   * has started.
   *
   * Instance entries register during the plugin's `register()` phase,
   * identical to the imperative timing. Factory entries are resolved in the
   * `onInit` phase — the first at which the registry holds every capability —
   * so a factory can build its handlers from a resolved capability. A factory
   * that throws rejects `start()` with an error naming
   * `WebSocketPlugin({ routes })` and the entry's index in THIS declared
   * array, not its position among the factories.
   *
   * Duplicate paths throw exactly as two imperative `route()` calls with the
   * same path would.
   *
   * @since 0.3.0
   */
  readonly routes?: readonly WebSocketRouteEntry[];
  /**
   * Plugin-level ingress behaviours wrapped around every route's `onMessage`
   * — the WebSocket arm of the transport-neutral behaviour chain shared with
   * the queue, scheduler, and messaging plugins (`IIngressBehavior` in
   * `@setu-ts/common`).
   *
   * Each behaviour observes an `IngressContext` carrying `kind: 'websocket'`,
   * the route path as `name`, and the frame as `payload`, and runs in declared
   * order ahead of the handler. A behaviour that returns without calling
   * `next()` short-circuits: the handler never sees the frame. A behaviour
   * that throws is routed to the route's `onError`, exactly as a failing
   * handler is. Behaviours are plugin-level by design; there is no
   * route-level `behaviors` arm (guards are the per-route mechanism).
   *
   * Configuring a behaviour makes the dispatch result promise-mediated while
   * preserving immediate execution for entirely synchronous behaviours. A
   * behaviour that defers `next()` delays the wrapped handler. With no
   * behaviours configured, dispatch is byte-identical to the pre-chain
   * behaviour: a direct, synchronous invoke.
   *
   * No startup gate is needed here, unlike the queue, scheduler, and
   * messaging arms: a frame cannot arrive before its socket is open, and the
   * application does not serve until after `onInit` has resolved the chain.
   *
   * Instance entries are handed to the service at `register()`; factory
   * entries are resolved in the `onInit` phase and a throwing factory rejects
   * `start()` naming `WebSocketPlugin({ behaviors })` and the entry's index
   * in THIS declared array.
   *
   * @since 0.3.0
   */
  readonly behaviors?: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[];
}

/**
 * The declarative form of one `IWebSocketService.route()` call — the entry
 * an application writes instead of calling `route()` imperatively after
 * `start()`.
 *
 * @since 0.3.0
 */
export interface WebSocketRouteDefinition {
  /** The exact URL path to accept upgrades on (e.g. `/ws/chat`). */
  readonly path: string;
  /** The lifecycle callbacks, exactly as the imperative `route()` accepts. */
  readonly handlers: WebSocketHandlers;
  /** Per-route configuration, including the route's upgrade guards. */
  readonly options?: WebSocketRouteOptions;
}

/**
 * One entry of {@linkcode WebSocketPluginOptions.routes}: a route definition,
 * or a {@linkcode RegistryFactory} producing one when the handlers need a
 * resolved capability.
 *
 * @since 0.3.0
 */
export type WebSocketRouteEntry =
  | WebSocketRouteDefinition
  | RegistryFactory<WebSocketRouteDefinition>;
