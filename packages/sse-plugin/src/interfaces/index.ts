/**
 * SSE plugin configuration options.
 *
 * @module
 * @since 0.1.0
 */

/**
 * Options for the SsePlugin.
 *
 * @since 0.1.0
 */
export interface SsePluginOptions {
  /**
   * Heartbeat interval in milliseconds. When set, the plugin schedules a
   * repeating `: heartbeat\n\n` comment frame. Omit to disable (no timer created).
   *
   * @since 0.1.0
   */
  readonly heartbeatMs?: number;
  /**
   * Reconnection time in milliseconds. When set, the first bytes on every new
   * stream are `retry: <ms>` advertising the reconnect delay. Omit to send no
   * `retry:` field.
   *
   * @since 0.1.0
   */
  readonly retryMs?: number;
  /**
   * Whether to log one `info` line at registration when no realtime backplane
   * is registered, stating that channels broadcast in-process only. Defaults to
   * `true`.
   *
   * Set `false` to silence it — appropriate when you have decided single-replica
   * fan-out is correct for this deployment and do not want the line on every
   * startup. It suppresses only the message: channel delivery is unaffected
   * either way, and the notice never appears once a backplane is registered.
   *
   * @since 0.2.0
   */
  readonly scalingNotice?: boolean;
}
