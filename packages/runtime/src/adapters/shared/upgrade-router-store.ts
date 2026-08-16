/**
 * Shared upgrade-router storage — holds the {@linkcode WebSocketUpgradeRouter}
 * an adapter was given.
 *
 * Since M70a the router is no longer consulted here. The kernel terminal
 * handler runs the middleware pipeline first and resolves the upgrade decision
 * itself from `IWebSocketService`, then brands the request with the intent for
 * the adapter to act on. What the adapter still needs from the router is the
 * bare fact that one was installed: Node attaches its raw `upgrade` listener
 * only then, so a plain HTTP application never loads `ws`.
 *
 * @module
 * @since 0.2.0
 */

import type { WebSocketUpgradeRouter } from '@setu-ts/common';

/**
 * Stores an adapter's upgrade router.
 *
 * @since 0.2.0
 */
export class UpgradeRouterStore {
  #router: WebSocketUpgradeRouter | null = null;

  /**
   * Installs the router. A later call replaces the previous one.
   *
   * @param router - The router the WebSocket plugin handed to the adapter
   */
  set(router: WebSocketUpgradeRouter): void {
    this.#router = router;
  }

  /** Whether a router has been installed. */
  get hasRouter(): boolean {
    return this.#router !== null;
  }
}
