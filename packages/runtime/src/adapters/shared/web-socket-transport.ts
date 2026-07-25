/**
 * Shared WebSocket transport normalization — turns a web-API socket into the
 * framework's {@linkcode IWebSocketTransport} and normalizes inbound frames.
 *
 * Deno, Bun, and Cloudflare Workers all expose web-standard sockets, so this
 * conversion lives here once instead of three times (AI_GUIDELINES §11.1).
 * Node's `ws` socket is not web-standard and has its own transport in
 * `node/node-ws-upgrader.ts`.
 *
 * @module
 * @since 0.2.0
 */

import type { IWebSocketTransport, WebSocketReadyState } from '@hono-enterprise/common';

/**
 * The subset of the web `WebSocket` API the runtime adapters drive. Declared
 * structurally so no module depends on a platform's global types and a fake
 * can stand in during unit tests.
 *
 * @since 0.2.0
 */
export interface WebSocketLike {
  /** Numeric ready state, per the web WebSocket API. */
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
}

/** Numeric ready states of the web WebSocket API. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;

/**
 * RFC 6455 close code `1006` — the connection ended without a close frame.
 *
 * Adapters report it through {@linkcode WebSocketEventSink.onClose} when a
 * handshake fails *after* the upgrade router accepted, so a consumer holding
 * resources for the pending socket (e.g. a reserved connection slot) learns the
 * connection is over instead of waiting on a socket that will never open.
 *
 * @since 0.2.0
 */
export const ABNORMAL_CLOSURE = 1006;

/**
 * Maps the web WebSocket API's numeric `readyState` to the framework's named
 * {@linkcode WebSocketReadyState}.
 *
 * @param state - The numeric ready state
 * @returns The named ready state
 * @since 0.2.0
 */
export function toReadyState(state: number): WebSocketReadyState {
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
 * Normalizes an inbound frame payload to the framework's `string | Uint8Array`.
 *
 * Binary frames arrive as `ArrayBuffer` on Deno and Workers and may arrive as a
 * typed-array view elsewhere; both become a `Uint8Array` view without copying.
 * Anything else is stringified so a handler never receives an unusable value.
 *
 * @param data - The raw event payload
 * @returns The normalized payload
 * @since 0.2.0
 */
export function normalizeFrame(data: unknown): string | Uint8Array {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return String(data);
}

/**
 * Coerces an error-event payload into a real `Error`.
 *
 * @param value - The raw error payload
 * @returns An `Error` describing the transport failure
 * @since 0.2.0
 */
export function toTransportError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error('WebSocket transport error');
}

/**
 * Wraps a web-API socket as an {@linkcode IWebSocketTransport}.
 *
 * `readyState` is read through a getter so the transport always reports the
 * socket's live state rather than a value captured at wrap time.
 *
 * @param socket - The native socket
 * @returns The normalized transport
 * @since 0.2.0
 */
export function createWebSocketTransport(socket: WebSocketLike): IWebSocketTransport {
  return {
    get readyState(): WebSocketReadyState {
      return toReadyState(socket.readyState);
    },
    send(data: string | Uint8Array): void {
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason);
    },
  };
}
