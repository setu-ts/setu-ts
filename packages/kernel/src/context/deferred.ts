/** Generic request cleanup; deliberately independent of application features. */
import {
  CAPABILITIES,
  describeError,
  isPromiseLike,
  resolveProbeTiming,
  withDeadline,
} from '@setu-ts/common';
import type { ILogger, IRuntimeServices, IServiceRegistry } from '@setu-ts/common';

/** Fixed bound for one asynchronous cleanup. @since 0.11.0 */
const DEFERRED_CLEANUP_TIMEOUT_MS = 5000;

/** How long an abort may wait on a source's `cancel()` before it is reported. @since 0.14.0 */
export const CLEANUP_STALL_WARN_MS = 30_000;

/**
 * Reports, once, an abort still waiting on the source's `cancel()` after
 * {@linkcode CLEANUP_STALL_WARN_MS}, and lets the owner clear the pending
 * timer (at `stop()`).
 *
 * @since 0.14.0
 * @internal
 */
export interface StallWatch {
  /** False once the owner has stopped: then no timer is set at all. */
  open(): boolean;
  /** Called once, with how long the abort has waited. */
  warn(waitedMs: number): void;
  /** Receives the function that clears the pending timer. */
  track(clear: () => void): void;
  /** Called when the timer is gone (it fired or the cancel settled). */
  untrack(clear: () => void): void;
}

/**
 * Internal cleanup callback type.
 * @since 0.11.0
 */
export type DeferredCleanup = () => void | Promise<void>;

/** Reports a cleanup failure once through the sanctioned optional logger. */
function report(registry: IServiceRegistry, error: unknown): void {
  try {
    if (registry.has(CAPABILITIES.LOGGER)) {
      registry
        .get<ILogger>(CAPABILITIES.LOGGER)
        .warn('Deferred request cleanup failed', { error: describeError(error) });
    }
  } catch {
    // The logger itself is unavailable or broken; no safe reporting channel remains.
  }
}

/**
 * Runs every callback in LIFO order, retaining synchronous completion.
 *
 * @param cleanups - Callbacks consumed in reverse order
 *
 * @param registry - Optional failure reporting capability source
 *
 * @returns A promise only when a callback is asynchronous
 *
 * @since 0.11.0
 *
 * @internal
 */
export function runDeferred(
  cleanups: DeferredCleanup[],
  registry: IServiceRegistry,
): void | Promise<void> {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop() as DeferredCleanup;
    try {
      const pending = cleanup();
      if (isPromiseLike(pending)) {
        return withDeadline(() => Promise.resolve(pending), {
          timeoutMs: DEFERRED_CLEANUP_TIMEOUT_MS,
          timing: resolveProbeTiming(registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME)),
          onTimeout: () =>
            new Error(`Deferred request cleanup timeout after ${DEFERRED_CLEANUP_TIMEOUT_MS} ms`),
        })
          .catch((error: unknown) => {
            report(registry, error);
          })
          .then(() => runDeferred(cleanups, registry));
      }
    } catch (error) {
      report(registry, error);
    }
  }
}

/**
 * Wraps a streaming body without prefetching. Cleanup and drain accounting run
 * once when the source ends, errors, or the consumer cancels — or, when a
 * signal is given and there is cleanup to run, when that signal aborts first
 * (a client that left on a runtime that never cancels the body, such as
 * workerd). On abort the source is cancelled first and the cleanups run once
 * its `cancel()` settles, with no time limit; a consumer's cancel, and a read
 * that it ends, wait for the same `cancel()`. A signal always gets a
 * listener, so a body with no cleanup is still cancelled on abort.
 *
 * @param body - Source streaming body
 *
 * @param cleanups - Work owned by this response
 *
 * @param registry - Optional failure reporting capability source
 *
 * @param complete - Releases in-flight accounting after cleanup
 *
 * @param signal - The request's own signal, when the adapter supplied one
 *
 * @param onAbort - Called once when the signal aborts before the stream ended;
 *   the cleanups follow the source's `cancel()`
 *
 * @param stall - Reports an abort still waiting on `cancel()` after 30 s;
 *   omitted, no timer is set
 *
 * @returns The wrapped streaming body
 *
 * @since 0.11.0
 *
 * @internal
 */
export function wrapDeferredStream(
  body: ReadableStream<Uint8Array>,
  cleanups: DeferredCleanup[],
  registry: IServiceRegistry,
  complete: () => void,
  signal?: AbortSignal,
  onAbort?: () => void,
  stall?: StallWatch,
): ReadableStream<Uint8Array> {
  const finish = (): void | Promise<void> => {
    const pending = runDeferred(cleanups, registry);
    if (pending instanceof Promise) return pending.then(complete);
    complete();
  };
  const reader = body.getReader();
  let completed = false;
  // One cancel of the source, shared by the abort and the consumer's cancel,
  // so a second call cannot resolve at once on the closed stream while the
  // first still waits for the source.
  let cancelling: Promise<void> | undefined;
  const cancelSource = (reason: unknown): Promise<void> => {
    if (cancelling !== undefined) return cancelling;
    // Recorded before the source's cancel() runs: a cancel() that aborts the
    // request signal synchronously re-enters here and must join this cancel,
    // not start a second one that resolves at once on the closed stream.
    let settle!: { resolve: () => void; reject: (error: unknown) => void };
    cancelling = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    reader.cancel(reason).then(settle.resolve, settle.reject);
    return cancelling;
  };
  // Set while an abort waits for the source's cancel(); the stream's own end,
  // error or cancel joins it instead of running the cleanups early.
  let aborting: Promise<void> | undefined;
  const once = (): void | Promise<void> => {
    if (aborting !== undefined) return aborting;
    if (completed) return;
    completed = true;
    signal?.removeEventListener('abort', aborted);
    return finish();
  };
  // `once()` removes this listener, so it never runs after completion.
  function aborted(): void {
    // Reported only where there is cleanup to wait for; a body with none is
    // still cancelled, so the source and the drain are released.
    if (cleanups.length > 0) {
      try {
        onAbort?.();
      } catch {
        // Reporting is best effort: the source is still cancelled below.
      }
    }
    // Cancel first and wait for the source's own cancel(), with no time
    // limit: a source whose cancel() waits for work still running (in pull,
    // or a pump it started) keeps the request's resources until it settles,
    // so a limit released through defer still counts it. A pull itself is
    // invisible from a reader, so cancel() is the source's one hook; one that
    // never settles keeps the resources, as a handler that never settles
    // does (security audit P15: a bounded wait let a limit be bypassed).
    const cancelled = cancelSource(signal?.reason);
    // Started after the cancel, so a runtime whose setTimeout throws cannot
    // stop the source being cancelled; such a runtime only loses the warning.
    let stopWatching = (): void => {};
    try {
      stopWatching = watchStall(registry, stall);
    } catch {
      // No warning without a working timer; the wait itself is unchanged.
    }
    aborting = cancelled
      .catch(() => {})
      .then(() => {
        stopWatching();
        completed = true;
        return finish();
      });
  }
  // Every wrapped body with a signal listens: on a runtime that never cancels
  // the body (workerd), the signal is the only notice the client left.
  if (signal !== undefined) {
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            // A consumer's cancel ends a pending read before the source's own
            // cancel() settles: wait for it, so cleanups never run under it.
            if (cancelling !== undefined) await cancelling.catch(() => {});
            await once();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          await once();
          controller.error(error);
        }
      },
      async cancel(reason: unknown): Promise<void> {
        try {
          await cancelSource(reason);
        } finally {
          await once();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Starts the one-shot stall timer for an abort waiting on `cancel()`. The
 * timer comes from the runtime, is unref'd where the runtime can, and never
 * releases anything: it only reports. Returns the function that stops it.
 */
function watchStall(registry: IServiceRegistry, stall: StallWatch | undefined): () => void {
  if (stall === undefined || !stall.open()) return () => {};
  const runtime = registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  const started = runtime.hrtime();
  let pending = true;
  const clear = (): void => {
    if (!pending) return;
    pending = false;
    stall.untrack(clear);
    try {
      runtime.clearTimeout(handle);
    } catch {
      // Best effort: `pending` already silences a late callback.
    }
  };
  const handle = runtime.setTimeout(() => {
    if (!pending) return;
    pending = false;
    stall.untrack(clear);
    stall.warn(runtime.hrtime() - started);
  }, CLEANUP_STALL_WARN_MS);
  // Tracked before anything else can throw, so settle and stop() can clear it.
  stall.track(clear);
  try {
    runtime.unrefTimer?.(handle);
  } catch {
    // The timer still works; it only keeps the process alive until it fires.
  }
  return clear;
}
