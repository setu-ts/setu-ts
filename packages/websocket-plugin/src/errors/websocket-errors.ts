/**
 * WebSocket plugin errors.
 *
 * @module
 * @since 0.1.0
 */

/**
 * Thrown when a WebSocket route is registered but the application's HTTP
 * adapter provides no upgrade seam, so no handshake could ever succeed.
 *
 * This happens on a custom third-party {@linkcode IHttpAdapter} that predates
 * the `setUpgradeRouter` seam. First-party adapters for Node, Deno, Bun, and
 * Cloudflare Workers all implement it.
 *
 * The plugin still registers its service and health indicator in this state, so
 * one codebase deploys everywhere; the failure surfaces at `route()` —
 * registration time — rather than silently at first connect.
 *
 * @example
 * ```typescript
 * try {
 *   ws.route('/ws', handlers);
 * } catch (err) {
 *   if (err instanceof WebSocketUnavailableError) {
 *     logger.warn('WebSockets unavailable on this adapter');
 *   }
 * }
 * ```
 * @since 0.1.0
 */
export class WebSocketUnavailableError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Optional override for the default explanation
   */
  constructor(message?: string) {
    super(
      message ??
        'WebSocket upgrades are unavailable: the registered HTTP adapter does not ' +
          'implement setUpgradeRouter(). The first-party Node, Deno, Bun, and ' +
          'Cloudflare Workers adapters all support it.',
    );
    this.name = 'WebSocketUnavailableError';
  }
}
