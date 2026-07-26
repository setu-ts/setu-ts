/**
 * Shared upgrade-router storage — holds the {@linkcode WebSocketUpgradeRouter}
 * an adapter was given and answers the accept / reject / fall-through question
 * once, rather than four times across the four adapters (AI_GUIDELINES §11.1).
 *
 * @module
 * @since 0.2.0
 */

import type { WebSocketUpgradeDecision, WebSocketUpgradeRouter } from '@hono-enterprise/common';
import { isWebSocketUpgradeRequest } from './upgrade-detection.ts';

/**
 * Stores an adapter's upgrade router and consults it safely.
 *
 * @since 0.2.0
 */
export class UpgradeRouterStore {
  #router: WebSocketUpgradeRouter | null = null;

  /**
   * Installs the router. A later call replaces the previous one.
   *
   * @param router - The router to consult on upgrade requests
   */
  set(router: WebSocketUpgradeRouter): void {
    this.#router = router;
  }

  /** Whether a router has been installed. */
  get hasRouter(): boolean {
    return this.#router !== null;
  }

  /**
   * Asks the installed router what to do with a request.
   *
   * Returns `null` — meaning "fall through to normal HTTP handling" — when no
   * router is installed, when the request is not a WebSocket upgrade, or when
   * the router itself returns `null`.
   *
   * A router that throws is converted to a `500` rejection rather than being
   * allowed to escape: an application bug in route selection must not take
   * down the serve loop, and the socket has not been touched at this point so
   * refusing is always safe (AI_GUIDELINES §11.7).
   *
   * **The cause is deliberately discarded here, and a router is expected to
   * report its own failures.** This module runs inside the HTTP adapter, which
   * holds no logger and has no error channel to write to — so re-raising or
   * stashing the cause would only move the silence somewhere less useful. The
   * WebSocket plugin's router accordingly logs and returns its own `500`
   * before this backstop is ever reached; this `catch` exists for a
   * third-party router that does not.
   *
   * @param request - The native, undisturbed request
   * @returns The decision, or `null` to fall through
   */
  async consult(request: Request): Promise<WebSocketUpgradeDecision | null> {
    const router = this.#router;
    if (router === null || !isWebSocketUpgradeRequest(request.headers)) {
      return null;
    }

    try {
      return await router(request);
    } catch {
      return { accept: false, status: 500 };
    }
  }
}
