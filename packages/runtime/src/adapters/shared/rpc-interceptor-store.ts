/**
 * Shared RPC interceptor storage — holds the {@linkcode RpcFetchHandler} an
 * adapter was given and answers the consult call, returning a {@linkcode Response}
 * if the handler processed the request or {@linkcode null} to fall through to
 * normal Hono handling.
 *
 * Mirrors the {@linkcode UpgradeRouterStore} holder half, but without a protocol
 * pre-filter: detection happens at the plugin level based on configured path prefix.
 *
 * @module
 * @since 0.3.0
 */

import type { RpcFetchHandler } from '@hono-enterprise/common';

/**
 * Stores an adapter's RPC interceptor and consults it safely.
 *
 * @since 0.3.0
 */
export class RpcInterceptorStore {
  #handler: RpcFetchHandler | null = null;

  /**
   * Installs the handler. A later call replaces the previous one.
   *
   * @param handler - The RPC fetch handler to consult on requests
   */
  set(handler: RpcFetchHandler): void {
    this.#handler = handler;
  }

  /** Whether a handler has been installed. */
  get hasHandler(): boolean {
    return this.#handler !== null;
  }

  /**
   * Calls the installed handler. Returns the handler's response if it returns
   * a {@linkcode Response}, otherwise returns {@linkcode null}.
   *
   * A throwing handler is converted to a safe 500 Response rather than allowing
   * the error to escape: an application bug in the handler must not take down
   * the serve loop.
   *
   * @param request - The native, undisturbed request
   * @returns The response, or null to fall through
   */
  async consult(request: Request): Promise<Response | null> {
    const handler = this.#handler;
    if (handler === null) {
      return null;
    }

    try {
      const result = await handler(request);
      // If the handler returns null, fall through to normal Hono handling.
      return result;
    } catch (_cause) {
      // Convert any exception to a safe 500 response.
      return new Response('Internal server error', { status: 500 });
    }
  }
}
