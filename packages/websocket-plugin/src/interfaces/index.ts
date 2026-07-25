/**
 * Public option types for the WebSocket plugin.
 *
 * @module
 * @since 0.1.0
 */

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
}
