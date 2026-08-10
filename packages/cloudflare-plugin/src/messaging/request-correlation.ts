/**
 * Correlates a brokered request with the reply that answers it.
 *
 * Purpose-built rather than reused. `messaging-plugin` ships a
 * `RequestReplyCore` for exactly this job, but AI_GUIDELINES §2.2 forbids a
 * plugin importing another plugin, and it is also the wrong shape here: that
 * core carries the reply back over the broker's own `publish`, whereas on
 * Workers the request rides a queue and the reply arrives **pushed** over a
 * Durable Object socket that no `publish` call produced. Reusing it would mean
 * gutting the half that does not apply.
 *
 * What is carried over deliberately is its generation counter, because the bug
 * that motivated it — a `disconnect()` landing while an inbox open is still in
 * flight, leaving a live subscription nothing owns — is transport-independent.
 *
 * @module
 * @since 0.2.0
 */

import type { TimerHandle } from '@setu-ts/common';
import { CloudflareRemoteHandlerError, CloudflareRequestTimeoutError } from '../errors.ts';
import type { ReplyEnvelope } from './message-envelope.ts';

/** Reply budget when `RequestOptions.timeoutMs` and the arm both omit one. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** The timer primitives this manager composes; `IRuntimeServices` satisfies it. */
export interface CorrelationTimers {
  /**
   * Schedules the timeout rejection.
   *
   * @param fn - Invoked when the budget elapses
   * @param ms - The budget
   * @returns The handle to cancel with
   */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /**
   * Cancels a scheduled timeout.
   *
   * @param handle - The handle from {@linkcode CorrelationTimers.setTimeout}
   */
  clearTimeout(handle: TimerHandle): void;
}

/** A request awaiting its correlated reply. */
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: TimerHandle;
}

/**
 * Tracks in-flight requests and settles each one when its reply arrives.
 *
 * @since 0.2.0
 */
export class RequestCorrelation {
  readonly #timers: CorrelationTimers;
  readonly #pending = new Map<string, Pending>();

  /**
   * @param timers - Timer primitives; pass `IRuntimeServices`
   */
  constructor(timers: CorrelationTimers) {
    this.#timers = timers;
  }

  /** How many requests are currently in flight. */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * Registers a request and returns the promise its reply settles.
   *
   * @typeParam TRes - The reply payload type
   * @param correlationId - The id the reply will carry
   * @param topic - The request topic, for the timeout message
   * @param timeoutMs - The reply budget
   * @returns The reply payload
   * @throws {CloudflareRequestTimeoutError} When the budget elapses first
   * @throws {CloudflareRemoteHandlerError} When the responder threw
   * @since 0.2.0
   */
  register<TRes>(correlationId: string, topic: string, timeoutMs: number): Promise<TRes> {
    return new Promise<TRes>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new CloudflareRequestTimeoutError(topic, timeoutMs));
      }, timeoutMs);

      this.#pending.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  /**
   * Abandons a registered request without settling it.
   *
   * Used when the publish that would have carried the request fails: the caller
   * is about to receive that failure directly, so leaving the entry behind
   * would keep a timer alive for a request that never left.
   *
   * @param correlationId - The request to abandon
   * @since 0.2.0
   */
  abandon(correlationId: string): void {
    const pending = this.#pending.get(correlationId);
    if (pending === undefined) return;
    this.#timers.clearTimeout(pending.timer);
    this.#pending.delete(correlationId);
  }

  /**
   * Settles the request a reply correlates to.
   *
   * A reply with no pending entry is dropped rather than reported: it is the
   * ordinary consequence of at-least-once delivery (a duplicate) or of a reply
   * that lost the race with its own timeout, and neither is a fault.
   *
   * @param reply - The arriving reply
   * @returns Whether a pending request was settled
   * @since 0.2.0
   */
  settle(reply: ReplyEnvelope): boolean {
    const pending = this.#pending.get(reply.correlationId);
    if (pending === undefined) return false;

    this.#timers.clearTimeout(pending.timer);
    this.#pending.delete(reply.correlationId);

    if (reply.ok) {
      pending.resolve(reply.payload);
    } else {
      pending.reject(new CloudflareRemoteHandlerError(reply.error ?? 'unknown error'));
    }
    return true;
  }

  /**
   * Rejects every in-flight request and clears every timer.
   *
   * Called from `disconnect`, so a shutdown neither leaks a timer nor leaves a
   * caller awaiting a reply that can no longer arrive.
   *
   * @param reason - The rejection handed to each waiting caller
   * @since 0.2.0
   */
  rejectAll(reason: Error): void {
    for (const pending of this.#pending.values()) {
      this.#timers.clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
  }
}
