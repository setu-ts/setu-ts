/**
 * Bulkhead pattern — a concurrency limiter with a bounded FIFO waiter queue.
 *
 * @module
 */
import type { BulkheadPolicy, ResilientCall } from '@hono-enterprise/common';
import { BulkheadFullError } from '../errors.ts';
import { abortReasonOf, throwIfAborted } from './abort.ts';

/**
 * A waiter parked in the FIFO queue.
 *
 * It carries both settlement paths, because a queued caller can leave the queue
 * two ways: a slot frees up (`grant`), or its signal aborts (`cancel`).
 */
interface QueuedWaiter {
  /** Admits the waiter to a concurrency slot. */
  readonly grant: () => void;
  /** Rejects the waiter and detaches its abort listener. */
  readonly cancel: (reason: Error) => void;
}

/**
 * Caps concurrent in-flight executions and sheds excess load once the queue is
 * full. Internal to the resilience plugin — not exported from `src/index.ts`.
 */
export class Bulkhead {
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;

  /** In-flight execution count. */
  #active = 0;
  /** FIFO queue of waiters awaiting an execution slot. */
  #queue: QueuedWaiter[] = [];

  /**
   * @param policy - The concurrency limit and queue bound
   */
  constructor(policy: BulkheadPolicy) {
    this.#maxConcurrent = policy.maxConcurrent;
    this.#maxQueue = policy.maxQueue ?? 0;
  }

  /** The current in-flight execution count. */
  get active(): number {
    return this.#active;
  }

  /** The current number of queued waiters. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Runs `fn` in a concurrency slot, queuing if saturated and shedding if the
   * queue is also full.
   *
   * A waiter whose `signal` aborts while queued leaves the queue and rejects
   * with the abort reason, and its `fn` never runs. Without that path a
   * cancelled call would keep occupying queue depth and eventually execute —
   * the same "keeps running after cancellation" defect the timeout layer had,
   * relocated to the queue.
   *
   * @typeParam T - The protected call's result type
   * @param fn - The protected call, handed the cancellation signal
   * @param signal - Optional caller-owned signal cancelling the call
   * @returns The call result
   * @throws {BulkheadFullError} When concurrency is saturated and the queue is
   * full
   * @throws {Error} The abort reason when the signal aborts before or while
   * queued
   */
  async run<T>(fn: ResilientCall<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);

    if (this.#active >= this.#maxConcurrent) {
      if (this.#queue.length >= this.#maxQueue) {
        throw new BulkheadFullError();
      }
      await this.#waitForSlot(signal);
    }

    this.#active++;
    try {
      return await fn(signal ?? new AbortController().signal);
    } finally {
      this.#active--;
      this.#releaseSlot();
    }
  }

  /**
   * Parks the caller until a slot frees up or `signal` aborts.
   *
   * @param signal - Optional signal cancelling the wait
   * @returns A promise settling on admission
   * @throws {Error} The abort reason when cancelled while queued
   */
  #waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Replaced below only when there is a signal to detach from, which is
      // what keeps `signal` narrowed inside the listener instead of cast.
      let detach = (): void => {};

      const waiter: QueuedWaiter = {
        grant: (): void => {
          if (settled) {
            return;
          }
          settled = true;
          detach();
          resolve();
        },
        cancel: (reason: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          detach();
          reject(reason);
        },
      };

      if (signal !== undefined) {
        const onAbort = (): void => {
          // Leave the queue before rejecting, so the freed depth is immediately
          // available and no slot is ever handed to an abandoned waiter.
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) {
            this.#queue.splice(index, 1);
          }
          waiter.cancel(abortReasonOf(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detach = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      this.#queue.push(waiter);
    });
  }

  /** Hands the freed slot to the next waiter still in the queue. */
  #releaseSlot(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next.grant();
    }
  }
}
