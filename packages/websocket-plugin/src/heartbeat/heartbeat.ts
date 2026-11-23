/**
 * {@linkcode HeartbeatSweeper} — the single interval that keeps peers warm and
 * evicts silent ones.
 *
 * The heartbeat is an application-level text frame rather than an RFC 6455 ping:
 * the web `WebSocket` API on Deno and Cloudflare Workers exposes no `ping()`, so
 * a protocol ping would silently no-op on half the supported runtimes.
 *
 * @module
 * @since 0.1.0
 */

import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import type { WebSocketConnection } from '../connection/websocket-connection.ts';

/** Close code sent to a peer that went silent (RFC 6455 "going away"). */
const CLOSE_GOING_AWAY = 1001;

/**
 * Configuration for the sweeper.
 *
 * @since 0.1.0
 */
export interface HeartbeatOptions {
  /** Tick interval in milliseconds; `0` disables the sweeper entirely. */
  readonly heartbeatMs: number;
  /** The text frame sent on each tick. */
  readonly heartbeatPayload: string;
  /** Inbound silence in milliseconds after which a connection is closed; `0` disables. */
  readonly idleTimeoutMs: number;
}

/**
 * Sends heartbeats and closes idle connections on one shared interval.
 *
 * @since 0.1.0
 */
export class HeartbeatSweeper {
  readonly #runtime: IRuntimeServices;
  readonly #options: HeartbeatOptions;
  readonly #connections: () => Iterable<WebSocketConnection>;
  #timer: TimerHandle | null = null;

  /**
   * Creates the sweeper.
   *
   * @param runtime - Runtime services, for timers and the monotonic clock
   * @param options - Heartbeat configuration
   * @param connections - Supplies the current connections on each tick
   */
  constructor(
    runtime: IRuntimeServices,
    options: HeartbeatOptions,
    connections: () => Iterable<WebSocketConnection>,
  ) {
    this.#runtime = runtime;
    this.#options = options;
    this.#connections = connections;
  }

  /** Whether the interval is currently running. */
  get isRunning(): boolean {
    return this.#timer !== null;
  }

  /**
   * Starts the interval. A no-op when heartbeats are disabled, so a plugin
   * left at its defaults never creates a timer.
   */
  start(): void {
    if (this.#options.heartbeatMs <= 0 || this.#timer !== null) {
      return;
    }
    this.#timer = this.#runtime.setInterval(() => {
      this.tick();
    }, this.#options.heartbeatMs);
  }

  /** Stops the interval. Idempotent. */
  stop(): void {
    if (this.#timer === null) {
      return;
    }
    this.#runtime.clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Runs one sweep: closes connections that have been silent too long, then
   * sends the heartbeat payload to the rest.
   *
   * Exposed so tests drive a deterministic tick rather than waiting on a timer.
   */
  tick(): void {
    // Monotonic — never the wall clock, which would make the age meaningless.
    const now = this.#runtime.hrtime();
    for (const conn of this.#connections()) {
      sweepOne(conn, now, this.#options);
    }
  }
}

/**
 * One connection's share of a sweep: closes it when it has been silent too
 * long, otherwise sends the heartbeat payload.
 */
function sweepOne(conn: WebSocketConnection, now: number, options: HeartbeatOptions): void {
  if (!conn.isOpen) {
    return;
  }
  // Skip connections whose route opted out of the shared heartbeat (e.g.
  // graphql-transport-ws routes that speak their own ping/pong protocol).
  if (!conn.participatesInHeartbeat) {
    return;
  }
  try {
    if (options.idleTimeoutMs > 0 && now - conn.lastSeenAt >= options.idleTimeoutMs) {
      conn.close(CLOSE_GOING_AWAY, 'Idle timeout');
      return;
    }
    conn.send(options.heartbeatPayload);
  } catch {
    // This runs inside a timer callback, where a throw would escape as an
    // unhandled error AND skip every remaining connection — one unwritable
    // peer would stop heartbeats and idle eviction for the whole server.
    // The peer is left alone; its close event removes it.
  }
}

/**
 * Starts one connection's own heartbeat interval, for request-bound mode
 * (Cloudflare Workers): created from the connection's own request, so every
 * tick runs there and touches only its own socket. Same payload and idle rule
 * as {@linkcode HeartbeatSweeper}.
 *
 * @param runtime - Runtime services, for the timer and the monotonic clock
 * @param options - Heartbeat configuration
 * @param conn - The connection
 * @returns Stops the interval; a no-op when no interval was started
 * @since 0.14.0
 */
export function startConnectionHeartbeat(
  runtime: IRuntimeServices,
  options: HeartbeatOptions,
  conn: WebSocketConnection,
): () => void {
  if (options.heartbeatMs <= 0 || !conn.participatesInHeartbeat) {
    return () => {};
  }
  const timer = runtime.setInterval(() => {
    sweepOne(conn, runtime.hrtime(), options);
  }, options.heartbeatMs);
  return () => {
    runtime.clearInterval(timer);
  };
}
