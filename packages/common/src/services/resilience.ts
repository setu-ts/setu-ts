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
