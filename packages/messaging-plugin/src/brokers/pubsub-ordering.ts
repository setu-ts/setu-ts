/** Serial handler dispatch per Pub/Sub ordering key. @module */

/** Minimal delivery identity and nack operation owned by the gate. @since 0.14.0 */
export interface IOrderedDelivery {
  /** Native ordering key, absent for concurrent delivery. @since 0.14.0 */
  readonly orderingKey?: string;
  /** Platform delivery identity, used to recognize redelivery. @since 0.14.0 */
  readonly messageId?: string;
  /**
   * Returns the message to the platform.
   * @returns Nothing
   * @throws When the transport refuses settlement
   * @since 0.14.0
   */
  nack(): void;
}

/**
 * Most ordering keys whose state is kept. A key whose failed message was
 * dead-lettered never sees it again, so its hold-back state would otherwise
 * live until the stream closes; past this bound the least recently used idle
 * key is forgotten. If that key's failed message is still awaiting redelivery,
 * its next message can then run first (out of order); the gate reports that
 * case through `onRecentEviction`.
 */
export const MAX_ORDERING_KEYS = 10_000;

/**
 * Longest Pub/Sub retry backoff (600 s) plus a margin. A failure older than this
 * has most likely been redelivered or dead-lettered; Pub/Sub applies its retry
 * policy best effort, so this is a heuristic for the warning, not a guarantee.
 */
const REDELIVERY_WINDOW_MS = 660_000;

/** Bound delivery identities retained during one key's retry hold. */
const MAX_NACKED_IDS = 1000;

type KeyState = {
  tail: Promise<void>;
  nacked: Set<string>;
  pending: number;
  failedAt: number;
};

/** Per-key completion barriers survive stream replacement; buffered callbacks do not. @since 0.14.0 */
export class PubSubOrdering {
  readonly #keys = new Map<string, KeyState>();
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #onRecentEviction: () => void;
  #generation = 0;

  /**
   * @param now - Monotonic clock in milliseconds (`runtime.hrtime`)
   * @param onRecentEviction - Called when a key is evicted whose failed message may still be redelivered
   * @param maxKeys - Most keys kept (tests lower it)
   * @returns The ordering gate
   * @throws Never
   * @since 0.14.0
   */
  constructor(
    now: () => number,
    onRecentEviction: () => void = () => {},
    maxKeys: number = MAX_ORDERING_KEYS,
  ) {
    this.#now = now;
    this.#onRecentEviction = onRecentEviction;
    this.#maxKeys = maxKeys;
  }

  /**
   * Runs one delivery after its key's earlier work settles.
   * @param message - Platform delivery
   * @param dispatch - Handler and settlement; true means successful processing
   * @returns Completion of this delivery, or of dropping a buffered delivery
   * @throws When dispatch or settlement fails
   * @since 0.14.0
   */
  run(message: IOrderedDelivery, dispatch: () => Promise<boolean>): Promise<void> {
    const key = message.orderingKey;
    if (key === undefined || key === '') return dispatch().then(() => {});
    const existing = this.#keys.get(key);
    const state = existing ?? {
      tail: Promise.resolve(),
      nacked: new Set<string>(),
      pending: 0,
      failedAt: 0,
    };
    // Re-insert so the map's order is least recently used first.
    if (existing !== undefined) this.#keys.delete(key);
    else this.#evictIdle();
    this.#keys.set(key, state);
    state.pending++;
    const generation = this.#generation;
    const task = state.tail.then(async () => {
      if (generation !== this.#generation) return;
      if (message.messageId !== undefined && state.nacked.has(message.messageId))
        state.nacked.clear();
      if (state.nacked.size > 0) {
        if (message.messageId !== undefined) {
          // Keep recent followers observable if the head and older followers
          // were dead-lettered and will never return to release this key.
          if (state.nacked.size === MAX_NACKED_IDS)
            state.nacked.delete(state.nacked.values().next().value!);
          state.nacked.add(message.messageId);
        }
        message.nack();
        return;
      }
      const success = await dispatch();
      if (generation === this.#generation && !success && message.messageId !== undefined) {
        state.nacked.add(message.messageId);
        state.failedAt = this.#now();
      }
    });
    state.tail = task
      .catch(() => {})
      .finally(() => {
        state.pending--;
      });
    void state.tail.then(() => {
      if (this.#keys.get(key) === state && state.tail === tail && state.nacked.size === 0)
        this.#keys.delete(key);
    });
    const tail = state.tail;
    return task;
  }

  /** Forgets least recently used idle keys until a new key fits the bound. */
  #evictIdle(): void {
    if (this.#keys.size < this.#maxKeys) return;
    for (const [key, state] of this.#keys) {
      if (this.#keys.size < this.#maxKeys) return;
      if (state.pending !== 0) continue;
      this.#keys.delete(key);
      if (state.nacked.size === 0) continue;
      try {
        if (this.#now() - state.failedAt < REDELIVERY_WINDOW_MS) this.#onRecentEviction();
      } catch {
        /* A broken clock or sink only loses the warning; it cannot change dispatch. */
      }
    }
  }

  /**
   * Drops buffered callbacks and nack holds without settling closed-stream messages.
   * Retains completion barriers so running handlers finish before replacement work.
   * @returns Nothing
   * @throws Never
   * @since 0.14.0
   */
  clear(): void {
    this.#generation++;
    for (const state of this.#keys.values()) state.nacked.clear();
  }
}
