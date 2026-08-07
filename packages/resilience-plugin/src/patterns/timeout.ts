/**
 * Timeout pattern — bounds a protected call by a deadline and cancels it.
 *
 * @module
 */
import type { ResilientCall } from '@setu-ts/common';
import type { ITimers } from '../interfaces/index.ts';
import { TimeoutError } from '../errors.ts';
import { linkAbort, throwIfAborted } from './abort.ts';

/**
 * Runs `fn` under a `ms`-millisecond deadline, aborting the signal it receives
 * when the deadline elapses.
 *
 * The call is handed a fresh {@linkcode AbortSignal} per attempt. On deadline
 * that signal is aborted with a {@linkcode TimeoutError} as its `reason` — the
 * same error instance the returned promise rejects with, so a timeout has
 * exactly one error identity whether it is observed through `catch` or through
 * `signal.reason`. A call that forwards the signal to its I/O (`fetch(url, {
 * signal })`, an abortable driver) is therefore genuinely cancelled.
 *
 * A call that ignores the signal cannot be stopped by anyone, and runs to
 * completion in the background while the caller's `await` rejects. That is a
 * property of the supplied function, not of this wrapper.
 *
 * An `outer` signal is linked in: aborting it cancels the attempt with the
 * caller's own reason. The link is removed and the deadline timer cleared in a
 * `finally`, so neither a handle nor a listener leaks. An `outer` that is
 * ALREADY aborted rejects before `fn` is invoked — a cancelled operation must
 * not start new work, which is the same rule the retry and bulkhead layers
 * follow.
 *
 * @typeParam T - The protected call's result type
 * @param fn - The protected call
 * @param ms - The deadline in milliseconds
 * @param timers - Runtime timers driving the deadline
 * @param outer - Optional caller-owned signal cancelling the attempt
 * @returns The call result when it settles before the deadline
 * @throws {TimeoutError} When the deadline elapses first
 */
export async function runWithTimeout<T>(
  fn: ResilientCall<T>,
  ms: number,
  timers: ITimers,
  outer?: AbortSignal,
): Promise<T> {
  throwIfAborted(outer);

  const controller = new AbortController();
  const unlink = linkAbort(outer, controller);

  let handle: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = timers.setTimeout(() => {
      const error = new TimeoutError();
      // Abort before rejecting, so a call watching the signal observes the
      // cancellation rather than racing the caller's rejection.
      controller.abort(error);
      reject(error);
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    timers.clearTimeout(handle);
    unlink();
  }
}
