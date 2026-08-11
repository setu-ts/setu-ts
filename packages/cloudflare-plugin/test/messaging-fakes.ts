/**
 * Fixtures shared by the messaging tests.
 *
 * @module
 */

import type { TimerHandle } from '@setu-ts/common';
import type { BrokerRuntime } from '../src/messaging/workers-broker.ts';

/**
 * A runtime whose timers never fire on their own and whose ids are sequential.
 *
 * The handle is an OBJECT rather than a number, deliberately: `TimerHandle` is
 * opaque in `common`, and the M53 defect where a broker stored one with
 * `Number(...)` and silently produced `NaN` was invisible to every fake that
 * handed out numbers.
 */
export class FakeBrokerRuntime implements BrokerRuntime {
  readonly scheduled: { readonly handle: object; readonly fn: () => void; readonly ms: number }[] =
    [];
  readonly cleared: TimerHandle[] = [];
  /** Fixed wall clock, so `MessageMetadata.timestamp` is assertable. */
  epoch = 1_700_000_000_000;

  #next = 1;

  uuid(): string {
    const id = `id-${this.#next}`;
    this.#next += 1;
    return id;
  }

  now(): number {
    return this.epoch;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = { index: this.scheduled.length };
    this.scheduled.push({ handle, fn, ms });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.cleared.push(handle);
  }

  /** Fires the timer scheduled at `index`, as the runtime would. */
  fire(index: number): void {
    this.scheduled[index]?.fn();
  }

  /** How many scheduled timers have not been cleared. */
  get outstandingTimers(): number {
    return this.scheduled.length - this.cleared.length;
  }
}

/** A producer whose `send` rejects, reproducing a queue that refused a write. */
export class ExplodingQueueProducer {
  readonly sends: unknown[] = [];

  send(body: unknown): Promise<void> {
    this.sends.push(body);
    return Promise.reject(new Error('queue send failed'));
  }

  sendBatch(): Promise<void> {
    return Promise.reject(new Error('queue sendBatch failed'));
  }
}
