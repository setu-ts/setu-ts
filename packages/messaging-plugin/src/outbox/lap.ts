/**
 * The state of one relay lap over one store's pending set (M107 §3.6).
 *
 * A lap is seeded ONCE, at its start, from the store's failed keys; it then
 * persists across sweeps — cursor, blocked set and `capReached` together —
 * until a short page shows every pending row has been examined. Seeding only
 * at lap start is what makes a resumed sweep safe: every row before the
 * cursor was examined in THIS lap, so any key that must stay blocked is
 * already blocked. Re-seeding mid-lap would drop a key whose blocking row was
 * released meanwhile while its later rows sit behind the cursor.
 *
 * @module
 */
import type { OutboxKey } from '@setu-ts/common';

import { blockKey } from './position.ts';

/** The most keys one lap's blocked set holds (M107 §3.6, N6). */
export const MAX_BLOCKED_KEYS = 10_000;

/**
 * One lap's cursor, blocked set and cap flags.
 *
 * @internal
 */
export class OutboxLap {
  readonly #blocked = new Set<string>();
  readonly #maxBlocked: number;
  #cursor: string | undefined;
  #capReached = false;
  #blockedOverflow = false;

  /**
   * Starts a lap, seeding the blocked set from the store's failed keys.
   *
   * @param failed - What `failedKeys(maxFailedScan)` returned
   * @param maxFailedScan - The limit that call was made with; a full answer
   *   may be incomplete, so the whole lap is `capReached`
   * @param maxBlocked - The blocked-set cap (fixed at
   *   {@linkcode MAX_BLOCKED_KEYS} outside tests)
   */
  constructor(
    failed: readonly OutboxKey[],
    maxFailedScan: number,
    maxBlocked: number = MAX_BLOCKED_KEYS,
  ) {
    this.#maxBlocked = maxBlocked;
    for (const key of failed) {
      // An unkeyed failed row blocks nothing: unkeyed rows are never ordered.
      if (key.orderingKey !== undefined) this.block(blockKey(key.tenantId, key.orderingKey));
    }
    if (failed.length >= maxFailedScan) this.#capReached = true;
  }

  /** The position of the last examined row; `undefined` before the first. */
  get cursor(): string | undefined {
    return this.#cursor;
  }

  /**
   * Whether every keyed row for the rest of the lap is skipped: the failed
   * scan may be incomplete, or the blocked set overflowed.
   */
  get capReached(): boolean {
    return this.#capReached;
  }

  /** Whether THIS lap's blocked set overflowed {@linkcode MAX_BLOCKED_KEYS}. */
  get blockedOverflow(): boolean {
    return this.#blockedOverflow;
  }

  /** How many keys are blocked. */
  get blockedSize(): number {
    return this.#blocked.size;
  }

  /**
   * Whether a key is blocked for the rest of the lap.
   *
   * @param key - A {@linkcode blockKey}
   * @returns `true` when blocked
   */
  isBlocked(key: string): boolean {
    return this.#blocked.has(key);
  }

  /**
   * Blocks a key for the rest of the lap. An insertion that would exceed the
   * cap sets `capReached` instead, so no keyed row is published for the rest
   * of the lap — an incomplete blocked set never publishes a keyed row.
   *
   * @param key - A {@linkcode blockKey}
   */
  block(key: string): void {
    if (this.#blocked.has(key)) return;
    if (this.#blocked.size >= this.#maxBlocked) {
      this.#capReached = true;
      this.#blockedOverflow = true;
      return;
    }
    this.#blocked.add(key);
  }

  /**
   * Moves the cursor onto a row just examined. The cursor advances one
   * examined row at a time, never to a page's last row.
   *
   * @param position - The examined row's position
   */
  advance(position: string): void {
    this.#cursor = position;
  }
}
