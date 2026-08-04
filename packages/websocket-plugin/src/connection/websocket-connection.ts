/**
 * {@linkcode WebSocketConnection} — the application-facing view of one live
 * socket, wrapping the runtime-agnostic {@linkcode IWebSocketTransport} the
 * HTTP adapter produced.
 *
 * @module
 * @since 0.1.0
 */

import type {
  IWebSocketConnection,
  IWebSocketTransport,
  WebSocketReadyState,
} from '@hono-enterprise/common';

/**
 * A live WebSocket connection.
 *
 * Tracks the monotonic timestamp of the last inbound frame so the heartbeat
 * sweeper can find idle peers, and refuses writes once closed rather than
 * failing deep inside a platform socket.
 *
 * @since 0.1.0
 */
export class WebSocketConnection implements IWebSocketConnection {
  readonly #transport: IWebSocketTransport;
  readonly #id: string;
  readonly #path: string;
  readonly #data = new Map<string, unknown>();
  readonly #heartbeat: boolean;
  #closed = false;
  #lastSeenAt: number;

  /**
   * Creates a connection.
   *
   * @param id - Unique connection ID (from `runtime.uuid()`)
   * @param path - The path the connection was opened on
   * @param transport - The runtime-agnostic socket
   * @param now - The current monotonic timestamp (`runtime.hrtime()`)
   * @param heartbeat - Whether this connection participates in the shared heartbeat sweep
   */
  constructor(
    id: string,
    path: string,
    transport: IWebSocketTransport,
    now: number,
    heartbeat: boolean = true,
  ) {
    this.#id = id;
    this.#path = path;
    this.#transport = transport;
    this.#lastSeenAt = now;
    this.#heartbeat = heartbeat;
  }

  /**
   * Whether the shared heartbeat sweeper should include this connection.
   * When `false`, the sweeper skips both the payload send and idle eviction.
   */
  get participatesInHeartbeat(): boolean {
    return this.#heartbeat;
  }

  get id(): string {
    return this.#id;
  }

  get path(): string {
    return this.#path;
  }

  get data(): Map<string, unknown> {
    return this.#data;
  }

  get readyState(): WebSocketReadyState {
    return this.#closed ? 'closed' : this.#transport.readyState;
  }

  get isOpen(): boolean {
    return !this.#closed && this.#transport.readyState === 'open';
  }

  /**
   * The monotonic timestamp of the most recent inbound frame. Compared against
   * another `runtime.hrtime()` reading — never against a wall clock.
   */
  get lastSeenAt(): number {
    return this.#lastSeenAt;
  }

  /**
   * Records that a frame arrived, resetting the idle countdown.
   *
   * @param now - The current monotonic timestamp (`runtime.hrtime()`)
   */
  touch(now: number): void {
    this.#lastSeenAt = now;
  }

  send(data: string | Uint8Array): void {
    if (!this.isOpen) {
      throw new Error(`Cannot send on WebSocket connection ${this.#id}: it is not open`);
    }
    this.#transport.send(data);
  }

  sendJson<T>(payload: T): void {
    this.send(JSON.stringify(payload));
  }

  close(code?: number, reason?: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#transport.close(code, reason);
  }

  /**
   * Marks the connection closed without touching the transport — used when the
   * peer closed first, so the socket is already gone.
   */
  markClosed(): void {
    this.#closed = true;
  }
}
