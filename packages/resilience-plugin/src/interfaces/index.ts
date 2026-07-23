/**
 * Internal interfaces and types for the resilience plugin.
 *
 * This barrel is intentionally NOT exported from `src/index.ts` (except
 * `ResiliencePluginOptions`, which is re-exported there as public surface) —
 * the remaining seams are used only by resilience-plugin implementation files.
 *
 * @module
 */
import type { BulkheadPolicy, CircuitBreakerPolicy, RetryPolicy } from '@hono-enterprise/common';

/**
 * The timer subset of `IRuntimeServices` used by the retry and timeout
 * patterns. Injecting only this narrow seam keeps the patterns unit-testable
 * with a deterministic fake clock.
 */
export interface ITimers {
  /**
   * Schedules a one-shot callback.
   *
   * @param fn - Callback to invoke
   * @param ms - Delay in milliseconds
   * @returns A handle for `clearTimeout`
   */
  setTimeout(fn: () => void, ms: number): unknown;
  /**
   * Cancels a pending `setTimeout`.
   *
   * @param handle - The handle returned by `setTimeout`
   */
  clearTimeout(handle: unknown): void;
}

/**
 * Options passed to `ResiliencePlugin()`. Each `default*` policy is consumed
 * when a `wrap` sets the matching field to `true`; a `wrap` requesting `true`
 * with no matching default configured throws.
 *
 * @since 0.1.0
 */
export interface ResiliencePluginOptions {
  /** Default circuit-breaker policy used when a `wrap` sets `circuitBreaker: true`. */
  readonly defaultCircuitBreaker?: CircuitBreakerPolicy;
  /** Default retry policy used when a `wrap` sets `retry: true`. */
  readonly defaultRetry?: RetryPolicy;
  /** Default bulkhead policy used when a `wrap` sets `bulkhead: true`. */
  readonly defaultBulkhead?: BulkheadPolicy;
}
