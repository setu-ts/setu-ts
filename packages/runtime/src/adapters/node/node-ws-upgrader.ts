/**
 * Node WebSocket upgrade — completes an RFC 6455 handshake on the raw
 * `upgrade` event of the `node:http` server that `@hono/node-server`'s
 * `serve()` returns, using `npm:ws`.
 *
 * **Why not `@hono/node-ws`, and why not node-server's built-in `websocket`
 * option.** Both drive the handshake through Hono's request context: the former
 * requires a concrete `Hono` app instance (verified against its shipped types,
 * which declare `createNodeWebSocket({ app: Hono<any, any, any> })`) and
 * peer-depends on `@hono/node-server@^1.19.11` while this package pins `^2`; the
 * latter reaches the application through `c.env` plus private connection
 * symbols. {@linkcode NodeHttpAdapter} hands `serve()` a bare fetch *function*,
 * never a Hono app, so neither path applies. The raw `upgrade` event uses only
 * public Node APIs and stays independent of node-server internals.
 *
 * `ws` is an optional dependency (AI_GUIDELINES §12.2): inject a module through
 * {@linkcode adaptWsModule}, or let {@linkcode loadWsModule} import it lazily on
 * the first upgrade.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IWebSocketTransport,
  WebSocketEventSink,
  WebSocketReadyState,
} from '@hono-enterprise/common';
import {
  ABNORMAL_CLOSURE,
  normalizeFrame,
  toTransportError,
} from '../shared/web-socket-transport.ts';

// Hoisted decoder — avoids a per-message allocation on the hot path, matching
// the shared fetch mapping (AI_GUIDELINES §14).
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Structural facades over `ws`
// ---------------------------------------------------------------------------

/**
 * A `ws` socket, narrowed to what this adapter drives. Declared structurally so
 * the package never takes a type dependency on `@types/ws`.
 *
 * @since 0.2.0
 */
export interface WsSocketLike {
  /** Numeric ready state, matching the web WebSocket API's values. */
  readonly readyState: number;
  /**
   * Sends a text or binary frame.
   *
   * @param data - The frame payload
   */
  send(data: string | Uint8Array): void;
  /**
   * Closes the socket.
   *
   * @param code - RFC 6455 close code
   * @param reason - Close reason
   */
  close(code?: number, reason?: string): void;
  /**
   * Subscribes to a socket event.
   *
   * @param event - Event name
   * @param listener - Event listener
   */
  on(event: string, listener: (...args: never[]) => void): void;
}

/**
 * A `ws` `WebSocketServer` in `noServer` mode, narrowed to what this adapter
 * drives.
 *
 * @since 0.2.0
 */
export interface WsServerLike {
  /**
   * Completes the handshake over an already-accepted TCP connection.
   *
   * @param request - The Node `IncomingMessage` from the `upgrade` event
   * @param socket - The raw duplex socket from the `upgrade` event
   * @param head - The bytes the HTTP parser already buffered
   * @param callback - Receives the completed socket
   */
  handleUpgrade(
    request: unknown,
    socket: unknown,
    head: unknown,
    callback: (ws: WsSocketLike) => void,
  ): void;
  /** Shuts the server down. */
  close(): void;
}

/**
 * The shape of the `ws` module this adapter uses.
 *
 * @since 0.2.0
 */
export interface WsModuleLike {
  /** The `WebSocketServer` constructor. */
  readonly WebSocketServer: new (options: {
    noServer: boolean;
    handleProtocols?: (protocols: Set<string>) => string | false;
  }) => WsServerLike;
}

/**
 * The raw socket handed to a Node `upgrade` listener, narrowed to what a
 * refusal needs.
 *
 * @since 0.2.0
 */
export interface RawUpgradeSocket {
  /**
   * Writes bytes to the socket.
   *
   * @param data - The bytes to write
   */
  write(data: string): void;
  /** Closes the socket. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Module loading (inject-or-lazy, AI_GUIDELINES §12.2)
// ---------------------------------------------------------------------------

/**
 * Narrows an already-imported module to {@linkcode WsModuleLike}.
 *
 * Split from {@linkcode loadWsModule} so the validation branches are unit-testable
 * with a hand-built fake, leaving only the one `import()` line behind a guarded
 * real-import test.
 *
 * @param module - The imported module namespace
 * @returns The narrowed module
 * @throws {TypeError} If the module does not expose a `WebSocketServer` constructor
 * @example
 * ```typescript
 * import * as ws from 'ws';
 * const adapter = new NodeHttpAdapter(undefined, adaptWsModule(ws));
 * ```
 * @since 0.2.0
 */
export function adaptWsModule(module: unknown): WsModuleLike {
  if (typeof module !== 'object' || module === null) {
    throw new TypeError('The "ws" module did not resolve to a module namespace');
  }

  const candidate = (module as { WebSocketServer?: unknown }).WebSocketServer;
  if (typeof candidate !== 'function') {
    throw new TypeError('The "ws" module does not export a WebSocketServer constructor');
  }

  return { WebSocketServer: candidate as WsModuleLike['WebSocketServer'] };
}

/**
 * Lazily imports `ws` and narrows it.
 *
 * @returns The narrowed `ws` module
 * @throws {Error} If `ws` is not installed, with the install command in the message
 * @since 0.2.0
 */
export async function loadWsModule(): Promise<WsModuleLike> {
  let module: unknown;
  try {
    module = await import('npm:ws@^8.18.0');
  } catch (cause) {
    throw new Error(
      'WebSocket support on Node requires the "ws" package. Install it with ' +
        '`npm install ws` (or `deno add npm:ws`).',
      { cause },
    );
  }
  return adaptWsModule(module);
}

// ---------------------------------------------------------------------------
// Transport + binding
// ---------------------------------------------------------------------------

/** Numeric ready states, matching the web WebSocket API's values. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;

/**
 * Maps a `ws` numeric ready state to the framework's named state.
 *
 * @param state - The numeric ready state
 * @returns The named ready state
 * @since 0.2.0
 */
export function toWsReadyState(state: number): WebSocketReadyState {
  switch (state) {
    case WS_CONNECTING:
      return 'connecting';
    case WS_OPEN:
      return 'open';
    case WS_CLOSING:
      return 'closing';
    default:
      return 'closed';
  }
}

/**
 * Wraps a `ws` socket as an {@linkcode IWebSocketTransport}.
 *
 * @param socket - The `ws` socket
 * @returns The normalized transport
 * @since 0.2.0
 */
export function createWsTransport(socket: WsSocketLike): IWebSocketTransport {
  return {
    get readyState(): WebSocketReadyState {
      return toWsReadyState(socket.readyState);
    },
    send(data: string | Uint8Array): void {
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason);
    },
  };
}

/**
 * Binds a `ws` socket's events to a sink.
 *
 * `ws` delivers a completed socket already open, so `onOpen` fires immediately
 * rather than waiting for an event that will never arrive. Its `close` reason
 * arrives as a `Buffer`, and binary frames as a `Buffer` too — both are
 * `Uint8Array` subclasses, so the shared frame normalization handles them.
 *
 * @param socket - The `ws` socket
 * @param sink - The sink to drive
 * @since 0.2.0
 */
export function bindWsSocketToSink(socket: WsSocketLike, sink: WebSocketEventSink): void {
  socket.on('message', (...args: never[]): void => {
    const [data, isBinary] = args as unknown as [unknown, boolean | undefined];
    // `ws` hands text frames over as Buffers too, distinguishing them only via
    // the isBinary flag, so a text frame is decoded rather than passed as bytes.
    const frame = normalizeFrame(data);
    if (isBinary === false && frame instanceof Uint8Array) {
      sink.onMessage(decoder.decode(frame));
      return;
    }
    sink.onMessage(frame);
  });

  socket.on('close', (...args: never[]): void => {
    const [code, reason] = args as unknown as [number | undefined, unknown];
    const decoded = reason instanceof Uint8Array ? decoder.decode(reason) : '';
    sink.onClose({ code: code ?? ABNORMAL_CLOSURE, reason: decoded });
  });

  socket.on('error', (...args: never[]): void => {
    sink.onError(toTransportError(args[0]));
  });

  sink.onOpen(createWsTransport(socket));
}

/**
 * An event emitter that can report raw HTTP upgrades — the one capability this
 * adapter needs from the `node:http` server that `serve()` returns.
 *
 * @since 0.2.0
 */
export interface UpgradeEmitter {
  /**
   * Subscribes to the raw `upgrade` event.
   *
   * @param event - Always `'upgrade'`
   * @param listener - Receives the incoming message, raw socket, and buffered head
   */
  on(event: 'upgrade', listener: (...args: never[]) => void): unknown;
}

/**
 * Probes a server handle for the raw `upgrade` event.
 *
 * `serve()` returns node-server's `ServerType` union of `node:http` and
 * `node:http2` servers, whose `on` overloads are declared with `any` listeners
 * and so cannot be expressed on {@linkcode NodeServer} without a variance
 * conflict. Probing here keeps the published interface clean and confines the
 * narrowing to one boundary.
 *
 * @param server - The server handle returned by `serve()`
 * @returns The emitter, or `null` when the handle emits no events (e.g. a test fake)
 * @since 0.2.0
 */
export function asUpgradeEmitter(server: unknown): UpgradeEmitter | null {
  if (typeof server !== 'object' || server === null) {
    return null;
  }
  const candidate = server as { on?: unknown };
  if (typeof candidate.on !== 'function') {
    return null;
  }
  return candidate as UpgradeEmitter;
}

/**
 * A Node `IncomingMessage`, narrowed to what building an upgrade `Request`
 * needs.
 *
 * @since 0.2.0
 */
export interface NodeIncomingMessage {
  /** The request target (path plus query), as Node reports it. */
  readonly url?: string | undefined;
  /** The HTTP method. */
  readonly method?: string | undefined;
  /** Raw headers, as Node's lowercase-keyed object. */
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * Reconstructs a web-standard `Request` from Node's `upgrade` event arguments,
 * so the upgrade router sees the same shape on every runtime.
 *
 * An upgrade request never carries a body, so none is attached — which also
 * keeps the request undisturbed for the handshake.
 *
 * @param incoming - The Node request from the `upgrade` event
 * @returns The equivalent web-standard request
 * @since 0.2.0
 */
export function createUpgradeRequest(incoming: NodeIncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const hostHeader = headers.get('host') ?? 'localhost';
  const target = incoming.url ?? '/';
  return new Request(`http://${hostHeader}${target}`, {
    method: incoming.method ?? 'GET',
    headers,
  });
}

/**
 * Owns the `ws` server for one Node HTTP adapter and performs the handshake.
 *
 * Split out of the adapter so the adapter keeps its single responsibility
 * (mapping HTTP) and so the handshake's branches are measurable in isolation.
 * The `ws` server is created on the first accepted upgrade — a plain HTTP
 * application therefore never loads the optional dependency at all.
 *
 * @since 0.2.0
 */
export class NodeUpgradeCoordinator {
  #module: WsModuleLike | null;
  #server: WsServerLike | null = null;
  #pendingProtocol: string | undefined;

  /**
   * Creates the coordinator.
   *
   * @param module - An injected `ws` module; omit to load it lazily
   */
  constructor(module?: WsModuleLike) {
    this.#module = module ?? null;
  }

  /**
   * `ws` selects the subprotocol through this callback rather than through
   * `handleUpgrade`, so the already-negotiated choice is handed over via
   * `#pendingProtocol`. `handleUpgrade` resolves protocols synchronously, so no
   * other upgrade can interleave between the assignment and this read.
   */
  readonly #selectProtocol = (): string | false => {
    return this.#pendingProtocol ?? false;
  };

  /** Whether a `ws` server has been created yet. */
  get hasServer(): boolean {
    return this.#server !== null;
  }

  /**
   * Completes the RFC 6455 handshake over an already-accepted TCP connection
   * and binds the resulting socket to the decision's sink.
   *
   * @param incoming - The Node request from the `upgrade` event
   * @param socket - The raw duplex socket
   * @param head - The bytes the HTTP parser already buffered
   * @param sink - The sink to bind the completed socket into
   * @param protocol - The negotiated subprotocol to echo, when one was selected
   * @throws {Error} If `ws` is not installed
   */
  async handshake(
    incoming: NodeIncomingMessage,
    socket: unknown,
    head: unknown,
    sink: WebSocketEventSink,
    protocol?: string,
  ): Promise<void> {
    if (this.#module === null) {
      this.#module = await loadWsModule();
    }
    if (this.#server === null) {
      this.#server = new this.#module.WebSocketServer({
        noServer: true,
        handleProtocols: this.#selectProtocol,
      });
    }

    this.#pendingProtocol = protocol;
    this.#server.handleUpgrade(incoming, socket, head, (ws) => {
      bindWsSocketToSink(ws, sink);
    });
  }

  /** Shuts down the `ws` server, when one was ever created. */
  close(): void {
    if (this.#server !== null) {
      this.#server.close();
      this.#server = null;
    }
  }
}

/**
 * Refuses an upgrade on the raw socket, since there is no `Response` object to
 * return on Node's `upgrade` path.
 *
 * @param socket - The raw duplex socket
 * @param status - The HTTP status to answer with
 * @since 0.2.0
 */
export function rejectRawUpgrade(socket: RawUpgradeSocket, status: number): void {
  const reason = status === 503
    ? 'Service Unavailable'
    : status === 501
    ? 'Not Implemented'
    : status === 500
    ? 'Internal Server Error'
    : 'Bad Request';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
