/**
 * Per-connection SSE streaming lifecycle.
 *
 * Owns the `ReadableStream`, captures its controller, sets SSE headers, calls
 * `ctx.response.stream(rs)` to obtain the `HandlerResult`, and manages
 * heartbeat/cleanup backed by `IRuntimeServices`.
 *
 * @module
 * @since 0.1.0
 */

import type {
  HandlerResult,
  IRequestContext,
  IRuntimeServices,
  ISseConnection as IConn,
  SseMessage,
  TimerHandle,
} from '@hono-enterprise/common';
import { encodeSseComment, encodeSseMessage } from '../utils/sse-frame.ts';
import { SSE_HWM_BYTES, SSE_MAX_BACKLOG_BYTES } from '../channels/channel-registry.ts';

/**
 * Implements {@linkcode IConn}.
 *
 * @since 0.1.0
 */
export class SseConnection implements IConn {
  readonly id: string;
  readonly lastEventId: string | null;
  #isOpen = true;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #heartBeatHandle: TimerHandle | null = null;
  readonly #encoder = new TextEncoder();
  readonly #onClosed: () => void;
  readonly #runtime: IRuntimeServices;

  /** The `HandlerResult` obtained from `ctx.response.stream()` — set in constructor. */
  declare readonly result: HandlerResult;

  constructor(
    ctx: IRequestContext,
    runtime: IRuntimeServices,
    heartbeatMs: number | undefined,
    retryMs: number | undefined,
    onClosed: () => void,
  ) {
    this.id = runtime.uuid();
    this.lastEventId = ctx.request.headers.get('last-event-id') ?? null;
    this.#onClosed = onClosed;
    this.#runtime = runtime;

    // Build ReadableStream with ByteLengthQueuingStrategy highWaterMark, capturing
    // controller via underlying source start().
    let captured: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          captured = controller;
        },
      },
      {
        size: () => SSE_HWM_BYTES,
      },
    );
    this.#controller = captured;

    // Set SSE response headers.
    ctx.response
      .header('content-type', 'text/event-stream')
      .header('cache-control', 'no-cache')
      .header('connection', 'keep-alive')
      .header('x-accel-buffering', 'no');

    // Obtain the HandlerResult — the stream body is NOT consumed here.
    Object.defineProperty(this, 'result', {
      value: ctx.response.stream(stream),
      enumerable: false,
      writable: false,
    });

    // Abort-driven cleanup (§3.3) — fires on client disconnect.
    ctx.signal.addEventListener('abort', () => this.#cleanup(), { once: true });

    // Heartbeat via runtime.setInterval (§3.4).
    if (heartbeatMs !== undefined) {
      this.#heartBeatHandle = runtime.setInterval(() => {
        if (this.#isOpen) {
          this.comment('heartbeat');
        }
      }, heartbeatMs);
    }

    // Initial retry frame: enqueue raw `retry: <ms>\n\n` as the very first bytes.
    if (retryMs !== undefined) {
      this.#enqueueRaw(`retry: ${retryMs}\n\n`);
    }
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  /** Enqueue an encoded SSE message. */
  send(msg: SseMessage): void {
    if (!this.#isOpen) return;
    this.#enqueue(encodeSseMessage(msg));
  }

  /** Enqueue a plain-text comment frame. */
  comment(text: string): void {
    if (!this.#isOpen) return;
    this.#enqueue(encodeSseComment(text));
  }

  /** Close the connection (idempotent). */
  close(): void {
    this.#cleanup();
  }

  /** Internal raw enqueue — writes a byte string directly. */
  #enqueueRaw(frame: string): void {
    if (!this.#isOpen || !this.#controller) return;
    this.#doEnqueue(frame);
  }

  /** Internal enqueue with backpressure guard (§3.6). */
  #enqueue(frame: string): void {
    if (!this.#isOpen || !this.#controller) return;
    this.#doEnqueue(frame);
  }

  #doEnqueue(frame: string): void {
    if (!this.#isOpen || !this.#controller) return;

    // Backpressure check (§3.6).
    const desired = this.#controller.desiredSize;
    if (desired !== null && desired < -SSE_MAX_BACKLOG_BYTES) {
      // Fail-fast: close the connection when backlog exceeds 1 MiB.
      this.#cleanup();
      return;
    }

    try {
      this.#controller.enqueue(this.#encoder.encode(frame));
    } catch {
      // Controller already closed.
      if (this.#isOpen) {
        this.#cleanup();
      }
    }
  }

  /** Idempotent cleanup (§3.3). */
  #cleanup(): void {
    if (!this.#isOpen) return;
    this.#isOpen = false;

    // Clear heartbeat interval.
    if (this.#heartBeatHandle !== null) {
      this.#runtime.clearInterval(this.#heartBeatHandle);
      this.#heartBeatHandle = null;
    }

    // Close the stream controller.
    if (this.#controller) {
      try {
        this.#controller.close();
      } catch {
        // Already closed.
      }
      this.#controller = null;
    }

    // Invoke the service callback to prune from live set & channels.
    this.#onClosed();
  }
}
