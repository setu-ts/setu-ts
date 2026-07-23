/**
 * Bulkhead pattern — a concurrency limiter with a bounded FIFO waiter queue.
 *
 * @module
 */
import type { BulkheadPolicy } from '@hono-enterprise/common';
import { BulkheadFullError } from '../errors.ts';

/**
 * Caps concurrent in-flight executions and sheds excess load once the queue is
 * full. Internal to the resilience plugin — not exported from `src/index.ts`.
 */
export class Bulkhead {
  readonly #maxConcurrent: number;
  readonly #maxQueue: number;

  /** In-flight execution count. */
  #active = 0;
  /** FIFO queue of resolvers awaiting an execution slot. */
  #queue: Array<() => void> = [];

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

  /**
   * Runs `fn` in a concurrency slot, queuing if saturated and shedding if the
   * queue is also full.
   *
   * @typeParam T - The protected call's result type
   * @param fn - The protected call
   * @returns The call result
   * @throws {BulkheadFullError} When concurrency is saturated and the queue is
   * full
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maxConcurrent) {
      if (this.#queue.length >= this.#maxQueue) {
        throw new BulkheadFullError();
      }
      await new Promise<void>((resolve) => {
        this.#queue.push(resolve);
      });
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      const next = this.#queue.shift();
      if (next !== undefined) {
        next();
      }
    }
  }
}
