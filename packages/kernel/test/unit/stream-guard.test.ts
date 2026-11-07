import { describe, expect, it } from 'vitest';
import { guardEmptyChunks } from '../../src/context/stream-guard.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A source that yields the given chunks, then closes; records cancellation. */
function source(chunks: readonly Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => unknown;
} {
  let index = 0;
  let reason: unknown = 'not cancelled';
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else controller.close();
      },
      cancel(why): void {
        reason = why;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelled: () => reason };
}

/** Lets pending microtasks run without advancing the fake clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('guardEmptyChunks', () => {
  it('passes non-empty chunks through unchanged and in order', async () => {
    const { runtime } = createFakeRuntime();
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    const reader = guardEmptyChunks(source([a, b]).stream, runtime).getReader();
    expect((await reader.read()).value).toBe(a);
    expect((await reader.read()).value).toBe(b);
    expect((await reader.read()).done).toBe(true);
  });

  it('drops an empty chunk and waits a timer turn before reading on', async () => {
    const { runtime, tick } = createFakeRuntime();
    const data = new Uint8Array([7]);
    const reader = guardEmptyChunks(source([new Uint8Array(0), data]).stream, runtime).getReader();
    let result: ReadableStreamReadResult<Uint8Array> | undefined;
    void reader.read().then((r) => (result = r));
    // Microtasks alone cannot deliver the next chunk: the guard is waiting on
    // a runtime timer, which is what lets the event loop run in between.
    await settle();
    expect(result).toBeUndefined();
    tick(0);
    await settle();
    expect(result?.value).toBe(data);
  });

  it('treats an empty view of any typed-array kind as empty, but not a non-empty one', async () => {
    const { runtime, tick } = createFakeRuntime();
    const data = new Uint8Array([9]);
    const empties = [
      new Uint8Array(0),
      new Uint8Array(new ArrayBuffer(8), 8, 0),
      new DataView(new ArrayBuffer(4), 4, 0) as unknown as Uint8Array,
    ];
    const reader = guardEmptyChunks(source([...empties, data]).stream, runtime).getReader();
    let result: ReadableStreamReadResult<Uint8Array> | undefined;
    void reader.read().then((r) => (result = r));
    for (let i = 0; i < empties.length; i++) {
      await settle();
      expect(result).toBeUndefined();
      tick(0);
    }
    await settle();
    expect(result?.value).toBe(data);
  });

  it('closes after trailing empty chunks', async () => {
    const { runtime, tick } = createFakeRuntime();
    const reader = guardEmptyChunks(source([new Uint8Array(0)]).stream, runtime).getReader();
    let result: ReadableStreamReadResult<Uint8Array> | undefined;
    void reader.read().then((r) => (result = r));
    await settle();
    tick(0);
    await settle();
    expect(result?.done).toBe(true);
  });

  it('forwards cancellation to the source', async () => {
    const { runtime } = createFakeRuntime();
    const src = source([new Uint8Array([1])]);
    await guardEmptyChunks(src.stream, runtime).cancel('client gone');
    expect(src.cancelled()).toBe('client gone');
  });

  it('propagates a source error to the reader', async () => {
    const { runtime } = createFakeRuntime();
    const failing = new ReadableStream<Uint8Array>({
      pull(): void {
        throw new Error('source failed');
      },
    });
    await expect(guardEmptyChunks(failing, runtime).getReader().read()).rejects.toThrow(
      'source failed',
    );
  });
});
