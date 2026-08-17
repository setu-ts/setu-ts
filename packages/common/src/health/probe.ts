/**
 * Cached, time-bounded reachability probe.
 *
 * @module
 *
 * Every backend-owning port in the framework answers one factual health
 * question — _is the backend reachable right now_ — through an optional
 * `isHealthy?(): Promise<boolean>` member. That probe is invoked from a
 * health endpoint that is itself polled by kubelet, Prometheus and load
 * balancers; an uncached probe would make the health endpoint a load
 * generator against the very backend it is checking. This module provides the
 * one pure helper every such `isHealthy` is built through: it caches the last
 * outcome for a TTL, coalesces concurrent callers into a single in-flight
 * probe, bounds each probe with a timeout (a timeout counting as
 * unreachable), and never lets a rejecting probe escape — a throw is `false`.
 *
 * The TTL is an interval, so it is measured on a **monotonic** clock that the
 * caller injects (`IRuntimeServices.hrtime()`); a wall clock would be wrong
 * here, and `Date.now()` is banned outside `packages/runtime` regardless.
 * The per-probe timeout uses the ambient `setTimeout`, a Web-standard API
 * present on every runtime this package runs on.
 *
 * @since 0.1.0
 */

/**
 * Options for {@linkcode createCachedProbe}.
 *
 * @since 0.1.0
 */
export interface CachedProbeOptions {
  /**
   * The reachability probe. Resolving `true` means the backend is reachable;
   * resolving `false` or rejecting means it is not.
   */
  readonly probe: () => Promise<boolean>;
  /**
   * How long to cache the last outcome, in milliseconds.
   *
   * @default 5000
   */
  readonly ttlMs?: number;
  /**
   * Per-probe timeout, in milliseconds. A probe that does not settle within
   * this window counts as unreachable (`false`).
   *
   * @default 2000
   */
  readonly timeoutMs?: number;
  /**
   * Monotonic clock in milliseconds (e.g. `IRuntimeServices.hrtime()`).
   * Injected so the TTL is an interval, not a wall-clock reading.
   */
  readonly hrtime: () => number;
}

/**
 * Builds a cached, coalesced, time-bounded reachability probe.
 *
 * The returned function answers the same factual question as
 * `options.probe` — `true` when the backend is reachable — but only issues a
 * fresh probe when the cached outcome has aged past `ttlMs` (measured on the
 * injected monotonic `hrtime`). Concurrent callers during a single in-flight
 * probe share one probe call. Each probe is bounded by `timeoutMs`; a probe
 * that exceeds the window, rejects, or throws synchronously resolves `false`
 * — the attempt never rejects.
 *
 * @param options - Probe, cache TTL, timeout and monotonic clock
 * @returns An async function resolving the backend's reachability
 *
 * @example
 * ```typescript
 * const isHealthy = createCachedProbe({
 *   probe: () => client.ping().then(() => true, () => false),
 *   hrtime: () => runtime.hrtime(),
 * });
 * ```
 * @since 0.1.0
 */
export function createCachedProbe(options: CachedProbeOptions): () => Promise<boolean> {
  const ttlMs = options.ttlMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 2000;

  let cached: { readonly value: boolean; readonly at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  const runProbe = (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    // A probe that rejects, or throws synchronously, is unreachable — not an
    // error. The attempt therefore never rejects.
    const attempt = Promise.resolve()
      .then(() => options.probe())
      .then((reachable) => reachable, () => false);
    return Promise.race([attempt, timeout]).finally(() => {
      clearTimeout(timer);
    });
  };

  return (): Promise<boolean> => {
    const now = options.hrtime();
    if (cached !== null && now - cached.at < ttlMs) {
      return Promise.resolve(cached.value);
    }
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = runProbe().then((value) => {
      cached = { value, at: options.hrtime() };
      inFlight = null;
      return value;
    });
    return inFlight;
  };
}
