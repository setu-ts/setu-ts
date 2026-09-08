/**
 * Per-key in-flight work coalescing for cache reads.
 *
 * The coalescer is deliberately process-local. A distributed coalescer would
 * need a lease-backed lock and a failure policy for a process that dies while
 * holding it; that is a different capability from this cache service seam.
 *
 * @module
 */

/**
 * The value returned from a coalesced operation.
 *
 * `joined` distinguishes the caller that started the work from callers that
 * observed it already in flight. This lets response middleware label only the
 * latter as coalesced while a service caller can simply read `value`.
 *
 * @typeParam T - The resolved work value
 * @internal
 */
export type CoalescedResult<T> = {
  /** Whether this caller joined work another caller had already started. */
  readonly joined: boolean;
  /** Discriminates a successful leader from a rejected one. */
  readonly ok: true;
  /** The value produced by the shared work. */
  readonly value: T;
} | {
  /** Whether this caller joined work another caller had already started. */
  readonly joined: boolean;
  /** Discriminates a rejected leader from a successful one. */
  readonly ok: false;
  /** The error produced by the leader. */
  readonly error: unknown;
};

/**
 * A keyed, process-local in-flight work registry.
 *
 * @typeParam T - The value produced for each key in this registry
 * @internal
 */
export interface Coalescer {
  /**
   * Runs work for `key`, or joins the work already running for that key.
   *
   * A rejection clears the key too, so a transient origin failure never poisons
   * future reads. Settled entries are removed before the next caller can join
   * stale work.
   *
   * @param owner - Resolved cache-store identity that scopes this key
   * @param key - Cache key scoped to `owner`
   * @param work - The asynchronous work to run for the leader
   * @returns The value and whether this caller joined existing work
   */
  run<T>(
    owner: object,
    key: string,
    work: () => Promise<T>,
  ): Promise<CoalescedResult<T>>;
}

/**
 * Creates an empty keyed in-flight work registry.
 *
 * @typeParam T - The value produced for each key in the registry
 * @returns A coalescer with no work in flight
 * @internal
 */
export function createCoalescer(): Coalescer {
  const inFlightByStore = new WeakMap<object, Map<string, Promise<CoalescedResult<unknown>>>>();

  return {
    run<T>(
      owner: object,
      key: string,
      work: () => Promise<T>,
    ): Promise<CoalescedResult<T>> {
      let inFlight = inFlightByStore.get(owner);
      if (inFlight === undefined) {
        inFlight = new Map();
        inFlightByStore.set(owner, inFlight);
      }

      const existing = inFlight.get(key);
      if (existing !== undefined) {
        // A cache key has one value type by contract, just as ICacheStore.get
        // does. The registry erases that type only to keep heterogeneous keys
        // in one per-store map; it is restored at the typed call boundary.
        return existing.then((result) => ({ ...result, joined: true } as CoalescedResult<T>));
      }

      // A failed leader is data rather than a rejected shared promise. The
      // caller needs to know whether it led (rethrow) or joined (run its own
      // origin), which a bare rejection cannot retain.
      const running: Promise<CoalescedResult<T>> = Promise.resolve().then(work).then(
        (value) => ({ joined: false, ok: true, value }),
        (error: unknown) => ({ joined: false, ok: false, error }),
      );
      inFlight.set(key, running);

      const clear = (): void => {
        if (inFlight.get(key) === running) {
          inFlight.delete(key);
        }
      };
      void running.then(clear, clear);

      return running;
    },
  };
}

/**
 * Shared cache-load coalescer used by CacheService and cacheMiddleware.
 *
 * Its `WeakMap` scopes keys by the resolved store identity, so equal key text
 * in two independently configured caches can never share a producer.
 *
 * @internal
 */
export const cacheCoalescer = createCoalescer();
