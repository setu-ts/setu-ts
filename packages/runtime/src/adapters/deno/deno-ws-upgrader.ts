/**
 * Deno WebSocket upgrade — completes an RFC 6455 handshake with
 * `Deno.upgradeWebSocket` and binds the resulting socket to a
 * {@linkcode WebSocketEventSink}.
 *
 * The upgrade runs on the fetch path *before* `mapWebRequestToFrameworkRequest`,
 * which is a correctness requirement rather than an optimization: that mapping
 * pre-reads the body via `arrayBuffer()`, and Deno documents that upgrading
 * fails once the request body has been disturbed.
 *
 * @module
 * @since 0.2.0
 */

import type { WebSocketEventSink } from '@setu-ts/common';
import type { WebSocketLike } from '../shared/web-socket-transport.ts';
import {
  createWebSocketTransport,
  normalizeFrame,
  toTransportError,
} from '../shared/web-socket-transport.ts';

/**
 * A web-API socket that exposes the `on*` handler properties, as Deno's
 * `upgradeWebSocket` socket does.
 *
 * @since 0.2.0
 */
export interface DenoWebSocketLike extends WebSocketLike {
  /** Fires once the socket is writable. */
  onopen: ((event: unknown) => void) | null;
  /** Fires per inbound frame. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Fires once on close. */
  onclose: ((event: { code: number; reason: string }) => void) | null;
  /** Fires on transport error. */
  onerror: ((event: unknown) => void) | null;
}

/**
 * The result shape of `Deno.upgradeWebSocket`.
 *
 * @since 0.2.0
 */
export interface DenoWebSocketUpgrade {
  /** The server-side socket. */
  readonly socket: DenoWebSocketLike;
  /** The 101 response that must be returned from the fetch handler. */
  readonly response: Response;
}

/**
 * Binds a Deno socket's event handlers to a sink.
 *
 * `onopen` is what drives {@linkcode WebSocketEventSink.onOpen}, so the sink is
 * never handed a transport it cannot yet write to.
 *
 * @param socket - The native socket
 * @param sink - The sink to drive
 * @since 0.2.0
 */
export function bindDenoSocketToSink(socket: DenoWebSocketLike, sink: WebSocketEventSink): void {
  const transport = createWebSocketTransport(socket);

  socket.onopen = (): void => {
    sink.onOpen(transport);
  };
  socket.onmessage = (event: { data: unknown }): void => {
    sink.onMessage(normalizeFrame(event.data));
  };
  socket.onclose = (event: { code: number; reason: string }): void => {
    sink.onClose({ code: event.code, reason: event.reason });
  };
  socket.onerror = (event: unknown): void => {
    sink.onError(toTransportError(event));
  };
}
