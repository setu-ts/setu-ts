/**
 * Retry pattern — pure backoff math plus a retry loop whose delays are driven
 * by the runtime's timers (never a busy wait, never `Date.now()`).
 *
 * @module
 */
import type { ResilientCall, RetryPolicy } from '@setu-ts/common';
import type { ITimers } from '../interfaces/index.ts';
import { abortReasonOf, throwIfAborted } from './abort.ts';

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

/**
 * Resolves after `ms`, or as soon as `signal` aborts — whichever comes first.
 *
 * The handle is cleared on both paths. The previous implementation cleared it
 * on neither, so every backoff between attempts leaked a pending timer, and a
 * cancelled operation still slept out its full delay before noticing.
 *
 * @param ms - Delay in milliseconds
 * @param timers - Runtime timers driving the wake-up
 * @param signal - Optional signal that ends the sleep early
 * @returns A promise resolving on wake-up or on abort
 */
function delayFor(ms: number, timers: ITimers, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      timers.clearTimeout(handle);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const handle = timers.setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Runs `fn`, retrying on rejection up to `policy.limit` total attempts with the
 * configured backoff between attempts.
 *
 * Cancellation ends the sequence rather than merely failing one attempt: the
 * signal is checked before every attempt, the backoff sleep wakes early on
 * abort, and an aborted signal rejects with its own reason instead of the last
 * attempt's error. A cancelled operation that kept sleeping and retrying would
 * not have been cancelled in any meaningful sense.
 *
 * @typeParam T - The protected call's result type
 * @param fn - The protected call, handed the attempt's signal
 * @param policy - The retry policy (`limit` = maximum total attempts)
 * @param timers - Runtime timers driving the backoff delays
 * @param signal - Optional caller-owned signal cancelling the sequence
 * @returns The first successful result
 * @throws The abort reason when cancelled, otherwise the last attempt's error
 */
export async function runWithRetry<T>(
  fn: ResilientCall<T>,
  policy: RetryPolicy,
  timers: ITimers,
  signal?: AbortSignal,
): Promise<T> {
  // Hoisted: an uncancellable stand-in built once per sequence rather than per
  // attempt, for the case where no caller signal was supplied.
  const effective = signal ?? new AbortController().signal;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.limit; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn(effective);
    } catch (error) {
      lastError = error;
      if (signal?.aborted === true) {
        throw abortReasonOf(signal);
      }
      if (attempt < policy.limit) {
        await delayFor(computeBackoffMs(attempt, policy), timers, signal);
      }
    }
  }
  throw lastError;
}
