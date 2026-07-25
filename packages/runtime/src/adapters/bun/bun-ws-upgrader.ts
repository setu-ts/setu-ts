/**
 * Bun WebSocket upgrade — completes a handshake with `server.upgrade()` and
 * routes Bun's serve-time socket handlers back to the framework's sinks.
 *
 * Bun's upgrade is intrinsically out-of-band: `server.upgrade` needs the
 * `Server` instance (reachable only as the fetch callback's second argument)
 * and the socket handlers must be supplied at `Bun.serve()` time. The sink is
 * therefore smuggled through the per-socket `data` bag that Bun attaches to the
 * upgraded socket, and the serve-time handlers read it back off `ws.data`.
 *
 * @module
 * @since 0.2.0
 */

import type { WebSocketEventSink } from '@hono-enterprise/common';
import type { WebSocketLike } from '../shared/web-socket-transport.ts';
import {
  createWebSocketTransport,
  normalizeFrame,
  toTransportError,
} from '../shared/web-socket-transport.ts';

/**
 * The per-socket data Bun carries from `server.upgrade()` through to every
 * socket handler.
 *
 * @since 0.2.0
 */
export interface BunSocketData {
  /** The sink this socket's events are routed to. */
  readonly sink: WebSocketEventSink;
}

/**
 * A Bun `ServerWebSocket`, narrowed to what this adapter drives.
 *
 * @since 0.2.0
 */
export interface BunServerWebSocket extends WebSocketLike {
  /** The data bag supplied to `server.upgrade()`. */
  readonly data: BunSocketData;
}

/**
 * The serve-time socket handler object Bun expects under `Bun.serve`'s
 * `websocket` option.
 *
 * @since 0.2.0
 */
export interface BunWebSocketHandlers {
  /**
   * Called once the socket is live.
   *
   * @param ws - The upgraded socket
   */
  open(ws: BunServerWebSocket): void;
  /**
   * Called per inbound frame.
   *
   * @param ws - The socket
   * @param message - The frame payload
   */
  message(ws: BunServerWebSocket, message: string | Uint8Array): void;
  /**
   * Called once on close.
   *
   * @param ws - The socket
   * @param code - RFC 6455 close code
   * @param reason - Close reason
   */
  close(ws: BunServerWebSocket, code: number, reason: string): void;
  /**
   * Called on transport error.
   *
   * @param ws - The socket
   * @param error - The error
   */
  error(ws: BunServerWebSocket, error: unknown): void;
}

/**
 * Builds the serve-time handler object that routes every Bun socket event to
 * the sink stored on that socket's `data`.
 *
 * One handler object serves every connection, which is exactly Bun's model —
 * per-connection state lives on `ws.data`, not in the handlers.
 *
 * @returns The handler object to pass as `Bun.serve`'s `websocket` option
 * @since 0.2.0
 */
export function createBunWebSocketHandlers(): BunWebSocketHandlers {
  return {
    open(ws: BunServerWebSocket): void {
      ws.data.sink.onOpen(createWebSocketTransport(ws));
    },
    message(ws: BunServerWebSocket, message: string | Uint8Array): void {
      ws.data.sink.onMessage(normalizeFrame(message));
    },
    close(ws: BunServerWebSocket, code: number, reason: string): void {
      ws.data.sink.onClose({ code, reason });
    },
    error(ws: BunServerWebSocket, error: unknown): void {
      ws.data.sink.onError(toTransportError(error));
    },
  };
}
