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
}
