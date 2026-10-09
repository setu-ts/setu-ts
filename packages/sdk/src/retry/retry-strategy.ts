/**
 * Internal retry strategy for the HTTP client.
 *
 * Implements retry classification, `Retry-After` delta-seconds parsing, and
 * the fixed/exponential backoff loop using the shared `RetryPolicy` from common.
 *
 * Classification operates on the real error type emitted by `HttpClient` —
 * `HttpClientError` for non-2xx responses (carrying `status` and `headers`)
 * and transport rejections otherwise — rather than a raw `Response`.
 *
 * @internal
 */

import type { ClientRetryPolicy, IClientTiming } from '../http/contracts.ts';

import { HttpClientError } from '../errors.ts';

// JavaScript runtimes clamp larger setTimeout delays, commonly to 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Validate a retry policy and return a frozen shallow copy of it.
 *
 * The one owner of the retry bounds, run by the `HttpClient` constructor so a
 * client built directly enforces what `createClient()` documents. Copying is
 * load-bearing: the client keeps the copy rather than the caller's object, so
 * raising `maxRetryAfterMs`, `delay` or `limit` after construction cannot move
 * the validated cap or reach `timing.sleep` with an unchecked delay.
 *
 * @param policy - The caller-supplied retry policy
 * @returns A frozen copy of the validated policy
 * @throws {Error} When any bound is violated
 * @internal
 */
export function validateRetryPolicy(policy: ClientRetryPolicy): Readonly<ClientRetryPolicy> {
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1) {
    throw new Error('retry.limit must be a positive safe integer');
  }
  if (!Number.isFinite(policy.delay) || policy.delay < 0) {
    throw new Error('retry.delay must be a finite non-negative number');
  }
  if (policy.delay > MAX_TIMER_DELAY_MS) {
    throw new Error('retry.delay exceeds the maximum timer delay');
  }
  const largestPolicyDelay = policy.delay * 2 ** (policy.limit - 1);
  if (policy.backoff === 'exponential' && !Number.isFinite(largestPolicyDelay)) {
    throw new Error('retry exponential backoff must remain finite');
  }
  if (policy.backoff === 'exponential' && largestPolicyDelay > MAX_TIMER_DELAY_MS) {
    throw new Error('retry exponential backoff exceeds the maximum timer delay');
  }
  if (
    policy.maxRetryAfterMs !== undefined &&
    (!Number.isFinite(policy.maxRetryAfterMs) || policy.maxRetryAfterMs < 0)
  ) {
    throw new Error('retry.maxRetryAfterMs must be a finite non-negative number');
  }
  if (policy.maxRetryAfterMs !== undefined && policy.maxRetryAfterMs > MAX_TIMER_DELAY_MS) {
    throw new Error('retry.maxRetryAfterMs exceeds the maximum timer delay');
  }
  return Object.freeze({ ...policy });
}

// Idempotent/safe methods that may be automatically retried.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * Errors raised AFTER a response arrived (a JSON parse failure, a response
 * interceptor). The server executed, so a keyed request outside the safe set
 * must not repeat it (M109b §3.9).
 */
const EXECUTED = new WeakSet<object>();

/**
 * Tags an error as raised after the server executed. Mutates nothing the
 * caller can see: the tag lives in this module's `WeakSet`.
 *
 * @internal
 * @param error - Whatever was thrown after a response arrived
 * @returns The same error, tagged
 */
export function markExecuted<T>(error: T): T {
  if (typeof error === 'object' && error !== null) EXECUTED.add(error);
  return error;
}

/** True when an error was raised after a response arrived. */
function isExecuted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && EXECUTED.has(error);
}

/** Retryable status codes: 408, 425, 429, and 500–599 — plus `409` when keyed. */
function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

/**
 * Parse `Retry-After` header value as delta-seconds (a non-negative integer).
 *
 * Returns the delta as milliseconds, or `null` for HTTP-date form, empty,
 * fractional, or otherwise malformed values. Per plan §3.4 only the
 * delta-seconds form is honored; the HTTP-date form is intentionally ignored.
 */
function parseRetryAfterDelta(headers: Headers): number | null {
  const value = headers.get('Retry-After');
  if (value === null) return null;
  const deltaSeconds = value.trim();
  // RFC delta-seconds is one or more decimal digits. `Number()` alone also
  // accepts JavaScript spellings such as `1e3`, `+3`, and `0x10`.
  if (!/^[0-9]+$/.test(deltaSeconds)) return null;
  return Number(deltaSeconds) * 1000;
}

/**
 * Execute `fn` with retry logic governed by `policy`.
 *
 * Retries transport rejections and `HttpClientError` responses with retryable
 * status codes, and only for safe/idempotent methods. When a retryable
 * response carries a `Retry-After` delta-seconds header, that delay replaces
 * the computed backoff for that attempt.
 *
 * @internal
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  policy: ClientRetryPolicy,
  method: string,
  timing: IClientTiming,
  signal?: AbortSignal,
  keyed = false,
): Promise<T> {
  let lastError: unknown;
  const safeMethod = SAFE_METHODS.has(method.toUpperCase());
  // A keyed request may be repeated on ANY method (M109b §3.9).
  const canRetry = keyed || safeMethod;
  const maxRetryAfterMs = policy.maxRetryAfterMs ??
    (policy.backoff === 'exponential' ? policy.delay * 2 ** (policy.limit - 1) : policy.delay);

  for (let attempt = 1; attempt <= policy.limit; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error;

      // Never retry aborted requests.
      if (signal?.aborted) throw error;

      // A keyed, non-safe method whose response already arrived is never
      // repeated: the server executed (M109b §3.9).
      if (keyed && !safeMethod && isExecuted(error)) throw error;

      let isRetryable = false;
      let retryAfter: number | null = null;

      if (error instanceof HttpClientError) {
        // HTTP response error — classify on the real error type. A keyed
        // request also retries 109a's and tier C's `409` (M109b §3.9).
        isRetryable = isRetryableStatus(error.status) || (keyed && error.status === 409);
        retryAfter = parseRetryAfterDelta(error.headers);
      } else {
        // Transport rejection (non-HttpClientError throw) — retryable on
        // safe methods. No Retry-After header to consider.
        isRetryable = true;
      }
      // Transport rejections (non-HttpClientError throws) are retryable on
      // safe methods; they carry no status or Retry-After.

      if (!isRetryable) throw error;
      if (!canRetry) throw error;
      if (attempt === policy.limit) throw error;
      if (retryAfter !== null && retryAfter > maxRetryAfterMs) throw error;

      // Compute backoff delay: `delay * 2^(attempt - 1)`, matching
      // resilience-plugin's server-side schedule.
      //
      // `2 **` rather than `1 << (attempt - 1)`: the shift operand is coerced to
      // int32, so attempt 32 shifts by 31 and yields a NEGATIVE multiplier (and
      // attempt 33 wraps to 1). A large `limit` would then produce negative or
      // collapsing delays instead of a growing backoff.
      let delay = policy.delay;
      if (policy.backoff === 'exponential') {
        delay = policy.delay * 2 ** (attempt - 1);
      }

      // A Retry-After delta-seconds value replaces the computed backoff.
      if (retryAfter !== null) {
        delay = retryAfter;
      }

      await timing.sleep(delay, signal);
    }
  }

  // Should not reach here, but exhaustively throw last error.
  throw lastError;
}
