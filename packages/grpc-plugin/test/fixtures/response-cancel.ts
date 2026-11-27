import { expect } from 'vitest';

/** Both protocol reply builders must cooperate with blocked handlers identically. */
export async function checkResponseCancel(
  build: (body: AsyncIterable<Uint8Array>, abort: AbortController) => ReadableStream<Uint8Array>,
): Promise<void> {
  const abort = new AbortController();
  const reason = new Error('client left');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cleaned = false;
  async function* source() {
    try {
      await new Promise<void>((resolve) => {
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
        entered();
      });
      yield new Uint8Array([1]);
    } finally {
      cleaned = true;
    }
  }
  const stream = build(source(), abort);
  await started;
  await stream.cancel(reason);
  expect(abort.signal.reason).toBe(reason);
  expect(cleaned).toBe(true);

  const ignored = new AbortController();
  let release!: () => void;
  let waiting!: () => void;
  const ready = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  async function* uncooperative() {
    await new Promise<void>((resolve) => {
      release = resolve;
      waiting();
    });
    yield new Uint8Array([2]);
  }
  const held = build(uncooperative(), ignored);
  await ready;
  let settled = false;
  const canceled = held.cancel(reason).then(() => {
    settled = true;
  });
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(ignored.signal.aborted).toBe(true);
  expect(settled).toBe(false);
  release();
  await canceled;

  const ordered = new AbortController();
  let returned = false;
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<never>(() => {}),
      return: () => {
        expect(ordered.signal.aborted).toBe(true);
        returned = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
  await build(iterable, ordered).cancel(reason);
  expect(returned).toBe(true);
}
