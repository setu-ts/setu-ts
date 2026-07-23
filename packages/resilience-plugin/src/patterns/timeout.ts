/**
 * Timeout pattern — races a protected call against a runtime timer.
 *
 * @module
 */
import type { ITimers } from '../interfaces/index.ts';
import { TimeoutError } from '../errors.ts';

/**
 * Races `fn()` against a `ms`-millisecond deadline. Whichever settles first
 * wins; the pending timer is always cleared in a `finally` so no handle leaks.
 *
 * Because the protected-call signature is `() => Promise<T>` with no
 * `AbortSignal`, the underlying operation is NOT cancelled on timeout — it runs
 * to completion in the background; only the caller's await rejects with
 * {@linkcode TimeoutError}.
 *
 * @typeParam T - The protected call's result type
 * @param fn - The protected call
 * @param ms - The deadline in milliseconds
 * @param timers - Runtime timers driving the deadline
 * @returns The call result when it settles before the deadline
 * @throws {TimeoutError} When the deadline elapses first
 */
export async function runWithTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  timers: ITimers,
): Promise<T> {
  let handle: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = timers.setTimeout(() => reject(new TimeoutError()), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    timers.clearTimeout(handle);
  }
}
