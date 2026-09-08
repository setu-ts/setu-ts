/**
 * Resilience error classes exported for consumer `instanceof` handling.
 *
 * Since M90f (X32-7) each carries an `HttpStatusHint` from `@setu-ts/common`,
 * so an application running `errorHandler` answers the condition in its
 * configured format instead of a masked `500` that reads as a bug in every
 * dashboard. The statuses are part of the contract, not an implementation
 * detail:
 *
 * - {@linkcode BulkheadFullError} → `503` — shedding is the bulkhead's
 *   purpose; the service is temporarily refusing work it could otherwise do.
 * - {@linkcode CircuitOpenError} → `503` — same load-shedding semantics; the
 *   breaker is failing fast on behalf of a dependency known to be failing.
 * - {@linkcode TimeoutError} → `504` — the framework acted as an
 *   intermediary to a protected call that did not answer in time, which is
 *   what `504` means.
 *
 * **No `Retry-After` is carried on any of them**, and the hint channel
 * (`ErrorResponseInit`) has no header to carry one on: a bulkhead's queue
 * drains on the order of one protected call's latency, which the framework
 * does not measure, and inventing a deadline would state one it cannot keep.
 * `503` is itself the retryable signal (RFC 9110). The rate limiter's
 * `Retry-After` is the deliberate asymmetry — a fixed window genuinely knows
 * when it resets — recorded in `PUBLIC_API.md`.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * Thrown when a protected call exceeds its per-attempt timeout deadline.
 *
 * Because the protected-call signature is `() => Promise<T>` with no
 * `AbortSignal`, the underlying operation is not cancelled — it runs to
 * completion in the background; only the caller's await rejects. (M47 made
 * the timeout CANCEL the per-attempt work when the caller supplies a signal;
 * the status below is what the caller is told either way.)
 *
 * @since 0.1.0
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
    withHttpStatusHint(this, {
      status: 504,
      title: 'Gateway Timeout',
      detail: 'The protected operation did not complete within its timeout deadline.',
    });
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
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'The operation was shed because the bulkhead is at capacity.',
    });
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
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'The circuit breaker is open and the operation was not attempted.',
    });
  }
}
