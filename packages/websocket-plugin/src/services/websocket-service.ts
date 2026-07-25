/**
 * {@linkcode WebSocketService} — the hub registered under
 * `CAPABILITIES.WEBSOCKET`.
 *
 * It owns the route table, the live connection registry, the rooms, and the
 * heartbeat, and it is the sole author of the {@linkcode WebSocketUpgradeRouter}
 * the HTTP adapter consults. Everything runtime-specific stays in the adapter;
 * this service only ever sees `Request`, {@linkcode IWebSocketTransport}, and
 * frames.
 *
 * @module
 * @since 0.1.0
 */

import type {
  IRuntimeServices,
  IWebSocketConnection,
  IWebSocketService,
  IWebSocketTransport,
  WebSocketConnectionContext,
  WebSocketEventSink,
  WebSocketHandlers,
  WebSocketRoom,
  WebSocketRouteOptions,
  WebSocketUpgradeDecision,
} from '@hono-enterprise/common';
import { WebSocketConnection } from '../connection/websocket-connection.ts';
import { RoomRegistry } from '../rooms/room-registry.ts';
import type { WsRoute } from '../routing/ws-route-table.ts';
import { WsRouteTable } from '../routing/ws-route-table.ts';
import { HeartbeatSweeper } from '../heartbeat/heartbeat.ts';
import { WebSocketUnavailableError } from '../errors/websocket-errors.ts';
import type { WebSocketPluginOptions } from '../interfaces/index.ts';

/** Refused because the server is at its connection limit. */
const STATUS_AT_CAPACITY = 503;
/** Close code for a frame that exceeded the configured size limit. */
const CLOSE_MESSAGE_TOO_BIG = 1009;
/** Close code used when the server shuts down. */
const CLOSE_GOING_AWAY = 1001;

/** Resolved options with every default applied. */
interface ResolvedOptions {
  readonly maxConnections: number;
  readonly heartbeatMs: number;
  readonly heartbeatPayload: string;
  readonly idleTimeoutMs: number;
  readonly maxMessageBytes: number;
}

/**
 * Applies defaults and rejects a configuration that cannot work.
 *
 * @param options - The caller's options
 * @returns The resolved options
 * @throws {Error} If an idle timeout is set with no heartbeat to sweep on
 * @since 0.1.0
 */
export function resolveOptions(options?: WebSocketPluginOptions): ResolvedOptions {
  const heartbeatMs = options?.heartbeatMs ?? 0;
  const idleTimeoutMs = options?.idleTimeoutMs ?? 0;

  if (idleTimeoutMs > 0 && heartbeatMs <= 0) {
    throw new Error(
      'WebSocketPlugin: idleTimeoutMs requires heartbeatMs to be greater than 0 — ' +
        'the heartbeat tick is what performs the idle sweep.',
    );
  }

  return {
    maxConnections: options?.maxConnections ?? 0,
    heartbeatMs,
    heartbeatPayload: options?.heartbeatPayload ?? 'ping',
    idleTimeoutMs,
    maxMessageBytes: options?.maxMessageBytes ?? 0,
  };
}

/**
 * Measures an inbound frame in bytes.
 *
 * Text frames are measured by their UTF-8 encoding rather than their string
 * length, so a multi-byte payload is not undercounted against the limit.
 *
 * @param data - The frame
 * @returns The frame size in bytes
 * @since 0.1.0
 */
export function frameByteLength(data: string | Uint8Array): number {
  return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

/**
 * The WebSocket hub.
 *
 * @since 0.1.0
 */
export class WebSocketService implements IWebSocketService {
  readonly #runtime: IRuntimeServices;
  readonly #options: ResolvedOptions;
  readonly #routes = new WsRouteTable();
  readonly #rooms = new RoomRegistry();
  readonly #connections = new Set<WebSocketConnection>();
  readonly #heartbeat: HeartbeatSweeper;
  readonly #available: boolean;

  /**
   * Creates the service.
   *
   * @param runtime - Runtime services (ids, monotonic clock, timers)
   * @param options - Resolved plugin options
   * @param available - Whether the HTTP adapter can perform upgrades
   */
  constructor(runtime: IRuntimeServices, options: ResolvedOptions, available: boolean) {
    this.#runtime = runtime;
    this.#options = options;
    this.#available = available;
    this.#heartbeat = new HeartbeatSweeper(
      runtime,
      {
        heartbeatMs: options.heartbeatMs,
        heartbeatPayload: options.heartbeatPayload,
        idleTimeoutMs: options.idleTimeoutMs,
      },
      () => this.#connections,
    );
  }

  get available(): boolean {
    return this.#available;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  /** Number of registered routes — reported by the health indicator. */
  get routeCount(): number {
    return this.#routes.size;
  }

  route(path: string, handlers: WebSocketHandlers, options?: WebSocketRouteOptions): void {
    if (!this.#available) {
      throw new WebSocketUnavailableError();
    }
    this.#routes.add(path, handlers, options);
    // The first route is what makes the heartbeat worth running.
    this.#heartbeat.start();
  }

  room(name: string): WebSocketRoom {
    return this.#rooms.get(name);
  }

  /**
   * The router handed to the HTTP adapter. Matches the request against the
   * route table, applies admission control, and builds the sink the adapter
   * binds its native socket into.
   *
   * @param request - The native upgrade request
   * @returns The decision, or `null` when this is not a WebSocket route
   * @since 0.1.0
   */
  createUpgradeRouter(): (request: Request) => Promise<WebSocketUpgradeDecision | null> {
    // deno-lint-ignore require-await
    return async (request: Request): Promise<WebSocketUpgradeDecision | null> => {
      const match = this.#routes.match(request);
      if (match === null) {
        return null;
      }
      if (!match.matched) {
        return { accept: false, status: match.status };
      }
      if (
        this.#options.maxConnections > 0 &&
        this.#connections.size >= this.#options.maxConnections
      ) {
        return { accept: false, status: STATUS_AT_CAPACITY };
      }

      // Snapshotted here, while the request is still live. The sink's onOpen
      // fires only after the adapter has answered the handshake, at which
      // point the runtime has already closed the native request and reading
      // its headers throws.
      const context = buildContext(request, match.protocol);

      const sink = this.#createSink(context, match.route);
      return match.protocol === undefined
        ? { accept: true, sink }
        : { accept: true, sink, protocol: match.protocol };
    };
  }

  /**
   * Closes every connection and stops the heartbeat. Called from the plugin's
   * shutdown hook (AI_GUIDELINES §14.5).
   */
  closeAll(): void {
    this.#heartbeat.stop();
    for (const conn of [...this.#connections]) {
      conn.close(CLOSE_GOING_AWAY, 'Server shutting down');
    }
    this.#connections.clear();
    this.#rooms.clear();
  }

  /**
   * Builds the per-connection sink the adapter drives.
   */
  #createSink(
    context: WebSocketConnectionContext,
    route: WsRoute,
  ): WebSocketEventSink {
    const { handlers } = route;
    let conn: WebSocketConnection | null = null;

    /**
     * Hands an error to the route's `onError`. A reporter that itself fails is
     * swallowed deliberately: there is nowhere left to report it, and letting
     * it escape would break the socket's event dispatch.
     */
    const report = (target: WebSocketConnection, err: unknown): void => {
      if (handlers.onError === undefined) {
        return;
      }
      try {
        const result = handlers.onError(
          target,
          err instanceof Error ? err : new Error(String(err)),
        );
        if (result instanceof Promise) {
          void result.catch(() => {});
        }
      } catch {
        // Deliberately swallowed — the error reporter itself failed.
      }
    };

    /**
     * Invokes a handler, routing a thrown or rejected error to `onError` so a
     * failing callback never becomes an unhandled rejection (§11.7).
     */
    const invoke = <A>(
      handler: ((conn: IWebSocketConnection, arg: A) => void | Promise<void>) | undefined,
      target: WebSocketConnection,
      arg: A,
    ): void => {
      if (handler === undefined) {
        return;
      }
      try {
        const result = handler(target, arg);
        if (result instanceof Promise) {
          void result.catch((err: unknown) => {
            report(target, err);
          });
        }
      } catch (err) {
        report(target, err);
      }
    };

    return {
      onOpen: (transport: IWebSocketTransport): void => {
        const opened = new WebSocketConnection(
          this.#runtime.uuid(),
          route.path,
          transport,
          this.#runtime.hrtime(),
        );
        conn = opened;
        this.#connections.add(opened);
        invoke(handlers.onOpen, opened, context);
      },

      onMessage: (data: string | Uint8Array): void => {
        if (conn === null) {
          return;
        }
        const target = conn;
        target.touch(this.#runtime.hrtime());

        const limit = this.#options.maxMessageBytes;
        if (limit > 0 && frameByteLength(data) > limit) {
          target.close(CLOSE_MESSAGE_TOO_BIG, 'Message too large');
          return;
        }

        invoke(handlers.onMessage, target, data);
      },

      onClose: (event): void => {
        if (conn === null) {
          return;
        }
        const closing = conn;
        closing.markClosed();
        this.#connections.delete(closing);
        this.#rooms.evict(closing);
        invoke(handlers.onClose, closing, event);
      },

      onError: (error: Error): void => {
        if (conn === null) {
          return;
        }
        report(conn, error);
      },
    };
  }
}

/**
 * Builds the context handed to `onOpen` from the upgrade request.
 *
 * @param request - The upgrade request
 * @param protocol - The negotiated subprotocol, when one was selected
 * @returns The connection context
 * @since 0.1.0
 */
export function buildContext(
  request: Request,
  protocol: string | undefined,
): WebSocketConnectionContext {
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  const base = {
    url: request.url,
    path: url.pathname,
    query,
    headers: new Headers(request.headers),
  };
  return protocol === undefined ? base : { ...base, protocol };
}
