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
 * once when the source ends, errors, or the consumer cancels.
 *
 * @param body - Source streaming body
 *
 * @param cleanups - Work owned by this response
 *
 * @param registry - Optional failure reporting capability source
 *
 * @param complete - Releases in-flight accounting after cleanup
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
): ReadableStream<Uint8Array> {
  const finish = (): void | Promise<void> => {
    const pending = runDeferred(cleanups, registry);
    if (pending instanceof Promise) return pending.then(complete);
    complete();
  };
  const reader = body.getReader();
  let completed = false;
  const once = (): void | Promise<void> => {
    if (completed) return;
    completed = true;
    return finish();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
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
          await reader.cancel(reason);
        } finally {
          await once();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
