/**
 * Retry pattern — pure backoff math plus a retry loop whose delays are driven
 * by the runtime's timers (never a busy wait, never `Date.now()`).
 *
 * @module
 */
import type { RetryPolicy } from '@hono-enterprise/common';
import type { ITimers } from '../interfaces/index.ts';

/**
 * Computes the backoff delay before a given attempt.
 *
 * @param attempt - 1-based attempt number the delay precedes (the delay before
 * the 2nd attempt is `computeBackoffMs(1, policy)`)
 * @param policy - The retry policy
 * @returns Delay in milliseconds: `'fixed'` ⇒ `delay`; `'exponential'` ⇒
 * `delay · 2^(attempt-1)`
 */
export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  if (policy.backoff === 'exponential') {
    return policy.delay * 2 ** (attempt - 1);
  }
  return policy.delay;
}

/** Resolves after `ms`, scheduling the wake-up through the runtime timers. */
function delayFor(ms: number, timers: ITimers): Promise<void> {
  return new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/**
 * Runs `fn`, retrying on rejection up to `policy.limit` total attempts with the
 * configured backoff between attempts.
 *
 * @typeParam T - The protected call's result type
 * @param fn - The protected call
 * @param policy - The retry policy (`limit` = maximum total attempts)
 * @param timers - Runtime timers driving the backoff delays
 * @returns The first successful result
 * @throws The last error when all `limit` attempts fail
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  timers: ITimers,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.limit; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < policy.limit) {
        await delayFor(computeBackoffMs(attempt, policy), timers);
      }
    }
  }
  throw lastError;
}
