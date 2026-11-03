/** Single-process weighted counters; expiry is swept on access. @module */
import type { IRuntimeServices } from '@setu-ts/common';
import type { IQuotaStore } from './quota.ts';

/** In-process quota storage with a synchronous atomic critical section. @since 0.13.0 */
export class MemoryQuotaStore implements IQuotaStore {
  readonly #runtime: IRuntimeServices;
  readonly #windows = new Map<string, { used: number; expireAt: number }>();

  /** @param runtime - Clock used to sweep expired windows */
  constructor(runtime: IRuntimeServices) {
    this.#runtime = runtime;
  }

  #sweep(): void {
    const now = this.#runtime.now();
    for (const [key, value] of this.#windows) {
      if (value.expireAt <= now) this.#windows.delete(key);
    }
  }

  /** @inheritdoc */
  reserve(
    key: string,
    windowId: string,
    amount: number,
    limit: number | undefined,
    expireAt: number,
  ): Promise<{ admitted: boolean; used: number }> {
    this.#sweep();
    const storeKey = `${key}:${windowId}`;
    const used = this.#windows.get(storeKey)?.used ?? 0;
    if (limit !== undefined && amount > limit - used)
      return Promise.resolve({ admitted: false, used });
    const next = used + amount;
    this.#windows.set(storeKey, { used: next, expireAt });
    return Promise.resolve({ admitted: true, used: next });
  }

  /** @inheritdoc */
  adjust(key: string, windowId: string, delta: number, expireAt: number): Promise<void> {
    this.#sweep();
    const storeKey = `${key}:${windowId}`;
    const used = Math.max(0, (this.#windows.get(storeKey)?.used ?? 0) + delta);
    this.#windows.set(storeKey, { used, expireAt });
    return Promise.resolve();
  }
}
