/**
 * WebSocket route table — exact-path matching plus subprotocol selection.
 *
 * Paths match exactly rather than by pattern. The kernel's pattern matcher is
 * internal to `@hono-enterprise/kernel` and not exported, so reusing it would
 * mean reaching into another package's internals (AI_GUIDELINES §2.1), and
 * hand-rolling a second matcher would duplicate logic (§11.1). Variable data
 * travels in the query string, which `onOpen` receives.
 *
 * All parsing happens at registration time; matching is an O(1) map lookup per
 * upgrade (AI_GUIDELINES §14).
 *
 * @module
 * @since 0.1.0
 */

import type { WebSocketHandlers, WebSocketRouteOptions } from '@hono-enterprise/common';

/**
 * One registered WebSocket route.
 *
 * @since 0.1.0
 */
export interface WsRoute {
  /** The exact path this route serves. */
  readonly path: string;
  /** The application's lifecycle callbacks. */
  readonly handlers: WebSocketHandlers;
  /** Subprotocols this route accepts, empty when none are configured. */
  readonly protocols: readonly string[];
}

/**
 * The outcome of matching an upgrade request against the table.
 *
 * @since 0.1.0
 */
export type WsRouteMatch =
  | { readonly matched: true; readonly route: WsRoute; readonly protocol?: string }
  | { readonly matched: false; readonly status: number };

/**
 * Parses a `Sec-WebSocket-Protocol` header into its comma-separated tokens.
 *
 * @param header - The raw header value, or `null` when absent
 * @returns The requested protocol tokens, in client preference order
 * @since 0.1.0
 */
export function parseRequestedProtocols(header: string | null): readonly string[] {
  if (header === null) {
    return [];
  }
  return header
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Selects the subprotocol to echo for a route.
 *
 * With no configured protocols, none is negotiated and none is echoed —
 * echoing a protocol the client did not request breaks conformant clients.
 * With configured protocols, the client's first requested protocol that the
 * route accepts wins; if none match, the handshake is refused.
 *
 * @param configured - The route's accepted protocols
 * @param requested - The protocols the client asked for
 * @returns The selected protocol, `undefined` when none is negotiated, or `false` to refuse
 * @since 0.1.0
 */
export function selectProtocol(
  configured: readonly string[],
  requested: readonly string[],
): string | undefined | false {
  if (configured.length === 0) {
    return undefined;
  }
  const chosen = requested.find((protocol) => configured.includes(protocol));
  return chosen ?? false;
}

/**
 * The registered WebSocket routes.
 *
 * @since 0.1.0
 */
export class WsRouteTable {
  readonly #routes = new Map<string, WsRoute>();

  /** Number of registered routes. */
  get size(): number {
    return this.#routes.size;
  }

  /**
   * Registers a route.
   *
   * @param path - The exact path to serve
   * @param handlers - The lifecycle callbacks
   * @param options - Per-route configuration
   * @throws {Error} If the path is already registered
   */
  add(path: string, handlers: WebSocketHandlers, options?: WebSocketRouteOptions): void {
    if (this.#routes.has(path)) {
      throw new Error(`A WebSocket route is already registered for path "${path}"`);
    }
    this.#routes.set(path, {
      path,
      handlers,
      protocols: options?.protocols ?? [],
    });
  }

  /**
   * Matches an upgrade request.
   *
   * @param request - The upgrade request
   * @returns The match, or a refusal with the status to answer
   * @since 0.1.0
   */
  match(request: Request): WsRouteMatch | null {
    const { pathname } = new URL(request.url);
    const route = this.#routes.get(pathname);
    if (route === undefined) {
      return null;
    }

    const requested = parseRequestedProtocols(request.headers.get('sec-websocket-protocol'));
    const protocol = selectProtocol(route.protocols, requested);
    if (protocol === false) {
      return { matched: false, status: 400 };
    }

    return protocol === undefined ? { matched: true, route } : { matched: true, route, protocol };
  }
}
