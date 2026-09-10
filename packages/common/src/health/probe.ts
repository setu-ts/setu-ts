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
 * The per-probe timeout runs on an injected timer surface for the same reason
 * — `IRuntimeServices.setTimeout`/`clearTimeout`, so a custom runtime's timers
 * are honoured rather than bypassed (the class M51b fixed when transports
 * reached for global timers). Both default to the ambient Web-standard
 * functions for a caller that has no runtime to hand.
 *
 * @since 0.1.0
 */
import type { IRuntimeServices, TimerHandle } from '../runtime.ts';

/**
 * Options for {@linkcode createCachedProbe}.
 *
 * @since 0.1.0
 */
export interface CachedProbeOptions<T = boolean> {
  /**
   * The reachability probe. Resolving `true` means the backend is reachable;
   * resolving `false` or rejecting means it is not.
   *
   * A probe may resolve a wider outcome than `boolean` — see
   * {@linkcode CachedProbeOptions.fallback}. `T` defaults to `boolean`, so
   * every existing caller is unchanged.
   */
  readonly probe: () => Promise<T>;
  /**
   * Outcome recorded when the probe times out or rejects.
   *
   * Defaults to `false` — the policy this helper was built for, where a
   * backend that will not answer counts as unreachable. That is the right
   * answer when the probe reads the thing whose health is being reported.
   *
   * It is the WRONG answer when the probe reads a proxy for that thing and
   * the proxy can fail independently: `messaging-plugin`'s Service Bus probe
   * reads the namespace's MANAGEMENT plane to report on its DATA plane, so a
   * management endpoint that is firewalled, absent (the emulator ships no
   * TLS listener for it) or merely slow used to report a live, publishing
   * broker as `down` and drain the replica. Such a probe passes
   * `fallback: undefined` and widens `T`, so "I could not determine this"
   * stays distinguishable from "it is down".
   *
   * @default false
   */
  readonly fallback?: T;
  /**
   * How long to cache the last outcome, in milliseconds.
   *
   * @default 5000
   */
  readonly ttlMs?: number;
  /**
   * Per-probe timeout, in milliseconds. A probe that does not settle within
   * this window resolves {@linkcode CachedProbeOptions.fallback}, which is
   * `false` — unreachable — unless the caller widened it.
   *
   * @default 2000
   */
  readonly timeoutMs?: number;
  /**
   * Monotonic clock in milliseconds (e.g. `IRuntimeServices.hrtime()`).
   * Injected so the TTL is an interval, not a wall-clock reading.
   */
  readonly hrtime: () => number;
  /**
   * Timer used to bound each probe (e.g. `IRuntimeServices.setTimeout`).
   *
   * @default the ambient `setTimeout`
   */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /**
   * Cancels a timer created by {@linkcode CachedProbeOptions.setTimer}
   * (e.g. `IRuntimeServices.clearTimeout`).
   *
   * @default the ambient `clearTimeout`
   */
  readonly clearTimer?: (handle: TimerHandle) => void;
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
export function createCachedProbe(
  options: CachedProbeOptions<boolean>,
): () => Promise<boolean>;
/**
 * Widened-outcome form: `fallback` is REQUIRED.
 *
 * The default fallback is `false`, which this function cannot produce for an
 * outcome type that does not include it. Requiring the caller to name theirs
 * is what keeps the returned `Promise<T>` honest — without this overload a
 * `createCachedProbe<'up' | 'down'>` call that omitted `fallback` would hand
 * back `false` on a timeout under a type promising it could not.
 *
 * `fallback: undefined` is a valid value here, not an omission: it is the one
 * the tri-state Service Bus probe passes to mean "could not determine".
 */
export function createCachedProbe<T>(
  options: CachedProbeOptions<T> & { readonly fallback: T },
): () => Promise<T>;
export function createCachedProbe<T = boolean>(
  options: CachedProbeOptions<T>,
): () => Promise<T> {
  const ttlMs = options.ttlMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 2000;
  // `false` is the documented default and the only outcome this helper can
  // name without knowing `T`. The cast is confined to this line and the
  // overloads above are what make it sound: a caller may only omit `fallback`
  // through the boolean overload, for which `false` is a valid `T`. Any wider
  // outcome type has to name its own fallback, so this branch is unreachable
  // for it.
  //
  // Membership, NOT `??`. `undefined` is a legitimate fallback — it is the one
  // the tri-state Service Bus probe passes to mean "could not determine" — and
  // `options.fallback ?? false` collapses it back to `false`, reinstating the
  // exact defect that widening exists to fix. Caught by that probe's own test.
  const fallback = ('fallback' in options ? options.fallback : false) as T;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });

  let cached: { readonly value: T; readonly at: number } | null = null;
  let inFlight: Promise<T> | null = null;

  const runProbe = (): Promise<T> => {
    let timer: TimerHandle;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimer(() => resolve(fallback), timeoutMs);
    });
    // A probe that rejects, or throws synchronously, resolves the fallback —
    // not an error. The attempt therefore never rejects.
    const attempt = Promise.resolve()
      .then(() => options.probe())
      .then((reachable) => reachable, () => fallback);
    return Promise.race([attempt, timeout]).finally(() => {
      clearTimer(timer);
    });
  };

  return (): Promise<T> => {
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

/**
 * The clock-and-timer surface {@linkcode createCachedProbe} runs on, bound to
 * a runtime.
 *
 * @since 0.4.0
 */
export interface ProbeTiming {
  /**
   * Monotonic clock in milliseconds — the runtime's `hrtime`. Measures the
   * cache TTL as an interval, never a wall-clock reading.
   */
  readonly hrtime: () => number;
  /**
   * Timer used to bound each probe — the runtime's `setTimeout`.
   */
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  /**
   * Cancels a timer created by {@linkcode ProbeTiming.setTimer} — the
   * runtime's `clearTimeout`.
   */
  readonly clearTimer: (handle: TimerHandle) => void;
}

/**
 * Resolves a probe's monotonic clock and timer surface from an injected
 * {@linkcode IRuntimeServices}.
 *
 * Every member is bound to the runtime the caller passes. There is NO ambient
 * `performance.now()`/`Date.now()` fallback: all time access outside
 * `packages/runtime` must go through `IRuntimeServices` (AI_GUIDELINES §4.1 /
 * §4.2), so a caller with no runtime to inject has no clock the probe may
 * lawfully read. Pass the result straight into {@linkcode createCachedProbe}:
 * `hrtime` measures the TTL, and the timer pair bounds each probe.
 *
 * @param runtime - The runtime services (e.g. `ctx.runtime` on a plugin
 *   context, non-optional by contract)
 * @returns The timing surface, bound to `runtime`
 *
 * @example
 * ```typescript
 * const probe = createCachedProbe({
 *   probe: () => client.ping().then(() => true, () => false),
 *   ...resolveProbeTiming(ctx.runtime),
 * });
 * ```
 * @since 0.4.0
 */
export function resolveProbeTiming(runtime: IRuntimeServices): ProbeTiming {
  return {
    hrtime: runtime.hrtime.bind(runtime),
    setTimer: runtime.setTimeout.bind(runtime),
    clearTimer: runtime.clearTimeout.bind(runtime),
  };
}
