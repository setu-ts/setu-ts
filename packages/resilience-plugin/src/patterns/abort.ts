/**
 * Cancellation plumbing shared by the four resilience patterns.
 *
 * Every layer needs the same three things — link an outer signal to an inner
 * controller without leaking the listener, fail fast when a signal is already
 * aborted, and read an abort reason as an `Error` — so they live here rather
 * than being re-derived (slightly differently) in each pattern.
 *
 * Internal to the resilience plugin: not exported from `src/index.ts`.
 *
 * @module
 */

/**
 * The error a signal aborted without an explicit reason reports.
 *
 * Runtimes populate `AbortSignal.reason` with a `DOMException` named
 * `AbortError`, but that type is not available on every supported runtime, so
 * the reason is normalized to a plain `Error` when it is not already one.
 */
const DEFAULT_ABORT_MESSAGE = 'The operation was aborted';

/**
 * Normalizes a signal's abort reason to something throwable.
 *
 * A signal aborted through `controller.abort(new TimeoutError())` carries that
 * error and it is returned untouched, which is what preserves a single error
 * identity for a timeout. A signal aborted with no argument, or with a
 * non-`Error` value, yields an `Error` instead, so a caller's `catch` never
 * receives a bare string.
 *
 * @param signal - The aborted signal
 * @returns The reason as an `Error`
 */
export function abortReasonOf(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  if (reason === undefined) {
    return new Error(DEFAULT_ABORT_MESSAGE);
  }
  return new Error(String(reason));
}

/**
 * Rejects immediately when `signal` is already aborted.
 *
 * Called at the top of each retry attempt and before a bulkhead waiter is
 * queued, so a cancelled operation never starts new work.
 *
 * @param signal - The signal to check; `undefined` is never aborted
 * @throws {Error} The signal's abort reason, normalized by
 * {@linkcode abortReasonOf}
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReasonOf(signal);
  }
}

/**
 * Propagates an outer signal's abort into `controller`, and returns a disposer
 * that unsubscribes.
 *
 * The disposer is what keeps a long-lived caller signal from accumulating one
 * listener per wrapped invocation — a leak that no happy-path test would
 * notice. Callers must invoke it in a `finally`.
 *
 * When `outer` is already aborted the controller is aborted synchronously and
 * the returned disposer is a no-op, so there is no window in which the inner
 * call runs unaborted.
 *
 * @param outer - The caller-owned signal; `undefined` links nothing
 * @param controller - The per-attempt controller to abort
 * @returns A disposer removing the listener
 */
export function linkAbort(
  outer: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (outer === undefined) {
    return () => {};
  }
  if (outer.aborted) {
    controller.abort(outer.reason);
    return () => {};
  }
  const onAbort = (): void => {
    controller.abort(outer.reason);
  };
  outer.addEventListener('abort', onAbort, { once: true });
  return () => {
    outer.removeEventListener('abort', onAbort);
  };
}
