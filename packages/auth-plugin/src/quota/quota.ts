/** Weighted, reserve-then-settle quotas with epoch or UTC calendar windows. @module */
import type { IRuntimeServices } from '@setu-ts/common';
import { QuotaExceededError } from './refusal.ts';

/** An immutable receipt issued by one quota. @since 0.12.0 */
export type QuotaReservation = {
  /** Caller key, before the policy prefix. */
  readonly key: string;
  /** The window charged by the reservation. */
  readonly windowId: string;
  /** Reserved integer units. */
  readonly amount: number;
};

/** Atomic storage port for weighted quotas. @since 0.12.0 */
export interface IQuotaStore {
  /** Atomically admits and adds amount only if the limit permits it. */
  reserve(
    key: string,
    windowId: string,
    amount: number,
    limit: number | undefined,
    expireAt: number,
  ): Promise<{ admitted: boolean; used: number }>;
  /** Adjusts an existing window, keeping its usage between zero and MAX_SAFE_INTEGER. */
  adjust(key: string, windowId: string, delta: number, expireAt: number): Promise<void>;
  /** Closes owned resources. */
  close?(): Promise<void>;
}

/** Weighted quota configuration. @since 0.12.0 */
export type QuotaOptions = {
  /** Non-empty lowercase policy name, matching [a-z0-9-]+. */
  readonly name: string;
  /** Atomic counter storage. */
  readonly store: IQuotaStore;
  /** Integer units per window; a callback may return undefined for unlimited. */
  readonly limit: number | ((key: string) => number | undefined | Promise<number | undefined>);
  /** Positive epoch-aligned milliseconds or a UTC billing period. */
  readonly window: number | 'utc-day' | 'utc-month';
  /** Wall clock used for window selection and expiry. */
  readonly runtime: IRuntimeServices;
};

/** Reserves units before work, then reconciles actual usage once. @since 0.12.0 */
export interface IQuota {
  /** Reserves units, or throws QuotaExceededError without charging. */
  reserve(key: string, amount: number): Promise<QuotaReservation>;
  /** Settles an issued receipt once; fabricated or foreign receipts throw TypeError. */
  settle(reservation: QuotaReservation, actual: number): Promise<void>;
  /** Refunds an issued receipt once. */
  release(reservation: QuotaReservation): Promise<void>;
}

const DAY_MS = 86_400_000;

function validateAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Quota amounts and limits must be non-negative safe integers');
  }
}

function currentWindow(now: number, window: QuotaOptions['window']) {
  if (typeof window === 'number') {
    const id = Math.floor(now / window);
    const end = (id + 1) * window;
    return { id: String(id), end, expireAt: end + DAY_MS };
  }
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const start = Date.UTC(year, month, window === 'utc-day' ? day : 1);
  const end = window === 'utc-day' ? start + DAY_MS : Date.UTC(year, month + 1, 1);
  return {
    id: date.toISOString().slice(0, window === 'utc-day' ? 10 : 7),
    end,
    expireAt: end + DAY_MS,
  };
}

/**
 * Creates a standalone weighted quota. No plugin or capability token is registered.
 * @param options - Policy, atomic store, window and runtime clock
 * @returns A quota whose receipts can be settled only by this instance
 * @throws {TypeError} For invalid configuration, keys or integer units
 * @example
 * ```typescript
 * const quota = createQuota({ name: 'spend', store, limit: 1000, window: 'utc-month', runtime });
 * const receipt = await quota.reserve('tenant-a', 100);
 * await quota.settle(receipt, 80);
 * ```
 * @since 0.12.0
 */
export function createQuota(options: QuotaOptions): IQuota {
  const { name, store, limit, window, runtime } = options;
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name))
    throw new TypeError('Quota name must match [a-z0-9-]+');
  if (typeof limit !== 'function') validateAmount(limit);
  if (
    typeof window === 'number'
      ? !Number.isSafeInteger(window) || window <= 0
      : window !== 'utc-day' && window !== 'utc-month'
  ) {
    throw new TypeError('Quota window must be positive integer milliseconds, utc-day or utc-month');
  }
  const issued = new WeakSet<QuotaReservation>();
  const settled = new WeakSet<QuotaReservation>();
  const expiries = new WeakMap<QuotaReservation, number>();
  const encoder = new TextEncoder();

  async function settle(reservation: QuotaReservation, actual: number): Promise<void> {
    validateAmount(actual);
    if (!issued.has(reservation))
      throw new TypeError('Quota reservation was not issued by this quota');
    if (settled.has(reservation)) return;
    // Mark synchronously before the store await, so concurrent settlements cannot refund twice.
    settled.add(reservation);
    await store.adjust(
      `${name}:${reservation.key}`,
      reservation.windowId,
      actual - reservation.amount,
      expiries.get(reservation)!,
    );
  }

  return {
    async reserve(key, amount): Promise<QuotaReservation> {
      validateAmount(amount);
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        !key.isWellFormed() ||
        encoder.encode(key).byteLength > 512
      ) {
        throw new TypeError('Quota key must be well-formed, non-empty and at most 512 UTF-8 bytes');
      }
      const resolvedLimit = typeof limit === 'function' ? await limit(key) : limit;
      if (resolvedLimit !== undefined) validateAmount(resolvedLimit);
      const now = runtime.now();
      const period = currentWindow(now, window);
      const result = await store.reserve(
        `${name}:${key}`,
        period.id,
        amount,
        resolvedLimit,
        period.expireAt,
      );
      if (!result.admitted)
        throw new QuotaExceededError(name, Math.max(1, Math.ceil((period.end - now) / 1000)));
      const reservation = Object.freeze({ key, windowId: period.id, amount });
      issued.add(reservation);
      expiries.set(reservation, period.expireAt);
      return reservation;
    },
    settle,
    release(reservation): Promise<void> {
      return settle(reservation, 0);
    },
  };
}
