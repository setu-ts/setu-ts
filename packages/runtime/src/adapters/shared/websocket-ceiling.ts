/**
 * The per-message ceiling a runtime puts on WebSocket frames, and the one
 * report an adapter makes when the application asks for more.
 *
 * @module
 */
import type { WebSocketEventSink } from '@setu-ts/common';

/**
 * Bun's per-message ceiling. Bun refuses a larger message itself (close 1009),
 * before the plugin sees it. Passed explicitly as `maxPayloadLength`, so it is
 * this adapter's number rather than a hidden Bun default.
 */
export const BUN_WS_MAX_MESSAGE_BYTES: number = 16 * 1024 * 1024;

/**
 * Deno's per-message ceiling, fixed by Deno: a larger message is dropped with
 * close 1006 and no close frame.
 */
export const DENO_WS_MAX_MESSAGE_BYTES: number = 64 * 1024 * 1024;

/**
 * Reports, once per server, the first handshake whose configured limit the
 * runtime cannot honour: `0` (unlimited) or a bound above the ceiling.
 *
 * @internal - Not exported from package index
 */
export class WebSocketCeilingReport {
  readonly #ceiling: number;
  readonly #platform: string;
  readonly #reportError: ((record: Readonly<Record<string, unknown>>) => void) | undefined;
  #reported = false;

  /**
   * @param ceiling - The runtime's per-message ceiling in bytes
   * @param platform - The runtime's name, for the record
   * @param reportError - The adapter's last-resort error channel
   */
  constructor(
    ceiling: number,
    platform: string,
    reportError: ((record: Readonly<Record<string, unknown>>) => void) | undefined,
  ) {
    this.#ceiling = ceiling;
    this.#platform = platform;
    this.#reportError = reportError;
  }

  /**
   * Checks one handshake's sink.
   *
   * @param sink - The sink the upgrade binds to
   */
  check(sink: WebSocketEventSink): void {
    const configured = sink.maxMessageBytes;
    if (this.#reported || configured === undefined) return;
    if (configured !== 0 && configured <= this.#ceiling) return;
    this.#reported = true;
    try {
      this.#reportError?.({
        level: 'warn',
        msg: 'WebSocket message limit exceeds the runtime ceiling',
        configured,
        ceiling: this.#ceiling,
        platform: this.#platform,
      });
    } catch {
      // Reporting must never change the handshake.
    }
  }
}
