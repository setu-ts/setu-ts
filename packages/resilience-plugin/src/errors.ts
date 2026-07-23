/**
 * Resilience error classes exported for consumer `instanceof` handling.
 *
 * @module
 */

/**
 * Thrown when a protected call exceeds its per-attempt timeout deadline.
 *
 * Because the protected-call signature is `() => Promise<T>` with no
 * `AbortSignal`, the underlying operation is not cancelled — it runs to
 * completion in the background; only the caller's await rejects.
 *
 * @since 0.1.0
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when a bulkhead is at maximum concurrency and its queue is full, so
 * the call is shed (fail-fast load shedding) rather than executed or queued.
 *
 * @since 0.1.0
 */
export class BulkheadFullError extends Error {
  constructor(message = 'Bulkhead is full') {
    super(message);
    this.name = 'BulkheadFullError';
  }
}

/**
 * Thrown when a circuit breaker is open and fails fast without invoking the
 * protected call.
 *
 * @since 0.1.0
 */
export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
