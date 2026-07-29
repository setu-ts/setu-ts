/**
 * Resilience contracts, fulfilled by the ResiliencePlugin under
 * `CAPABILITIES.RESILIENCE`.
 *
 * @module
 */

/**
 * Circuit breaker states.
 *
 * - `closed` — calls flow normally; failures are counted
 * - `open` — calls fail fast without invoking the target
 * - `half-open` — a trial call probes whether the target recovered
 *
 * @since 0.1.0
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * A call protected by the resilience patterns.
 *
 * The `signal` is aborted when the attempt is cancelled — on a `timeout`
 * deadline, or when the caller aborts the signal it passed to the
 * {@linkcode HardenedCall}. A call that forwards the signal to the I/O it
 * performs (`fetch(url, { signal })`, an abortable driver) is genuinely
 * cancelled; a call that ignores it still runs to completion, and only the
 * caller's `await` rejects.
 *
 * Declaring the parameter does not oblige an implementation to accept it: a
 * zero-argument `() => Promise<T>` remains assignable here, so callers written
 * against the pre-cancellation signature continue to type-check unchanged.
 *
 * @typeParam T - The call's result type
 * @param signal - Aborted when this attempt is cancelled
 * @since 0.2.0
 */
export type ResilientCall<T> = (signal: AbortSignal) => Promise<T>;

/**
 * The hardened callable returned by {@linkcode IResilienceService.wrap}.
 *
 * The signal is optional: `guarded()` behaves exactly as before, while
 * `guarded(signal)` additionally lets the caller cancel from outside — the
 * outer abort propagates into the protected call, stops the retry loop, and
 * rejects a waiter still queued behind the bulkhead.
 *
 * @typeParam T - The call's result type
 * @param signal - Optional caller-owned signal that cancels the whole call
 * @since 0.2.0
 */
export type HardenedCall<T> = (signal?: AbortSignal) => Promise<T>;

/**
 * Circuit breaker protecting calls to an unreliable dependency.
 *
 * @example
 * ```typescript
 * const result = await breaker.execute(() => externalApi.fetchRates());
 * ```
 * @since 0.1.0
 */
export interface ICircuitBreaker {
  /** The current circuit state. */
  readonly state: CircuitState;
  /**
   * Executes a call through the breaker.
   *
   * @typeParam T - The call's result type
   * @param fn - The protected call, handed the cancellation signal for this
   * attempt
   * @returns The call result
   * @throws {Error} Fails fast when the circuit is open; otherwise
   * propagates the call's own error
   */
  execute<T>(fn: ResilientCall<T>): Promise<T>;
}

/**
 * Backoff strategy applied to a {@linkcode RetryPolicy}'s base delay.
 *
 * - `fixed` — the delay is constant across attempts
 * - `exponential` — the delay doubles each attempt (`delay · 2^(attempt-1)`)
 *
 * Named distinctly from the scheduler's `SchedulerBackoff` to avoid a barrel
 * collision.
 *
 * @since 0.1.0
 */
export type BackoffStrategy = 'fixed' | 'exponential';

/**
 * Circuit breaker policy consumed by the ResiliencePlugin's breaker pattern.
 *
 * @since 0.1.0
 */
export interface CircuitBreakerPolicy {
  /** Failures within the `timeout` window that trip the breaker open. */
  readonly threshold: number;
  /**
   * Rolling failure window in milliseconds; failures older than this (measured
   * by the monotonic clock) are dropped before the threshold check.
   */
  readonly timeout: number;
  /** Cooldown in milliseconds before an open breaker moves to half-open. */
  readonly resetTimeout: number;
}

/**
 * Retry policy consumed by the ResiliencePlugin's retry pattern.
 *
 * Named distinctly from the scheduler's `RetryOptions` to avoid a barrel
 * collision.
 *
 * @since 0.1.0
 */
export interface RetryPolicy {
  /** Maximum total attempts (`1` = a single attempt, no retry). */
  readonly limit: number;
  /** Base backoff delay in milliseconds. */
  readonly delay: number;
  /** Backoff strategy applied to `delay`. */
  readonly backoff: BackoffStrategy;
}

/**
 * Bulkhead policy consumed by the ResiliencePlugin's bulkhead pattern.
 *
 * @since 0.1.0
 */
export interface BulkheadPolicy {
  /** Maximum concurrent in-flight executions. */
  readonly maxConcurrent: number;
  /** Maximum queued executions once concurrency is saturated. Defaults to 0. */
  readonly maxQueue?: number;
}

/**
 * Options selecting which resilience patterns wrap a protected call.
 *
 * For `circuitBreaker`, `retry`, and `bulkhead`, `true` uses the plugin's
 * matching `default*` policy, a policy object overrides per-wrap, and an
 * absent/`false` value disables that layer. `timeout` is a millisecond deadline
 * bounding each attempt.
 *
 * @since 0.1.0
 */
export interface WrapOptions {
  /** Circuit breaker layer: `true` uses the default, a policy overrides. */
  readonly circuitBreaker?: boolean | CircuitBreakerPolicy;
  /** Retry layer: `true` uses the default, a policy overrides. */
  readonly retry?: boolean | RetryPolicy;
  /** Per-attempt timeout in milliseconds; absent disables the timeout layer. */
  readonly timeout?: number;
  /** Bulkhead layer: `true` uses the default, a policy overrides. */
  readonly bulkhead?: boolean | BulkheadPolicy;
}

/**
 * Resilience service registered under `CAPABILITIES.RESILIENCE`.
 *
 * @example
 * ```typescript
 * const resilience = ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);
 * const guarded = resilience.wrap((signal) => fetch(url, { signal }), {
 *   circuitBreaker: true,
 *   retry: { limit: 3, delay: 100, backoff: 'exponential' },
 *   timeout: 2000,
 * });
 * const rates = await guarded();
 *
 * // A call that ignores the signal is still accepted, unchanged.
 * const legacy = resilience.wrap(() => externalApi.fetchRates(), { timeout: 2000 });
 *
 * // The caller may also cancel from outside.
 * const controller = new AbortController();
 * const pending = guarded(controller.signal);
 * controller.abort();
 * ```
 * @since 0.1.0
 */
export interface IResilienceService {
  /**
   * Wraps `fn` with the selected patterns and returns a hardened callable that
   * reuses one shared pattern chain across invocations, so circuit-breaker and
   * bulkhead state persist across calls.
   *
   * Each attempt is handed an {@linkcode AbortSignal}. The `timeout` layer
   * aborts it with a `TimeoutError` when the deadline elapses, so a call that
   * forwards the signal to its I/O is genuinely cancelled rather than left
   * running in the background. An outer signal passed to the returned callable
   * is linked into every layer: it stops the retry loop between attempts and
   * rejects a call still queued behind the bulkhead.
   *
   * @typeParam T - The protected call's result type
   * @param fn - The protected call, handed the cancellation signal for the
   * current attempt
   * @param options - Which patterns to apply and their policies
   * @returns A hardened callable accepting an optional caller-owned signal
   */
  wrap<T>(fn: ResilientCall<T>, options?: WrapOptions): HardenedCall<T>;
}
