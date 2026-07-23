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
   * @param fn - The protected call
   * @returns The call result
   * @throws {Error} Fails fast when the circuit is open; otherwise
   * propagates the call's own error
   */
  execute<T>(fn: () => Promise<T>): Promise<T>;
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
 * const guarded = resilience.wrap(() => externalApi.fetchRates(), {
 *   circuitBreaker: true,
 *   retry: { limit: 3, delay: 100, backoff: 'exponential' },
 *   timeout: 2000,
 * });
 * const rates = await guarded();
 * ```
 * @since 0.1.0
 */
export interface IResilienceService {
  /**
   * Wraps `fn` with the selected patterns and returns a hardened callable that
   * reuses one shared pattern chain across invocations, so circuit-breaker and
   * bulkhead state persist across calls.
   *
   * @typeParam T - The protected call's result type
   * @param fn - The protected call
   * @param options - Which patterns to apply and their policies
   * @returns A hardened callable with the same signature as `fn`
   */
  wrap<T>(fn: () => Promise<T>, options?: WrapOptions): () => Promise<T>;
}
