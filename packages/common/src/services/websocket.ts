/**
 * WebSocket contracts — the capability interface the WebSocketPlugin
 * implements under `CAPABILITIES.WEBSOCKET`, plus the upgrade seam the HTTP
 * adapters in `@setu-ts/runtime` implement.
 *
 * The plugin provides full-duplex, bidirectional messaging, completing the
 * real-time story that Server-Sent Events (Milestone 43) covers one-way.
 *
 * **Why the upgrade does not ride the normal request pipeline.** A WebSocket
 * handshake needs the *native* `Request` and answers with a 101 that carries a
 * socket. {@linkcode IRequest} deliberately carries no native request, and the
 * runtime's shared request mapping pre-reads the body — which *disturbs* it and
 * makes `Deno.upgradeWebSocket` fail outright. The handshake is therefore
 * intercepted inside the HTTP adapter, the one component holding the native
 * request and owning the runtime's serve loop (AI_GUIDELINES §4.3), reached
 * through {@linkcode IHttpAdapter.setUpgradeRouter}.
 *
 * @module
 * @since 0.2.0
 */

/**
 * Lifecycle state of a WebSocket, normalized across runtimes to names rather
 * than the numeric codes the web API uses.
 *
 * @since 0.2.0
 */
export type WebSocketReadyState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * Payload of a WebSocket close, normalized across runtimes.
 *
 * @since 0.2.0
 */
export interface WebSocketCloseEvent {
  /** The RFC 6455 close code (e.g. `1000` normal, `1001` going away). */
  readonly code: number;
  /** The close reason; an empty string when the peer supplied none. */
  readonly reason: string;
}

/**
 * The runtime-native socket, normalized to the two operations the framework
 * needs. Implemented by each HTTP adapter's upgrader over its platform socket
 * (`Deno.upgradeWebSocket`'s `WebSocket`, a `ws` socket on Node, Bun's
 * `ServerWebSocket`, the server half of a Workers `WebSocketPair`).
 *
 * @since 0.2.0
 */
export interface IWebSocketTransport {
  /** Current lifecycle state of the underlying socket. */
  readonly readyState: WebSocketReadyState;
  /**
   * Sends a frame to the peer. A `string` is sent as a text frame, a
   * `Uint8Array` as a binary frame.
   *
   * @param data - The frame payload
   */
  send(data: string | Uint8Array): void;
  /**
   * Closes the socket.
   *
   * @param code - RFC 6455 close code (defaults to `1000`)
   * @param reason - Human-readable close reason
   */
  close(code?: number, reason?: string): void;
}

/**
 * The callbacks an HTTP adapter drives once it has completed a handshake. The
 * WebSocket plugin builds one sink per accepted upgrade and hands it to the
 * adapter inside the accept decision; the adapter binds its native socket
 * events to these methods.
 *
 * This is the inversion that keeps runtime differences out of the plugin: the
 * adapter knows how to listen, the sink knows what to do.
 *
 * @since 0.2.0
 */
export interface WebSocketEventSink {
  /**
   * Called once, when the socket is live and writable.
   *
   * @param transport - The normalized socket
   */
  onOpen(transport: IWebSocketTransport): void;
  /**
   * Called for every inbound frame.
   *
   * @param data - Text frames arrive as `string`, binary frames as `Uint8Array`
   */
  onMessage(data: string | Uint8Array): void;
  /**
   * Called once, when the socket closes for any reason.
   *
   * @param event - The close code and reason
   */
  onClose(event: WebSocketCloseEvent): void;
  /**
   * Called when the socket reports a transport-level error. A socket that
   * errors is also expected to close, so implementations must tolerate
   * {@linkcode WebSocketEventSink.onClose} arriving afterwards.
   *
   * @param error - The normalized error
   */
  onError(error: Error): void;
}

/**
 * What an HTTP adapter should do with an inbound upgrade request, as decided
 * by the {@linkcode WebSocketUpgradeRouter}.
 *
 * Discriminated on `accept`, so an adapter narrows with a single check.
 *
 * @since 0.2.0
 */
export type WebSocketUpgradeDecision =
  | {
    /** Complete the handshake. */
    readonly accept: true;
    /** The sink the adapter binds its native socket events into. */
    readonly sink: WebSocketEventSink;
    /**
     * The negotiated subprotocol to echo back, when one was selected. Omit to
     * echo none — never echo a protocol the client did not request.
     */
    readonly protocol?: string;
  }
  | {
    /** Refuse the handshake. */
    readonly accept: false;
    /** The HTTP status to answer with (e.g. `503` at capacity, `400` on a bad subprotocol). */
    readonly status: number;
  };

/**
 * Consulted by an HTTP adapter for every inbound WebSocket upgrade request,
 * before the request reaches the ordinary middleware pipeline.
 *
 * Returning `null` means "this is not a WebSocket route" and the adapter falls
 * through to normal HTTP handling, so registering a router never changes the
 * behavior of non-WebSocket traffic.
 *
 * @param request - The native, undisturbed upgrade request
 * @returns The decision, or `null` to fall through to the HTTP pipeline
 * @since 0.2.0
 */
export type WebSocketUpgradeRouter = (
  request: Request,
) => Promise<WebSocketUpgradeDecision | null>;

/**
 * A live WebSocket connection, as seen by application code.
 *
 * @since 0.2.0
 */
export interface IWebSocketConnection {
  /** Unique connection ID (from `runtime.uuid()`). */
  readonly id: string;
  /** The path this connection was opened on. */
  readonly path: string;
  /** Current lifecycle state. */
  readonly readyState: WebSocketReadyState;
  /** Whether the connection is still writable. */
  readonly isOpen: boolean;
  /**
   * Per-connection application state, the socket-lifetime analogue of
   * {@linkcode IRequestContext.state}. Use it to attach an authenticated user
   * id, a tenant, or any value later handlers and broadcasts need.
   */
  readonly data: Map<string, unknown>;
  /**
   * Sends a frame to this peer.
   *
   * @param data - Text as `string`, binary as `Uint8Array`
   * @throws {Error} If the connection is no longer open
   */
  send(data: string | Uint8Array): void;
  /**
   * Serializes a value to JSON and sends it as a text frame.
   *
   * @typeParam T - The payload type
   * @param payload - The value to serialize
   * @throws {Error} If the connection is no longer open
   */
  sendJson<T>(payload: T): void;
  /**
   * Closes the connection. Idempotent.
   *
   * @param code - RFC 6455 close code (defaults to `1000`)
   * @param reason - Human-readable close reason
   */
  close(code?: number, reason?: string): void;
}

/**
 * Options for a room broadcast.
 *
 * @since 0.2.0
 */
export interface RoomBroadcastOptions {
  /** A member to skip — typically the sender, so it does not echo to itself. */
  readonly except?: IWebSocketConnection;
}

/**
 * A named broadcast group of connections — the bidirectional analogue of the
 * SSE plugin's channels.
 *
 * Connections are removed automatically when they close, so a room never
 * broadcasts to a dead peer.
 *
 * @since 0.2.0
 */
export interface WebSocketRoom {
  /** The room name. */
  readonly name: string;
  /** Number of currently open members. */
  readonly size: number;
  /**
   * Adds a connection to this room.
   *
   * @param conn - The connection to add
   */
  add(conn: IWebSocketConnection): void;
  /**
   * Removes a connection from this room.
   *
   * @param conn - The connection to remove
   */
  remove(conn: IWebSocketConnection): void;
  /**
   * Sends a frame to every open member, skipping any closed member and any
   * member named by `options.except`.
   *
   * @param data - Text as `string`, binary as `Uint8Array`
   * @param options - Broadcast options
   */
  broadcast(data: string | Uint8Array, options?: RoomBroadcastOptions): void;
  /**
   * Serializes a value to JSON once and broadcasts it as a text frame.
   *
   * @typeParam T - The payload type
   * @param payload - The value to serialize
   * @param options - Broadcast options
   */
  broadcastJson<T>(payload: T, options?: RoomBroadcastOptions): void;
}

/**
 * Details of the upgrade request that opened a connection, handed to
 * {@linkcode WebSocketHandlers.onOpen}.
 *
 * Because WebSocket routes match on exact path, variable data travels in the
 * query string and is exposed through {@linkcode WebSocketConnectionContext.query}.
 *
 * @since 0.2.0
 */
export interface WebSocketConnectionContext {
  /** The full upgrade request URL. */
  readonly url: string;
  /** The URL path component (no query string). */
  readonly path: string;
  /** Query string parameters. */
  readonly query: Readonly<Record<string, string>>;
  /** The upgrade request headers — read these to authenticate the peer. */
  readonly headers: Headers;
  /** The negotiated subprotocol, when one was selected. */
  readonly protocol?: string;
}

/**
 * The lifecycle callbacks an application supplies per WebSocket route.
 *
 * Every callback may be async; a rejected promise is routed to
 * {@linkcode WebSocketHandlers.onError} rather than becoming an unhandled
 * rejection.
 *
 * @since 0.2.0
 */
export interface WebSocketHandlers {
  /**
   * Called once per connection, after the handshake completes.
   *
   * @param conn - The new connection
   * @param context - Details of the upgrade request
   */
  onOpen?(conn: IWebSocketConnection, context: WebSocketConnectionContext): void | Promise<void>;
  /**
   * Called for every inbound frame.
   *
   * @param conn - The connection that received the frame
   * @param data - Text as `string`, binary as `Uint8Array`
   */
  onMessage?(conn: IWebSocketConnection, data: string | Uint8Array): void | Promise<void>;
  /**
   * Called once, when the connection closes for any reason.
   *
   * @param conn - The closed connection
   * @param event - The close code and reason
   */
  onClose?(conn: IWebSocketConnection, event: WebSocketCloseEvent): void | Promise<void>;
  /**
   * Called on a transport error, and on a rejected promise from any other
   * callback.
   *
   * @param conn - The affected connection
   * @param error - The error
   */
  onError?(conn: IWebSocketConnection, error: Error): void | Promise<void>;
}

/**
 * Per-route configuration supplied alongside the handlers.
 *
 * @since 0.2.0
 */
export interface WebSocketRouteOptions {
  /**
   * Subprotocols this route accepts. When non-empty, the first client-requested
   * protocol appearing in this list is echoed back and any request whose
   * `Sec-WebSocket-Protocol` matches none of them is rejected with 400. When
   * omitted, no protocol is negotiated and none is echoed.
   */
  readonly protocols?: readonly string[];

  /**
   * Whether this route participates in the shared heartbeat sweep.
   *
   * When `false`, the {@linkcode HeartbeatSweeper} skips this route's connections
   * for both the payload send and the idle eviction. Use this when the route
   * speaks its own liveness protocol (e.g. `graphql-transport-ws` `ping`/`pong`)
   * that would be corrupted by a generic text heartbeat.
   *
   * Defaults to `true` so existing routes are unaffected.
   *
   * @since 0.3.0
   */
  readonly heartbeat?: boolean;
}

/**
 * Service contract for the WebSocket hub — registered by the WebSocketPlugin
 * under `CAPABILITIES.WEBSOCKET`.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 *
 * const ws = ctx.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
 *
 * ws.route('/ws/chat', {
 *   onOpen: (conn, { query }) => {
 *     conn.data.set('room', query.room ?? 'lobby');
 *     ws.room(query.room ?? 'lobby').add(conn);
 *   },
 *   onMessage: (conn, data) => {
 *     const room = conn.data.get('room') as string;
 *     ws.room(room).broadcast(data, { except: conn });
 *   },
 * });
 * ```
 * @since 0.2.0
 */
export interface IWebSocketService {
  /**
   * Registers a WebSocket route. Paths match exactly; the query string is
   * ignored for matching and exposed to `onOpen` instead.
   *
   * @param path - The exact URL path to accept upgrades on (e.g. `/ws/chat`)
   * @param handlers - The lifecycle callbacks
   * @param options - Per-route configuration
   * @throws {Error} If the HTTP adapter provides no upgrade seam, or if the path is already registered
   */
  route(path: string, handlers: WebSocketHandlers, options?: WebSocketRouteOptions): void;
  /**
   * Returns the named room, creating it on first use.
   *
   * @param name - Room name
   * @returns The room
   */
  room(name: string): WebSocketRoom;
  /** Whether the underlying HTTP adapter can perform WebSocket upgrades. */
  readonly available: boolean;
  /** Current number of open connections across all routes. */
  readonly connectionCount: number;
  /** Current number of live rooms. */
  readonly roomCount: number;
}
