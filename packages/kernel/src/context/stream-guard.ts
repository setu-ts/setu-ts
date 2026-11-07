/**
 * Guard for streamed response bodies that emit zero-length chunks.
 *
 * Adapters pump a body by writing a chunk and reading the next one as soon as
 * the write reports no backpressure (`@hono/node-server`'s writer chains
 * `reader.read().then(flow)` while `write()` returns `true`). An empty chunk
 * always writes `true` and carries nothing to flush, so a source that emits
 * empty chunks without pause turned that pump into an unbounded promise chain:
 * the event loop never ran a timer or I/O callback again and the heap grew
 * until the process aborted. The guard drops empty chunks and, after each one,
 * waits for a runtime timer before reading again, so such a source costs one
 * timer tick per chunk instead of the whole process.
 *
 * @module
 * @internal
 */

import type { IRuntimeServices } from '@setu-ts/common';

/** Whether a chunk carries no bytes (an empty typed array or `ArrayBuffer` view). */
function isEmptyChunk(value: unknown): boolean {
  return ArrayBuffer.isView(value) && value.byteLength === 0;
}

/**
 * Wraps a response body so zero-length chunks are dropped and cannot starve the
 * event loop.
 *
 * Every non-empty chunk passes through unchanged and in order; completion,
 * errors and cancellation reach the source exactly as before.
 *
 * @param body - The handler's streamed body
 * @param runtime - Supplies the timer that yields between empty chunks
 * @returns A stream with no empty chunks
 *
 * @internal
 */
export function guardEmptyChunks(
  body: ReadableStream<Uint8Array>,
  runtime: IRuntimeServices,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const nextTurn = (): Promise<void> =>
    new Promise<void>((resolve) => {
      runtime.setTimeout(resolve, 0);
    });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          if (!isEmptyChunk(chunk.value)) {
            controller.enqueue(chunk.value);
            return;
          }
          // Yield a whole turn of the event loop, not a microtask: only a timer
          // lets I/O, other requests and timeouts run between empty chunks.
          await nextTurn();
        }
      },
      cancel(reason: unknown): Promise<void> {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
