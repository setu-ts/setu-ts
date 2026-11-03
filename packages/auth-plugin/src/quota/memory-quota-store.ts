/** Single-process weighted counters; expired windows are swept in amortised batches. @module */
import type { IRuntimeServices } from '@setu-ts/common';
import { sweepExpired } from '../stores/sweep-expired.ts';
import type { IQuotaStore } from './quota.ts';

/**
 * In-process quota storage with a synchronous atomic critical section.
 * An expired window reads as empty; amortised sweeps reclaim expired windows,
 * keeping memory proportional to live windows plus the sweep slack (minimum 1,024).
 * @since 0.13.0
 */
export class MemoryQuotaStore implements IQuotaStore {
  readonly #runtime: IRuntimeServices;
  readonly #windows = new Map<string, { used: number; expireAt: number }>();
  #sweepAt = 1_024;

  /** @param runtime - Clock used to expire windows */
  constructor(runtime: IRuntimeServices) {
    this.#runtime = runtime;
  }

  #used(storeKey: string): number {
    const now = this.#runtime.now();
    this.#sweepAt = sweepExpired(this.#windows, this.#sweepAt, (entry) => entry.expireAt <= now);
    const entry = this.#windows.get(storeKey);
    return entry === undefined || entry.expireAt <= now ? 0 : entry.used;
  }

  /** @inheritdoc */
  reserve(
    key: string,
    windowId: string,
    amount: number,
    limit: number | undefined,
    expireAt: number,
  ): Promise<{ admitted: boolean; used: number }> {
    const storeKey = `${key}:${windowId}`;
    const used = this.#used(storeKey);
    if (limit !== undefined && amount > limit - used)
      return Promise.resolve({ admitted: false, used });
    const next = used + amount;
    this.#windows.set(storeKey, { used: next, expireAt });
    return Promise.resolve({ admitted: true, used: next });
  }

  /** @inheritdoc */
  adjust(key: string, windowId: string, delta: number, expireAt: number): Promise<void> {
    const storeKey = `${key}:${windowId}`;
    const used = Math.max(0, this.#used(storeKey) + delta);
    this.#windows.set(storeKey, { used, expireAt });
    return Promise.resolve();
  }
}
