/**
 * Tests for {@linkcode looksLikeNodeReadable}, {@linkcode createBoundedNodeStream},
 * and {@linkcode createEagerIterableStream} — the cancellation-safe stream
 * adapters behind the three cloud providers' `getStream`.
 *
 * The closed-flag tests are the deterministic core of the stream-cancel-race
 * regression: a chunk that surfaces AFTER `cancel()` must be a deliberate
 * drop, never an `enqueue()` into a closed controller (which escapes as an
 * uncaught, process-killing TypeError).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { PassThrough } from 'node:stream';
import {
  createBoundedNodeStream,
  createEagerIterableStream,
  looksLikeNodeReadable,
} from '../../src/providers/provider-stream.ts';
import type { NodeSdkReadable } from '../../src/providers/provider-stream.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── looksLikeNodeReadable ──────────────────────────────────────────────────

describe('looksLikeNodeReadable', () => {
  it('accepts a real node stream', () => {
    expect(looksLikeNodeReadable(new PassThrough())).toBe(true);
  });

  it('accepts a hand-rolled shape carrying on/once/off/read/destroy', () => {
    const fake = {
      on() {},
      once() {},
      off() {},
      read(): Uint8Array | null {
        return null;
      },
      destroy() {},
    };
    expect(looksLikeNodeReadable(fake)).toBe(true);
  });

  it('rejects a web ReadableStream, plain objects, and non-objects', () => {
    expect(looksLikeNodeReadable(new ReadableStream())).toBe(false);
    expect(looksLikeNodeReadable({ on() {} })).toBe(false);
    expect(looksLikeNodeReadable(new Uint8Array(4))).toBe(false);
    expect(looksLikeNodeReadable(null)).toBe(false);
    expect(looksLikeNodeReadable(undefined)).toBe(false);
    expect(looksLikeNodeReadable('readable')).toBe(false);
  });
});

// ── createBoundedNodeStream (the S3 wrapper) ───────────────────────────────

describe('createBoundedNodeStream', () => {
  it('delivers written chunks in order and closes on end', async () => {
    const pt = new PassThrough();
    const stream = createBoundedNodeStream(pt);
    pt.write(new Uint8Array([1, 2]));
    pt.write(new Uint8Array([3]));
    pt.end();
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect([...first.value!]).toEqual([1, 2]);
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect([...second.value!]).toEqual([3]);
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it('propagates an underlying error to the consumer', async () => {
    const pt = new PassThrough();
    // Node raises an unhandled 'error' event when a stream is destroyed with
    // an error and no listener is attached yet; the wrapper re-delivers the
    // error to the consumer itself, so this sink only satisfies node.
    pt.on('error', () => {});
    const stream = createBoundedNodeStream(pt);
    pt.destroy(new Error('origin reset'));
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow('origin reset');
  });

  it('closes immediately when the source ended before the first pull', async () => {
    const pt = new PassThrough();
    pt.end(); // ended before anyone wrapped or read it
    const stream = createBoundedNodeStream(pt);
    const reader = stream.getReader();
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it('errors immediately when the source errored before the first pull', async () => {
    const pt = new PassThrough();
    pt.on('error', () => {}); // sink — see the note in the test above
    pt.destroy(new Error('pre-wrapped failure'));
    const stream = createBoundedNodeStream(pt);
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toThrow('pre-wrapped failure');
  });

  it('wraps a non-Error underlying error value into an Error before surfacing it', async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const scripted = {
      on(event: string, fn: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      once(event: string, fn: (...args: unknown[]) => void) {
        scripted.on(event, fn);
      },
      off(event: string, fn: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(fn);
      },
      read(): Uint8Array | null {
        return null;
      },
      destroy() {},
      emit(event: string, ...args: unknown[]): void {
        for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
      },
    } as unknown as NodeSdkReadable & { emit(event: string, ...args: unknown[]): void };
    const stream = createBoundedNodeStream(scripted);
    const reader = stream.getReader();
    const pending = reader.read().catch((e: unknown) => e);
    // Let the deferred pull run so its 'error' listener is attached first.
    await tick();
    scripted.emit('error', 'a string, not an Error');
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('a string, not an Error');
  });

  it('cancel destroys the underlying stream', async () => {
    const pt = new PassThrough();
    const stream = createBoundedNodeStream(pt);
    const reader = stream.getReader();
    pt.write(new Uint8Array([5]));
    await reader.read();
    await reader.cancel();
    expect(pt.destroyed).toBe(true);
  });

  it('a chunk surfacing after cancel is a deliberate drop, NOT an enqueue into a closed controller', async () => {
    // Hand-rolled source with the full node shape so the test can replay the
    // exact defect timing: pull() is waiting for a chunk, cancel() runs, and
    // THEN the source produces one more chunk (the node flow machinery's
    // late 'data'). On the unwrapped adapter stream this threw the uncaught
    // "The stream controller cannot close or enqueue"; here it must be a
    // silent, deliberate drop.
    let destroyed = false;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const buffer: Uint8Array[] = [];
    const scripted = {
      on(event: string, fn: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      once(event: string, fn: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off(event: string, fn: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(fn);
      },
      read(): Uint8Array | null {
        return buffer.shift() ?? null;
      },
      destroy() {
        destroyed = true;
      },
      emit(event: string, ...args: unknown[]): void {
        for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
      },
    } as unknown as NodeSdkReadable & { emit(event: string, ...args: unknown[]): void };

    const stream = createBoundedNodeStream(scripted);
    const reader = stream.getReader();
    // Land one chunk so the wrapper has pulled and is waiting on 'readable'.
    buffer.push(new Uint8Array([9]));
    scripted.emit('readable');
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Re-enter the waiting pull: the wrapper's next pull attaches listeners
    // and finds no buffered chunk. Let that deferred pull run so its
    // 'readable' listener is attached, THEN cancel, THEN the late chunk
    // arrives — the listener fires with the stream already closed and must
    // settle without touching the closed controller.
    const pendingRead = reader.read();
    await tick();
    await reader.cancel();
    buffer.push(new Uint8Array([7, 7])); // the late 'data' the race produced
    scripted.emit('readable'); // must NOT enqueue into the closed controller
    scripted.emit('end'); // must NOT close an already-closed controller
    await pendingRead;
    await tick();
    expect(destroyed).toBe(true);
    // No uncaught TypeError reached this line — the assertion is the absence
    // of the crash, which is what the defect was.
  });

  it('a real node stream pushing after cancel does not throw either', async () => {
    const pt = new PassThrough();
    pt.on('error', () => {}); // pipeline-owned errors; a post-destroy write raises one
    const stream = createBoundedNodeStream(pt);
    const reader = stream.getReader();
    pt.write(new Uint8Array([5]));
    await reader.read();
    await reader.cancel();
    pt.write(new Uint8Array([6])); // ERR_STREAM_DESTROYED — must be contained
    await tick();
    expect(pt.destroyed).toBe(true);
  });

  it('closes immediately when the source reports readableEnded before the first pull', async () => {
    // A source that has already ended by the time the first pull runs. Node
    // will not re-emit 'end' retroactively, so the wrapper must consult the
    // advisory `readableEnded` flag and close without waiting on an event.
    const ended = {
      on() {},
      once() {},
      off() {},
      read(): Uint8Array | null {
        return null;
      },
      destroy() {},
      readableEnded: true,
    };
    const stream = createBoundedNodeStream(ended);
    const reader = stream.getReader();
    const done = await reader.read();
    expect(done.done).toBe(true);
  });
});

// ── createEagerIterableStream (the GCS/Azure wrapper) ──────────────────────

describe('createEagerIterableStream', () => {
  it('drains the iterable eagerly and closes when done', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      yield new Uint8Array([2, 2]);
    }
    const stream = createEagerIterableStream(source());
    const reader = stream.getReader();
    const first = await reader.read();
    expect([...first.value!]).toEqual([1]);
    const second = await reader.read();
    expect([...second.value!]).toEqual([2, 2]);
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it('propagates an iterable error to the consumer', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error('connection dropped');
    }
    const stream = createEagerIterableStream(source());
    const reader = stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow('connection dropped');
  });

  it('wraps a non-Error thrown value into an Error before surfacing it', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      throw 'a string, not an Error';
    }
    const stream = createEagerIterableStream(source());
    const reader = stream.getReader();
    await reader.read();
    const err = await reader.read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('a string, not an Error');
  });

  it('cancel releases the iterator and destroys the source; later chunks are dropped, not enqueued', async () => {
    let destroys = 0;
    let afterCancelYields = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      // Reaching here means the consumer cancelled mid-download; the chunks
      // below used to be enqueued into the closed controller (uncaught
      // TypeError). Now they must simply never be enqueued.
      for (let i = 0; i < 3; i++) {
        await tick();
        afterCancelYields++;
        yield new Uint8Array([i]);
      }
    }
    const generator = source();
    const sourceWithDestroy = Object.assign(generator, {
      destroy(): void {
        destroys++;
      },
    });
    const stream = createEagerIterableStream(sourceWithDestroy);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    expect(destroys).toBe(1);
    await tick();
    await tick();
    await tick();
    // The consumer sees a cleanly cancelled stream, and nothing crashed —
    // the absence of the uncaught enqueue IS the regression assertion.
    const done = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    expect(done.done).toBe(true);
  });

  it('cancel without a destroy-capable source still releases the iterator', async () => {
    let returned = 0;
    const iterator: AsyncIterator<Uint8Array> = {
      next(): Promise<IteratorResult<Uint8Array>> {
        return Promise.resolve({ done: false, value: new Uint8Array([1]) });
      },
      return(): Promise<IteratorResult<Uint8Array>> {
        returned++;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    const stream = createEagerIterableStream(source);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(returned).toBe(1);
  });

  it('a failing iterator teardown is swallowed after cancel (nothing left to report)', async () => {
    // The consumer already cancelled; the iterator's own return() rejecting is
    // teardown noise the wrapper must absorb, not surface as an uncaught
    // rejection.
    let returned = 0;
    const iterator: AsyncIterator<Uint8Array> = {
      next(): Promise<IteratorResult<Uint8Array>> {
        return Promise.resolve({ done: false, value: new Uint8Array([1]) });
      },
      return(): Promise<IteratorResult<Uint8Array>> {
        returned++;
        return Promise.reject(new Error('teardown failed'));
      },
    };
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    const stream = createEagerIterableStream(source);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await tick();
    expect(returned).toBe(1);
    // Reaching here without an uncaught rejection IS the assertion.
  });

  it('a throwing destroy is swallowed after cancel (already being torn down)', async () => {
    let destroyed = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      await tick();
      yield new Uint8Array([2]);
    }
    const sourceWithDestroy = Object.assign(source(), {
      destroy(): void {
        destroyed++;
        throw new Error('already destroyed');
      },
    });
    const stream = createEagerIterableStream(sourceWithDestroy);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await tick();
    expect(destroyed).toBe(1);
    // The throw was contained — no uncaught error reached this line.
  });
});
