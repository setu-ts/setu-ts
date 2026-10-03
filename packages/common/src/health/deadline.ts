/**
 * A bound on one backend call whose expiry is a recorded failure.
 *
 * @module
 *
 * {@linkcode createCachedProbe} is the HEALTH-side helper: it caches,
 * coalesces and resolves a fallback, and it never rejects. That is exactly
 * the wrong shape for a call on the request path — a read of a secret, the
 * acquire of a scheduler lock — where a backend that stops answering must
 * surface as a failure the caller can see and count. A swallowed timeout is
 * the "parked calls later counted as succeeded" defect (V8-5).
 *
 * `withDeadline` is that shape: it hands the call an `AbortSignal`, races the
 * call against the deadline rather than trusting the signal alone (an
 * injected seam may ignore it), aborts the signal and REJECTS with the
 * caller's own error when the deadline fires, and never swallows the call's
 * own rejection. A client that owns a native per-command timeout (ioredis
 * `commandTimeout`) should use that instead: it also stops the parked command
 * from completing later, which a race around the promise cannot do.
 *
 * @since 0.9.0
 */
import type { TimerHandle } from '../runtime.ts';
import type { ProbeTiming } from './probe.ts';

/** The largest delay a runtime timer accepts before it fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Options for {@linkcode withDeadline}.
 *
 * @since 0.9.0
 */
export interface DeadlineOptions {
  /**
   * How long the call may run, in milliseconds. `0` means unbounded: no timer
   * is armed and the call's own outcome is returned unchanged.
   *
   * Must be a finite number in `0`–`2147483647` (the runtime timer range).
   */
  readonly timeoutMs: number;
  /**
   * Builds the error the returned promise rejects with when the deadline
   * fires. Called at most once, and only on expiry.
   */
  readonly onTimeout: () => Error;
  /**
   * Timer surface the deadline runs on — typically
   * `resolveProbeTiming(ctx.runtime)`. Only `setTimer`/`clearTimer` are read.
   *
   * @default the ambient `setTimeout`/`clearTimeout`, for a caller with no
   *   runtime to hand (the {@linkcode createCachedProbe} default)
   */
  readonly timing?: Pick<ProbeTiming, 'setTimer' | 'clearTimer'>;
}

/**
 * Checks a deadline value, returning the refusal or `null` when it is valid.
 *
 * Exported so an option holder can refuse a bad value at CONSTRUCTION with the
 * same rule {@linkcode withDeadline} applies at call time, instead of the
 * first call discovering it.
 *
 * @param name - The option name, used in the refusal message
 * @param timeoutMs - The value to check
 * @returns A `RangeError` naming the option, or `null` when the value is valid
 *
 * @example
 * ```typescript
 * const refusal = deadlineRangeError('requestTimeoutMs', options.requestTimeoutMs);
 * if (refusal !== null) throw refusal;
 * ```
 * @since 0.9.0
 */
export function deadlineRangeError(name: string, timeoutMs: number): RangeError | null {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
    return new RangeError(
      `${name} must be a finite number between 0 and ${MAX_TIMER_MS} milliseconds ` +
        '(0 disables the bound).',
    );
  }
  return null;
}

/**
 * Runs one backend call under a deadline whose expiry is a rejection.
 *
 * The call receives an `AbortSignal`. When the deadline fires, the signal is
 * aborted with the caller's error and the returned promise rejects with that
 * same error — even if the call ignores the signal and never settles. The
 * call's own rejection (including a synchronous throw) is propagated
 * unchanged, never masked by the deadline. The timer is cleared on every path.
 *
 * An out-of-range `timeoutMs` REJECTS with `RangeError` rather than throwing,
 * so a caller chaining `.catch()` sees it.
 *
 * @param run - The call; receives the signal to forward to its transport
 * @param options - The bound, the expiry error and the timer surface
 * @returns The call's value, or a rejection with the call's error or the
 *   deadline's
 * @throws {RangeError} (as a rejection) when `timeoutMs` is out of range
 *
 * @example
 * ```typescript
 * const response = await withDeadline(
 *   (signal) => fetch(url, { signal }),
 *   {
 *     timeoutMs: 5000,
 *     onTimeout: () => new Error('the vault did not answer in 5000 ms'),
 *     timing: resolveProbeTiming(ctx.runtime),
 *   },
 * );
 * ```
 * @since 0.9.0
 */
export function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const refusal = deadlineRangeError('timeoutMs', options.timeoutMs);
  if (refusal !== null) {
    return Promise.reject(refusal);
  }
  const controller = new AbortController();
  // `Promise.resolve().then(...)` turns a synchronous throw from `run` into a
  // rejection, so the returned promise is the only failure channel.
  const call = Promise.resolve().then(() => run(controller.signal));
  if (options.timeoutMs === 0) {
    return call;
  }
  const setTimer = options.timing?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.timing?.clearTimer ?? ((handle: TimerHandle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  let timer: TimerHandle;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      const error = options.onTimeout();
      controller.abort(error);
      reject(error);
    }, options.timeoutMs);
  });
  return Promise.race([call, deadline]).finally(() => {
    clearTimer(timer);
  });
}
