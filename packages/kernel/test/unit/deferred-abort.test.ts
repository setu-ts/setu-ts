/**
 * `wrapDeferredStream` with the request's signal (V13-200): cleanups run once,
 * on whichever comes first, the stream finishing or the signal aborting.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';

import { CAPABILITIES } from '@setu-ts/common';

import { wrapDeferredStream } from '../../src/context/deferred.ts';
import type { StallWatch } from '../../src/context/deferred.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A registry holding a fake runtime whose timers the test advances. */
function withRuntime(): { registry: ServiceRegistry; tick: (ms: number) => void } {
  const fake = createFakeRuntime();
  const registry = new ServiceRegistry();
  registry.register(CAPABILITIES.RUNTIME, fake.runtime);
  return { registry, tick: fake.tick };
}

/** Lets promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A source that never ends unless cancelled. */
function endless(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
  });
}

describe('wrapDeferredStream and the request signal', () => {
  it('cancels the source first, then runs the cleanups, for a signal that was already aborted', async () => {
    const order: string[] = [];
    const client = new AbortController();
    client.abort();
    wrapDeferredStream(
      endless(() => order.push('source cancelled')),
      [() => void order.push('cleanup')],
      withRuntime().registry,
      () => order.push('complete'),
      client.signal,
      () => order.push('aborted'),
    );
    await settle();
    expect(order).toEqual(['aborted', 'source cancelled', 'cleanup', 'complete']);
  });

  it('waits for a source whose cancel() waits for its pending pull (security audit)', async () => {
    const order: string[] = [];
    let finishPull!: () => void;
    let pulling: Promise<void> | undefined;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        // Pulled ahead to fill the queue: work no read of the kernel's waits on.
        pulling ??= new Promise<void>((resolve) => {
          finishPull = () => {
            order.push('pull settled');
            resolve();
          };
        });
        return pulling;
      },
      cancel() {
        order.push('source cancel');
        return pulling;
      },
    });
    const client = new AbortController();
    wrapDeferredStream(
      source,
      [() => void order.push('cleanup')],
      withRuntime().registry,
      () => order.push('complete'),
      client.signal,
      () => order.push('aborted'),
    );
    await settle();
    client.abort();
    await settle();
    expect(order).toEqual(['aborted', 'source cancel']);
    finishPull();
    await settle();
    expect(order).toEqual(['aborted', 'source cancel', 'pull settled', 'cleanup', 'complete']);
  });

  it('keeps the cleanups while cancel() never settles, with no timer (security audit P15)', async () => {
    let cleaned = 0;
    const fake = createFakeRuntime();
    const registry = new ServiceRegistry();
    registry.register(CAPABILITIES.RUNTIME, fake.runtime);
    const timers = vi.spyOn(fake.runtime, 'setTimeout');
    const source = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
    });
    const client = new AbortController();
    wrapDeferredStream(source, [() => void cleaned++], registry, () => {}, client.signal);
    client.abort();
    await settle();
    fake.tick(60_000);
    await settle();
    // The request's resources stay held, so a limit released through defer
    // still counts it; the kernel holds no timer for it.
    expect(cleaned).toBe(0);
    expect(timers).not.toHaveBeenCalled();
  });

  it('runs the cleanups once, after the source settles, when the consumer cancels before the abort (code review)', async () => {
    const order: string[] = [];
    let finishPull!: () => void;
    let pulling: Promise<void> | undefined;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        pulling ??= new Promise<void>((resolve) => {
          finishPull = () => {
            order.push('pull settled');
            resolve();
          };
        });
        return pulling;
      },
      cancel() {
        order.push('source cancel');
        return pulling;
      },
    });
    const client = new AbortController();
    const wrapped = wrapDeferredStream(
      source,
      [() => void order.push('cleanup')],
      withRuntime().registry,
      () => order.push('complete'),
      client.signal,
      () => order.push('aborted'),
    );
    await settle();
    const consumerCancel = wrapped.cancel('consumer left');
    client.abort();
    await settle();
    expect(order).toEqual(['source cancel', 'aborted']);
    finishPull();
    await consumerCancel;
    await settle();
    expect(order).toEqual(['source cancel', 'aborted', 'pull settled', 'cleanup', 'complete']);
  });

  /** A stall watch recording warnings and the clears it was handed. */
  function stallWatch(): {
    watch: StallWatch;
    warned: number[];
    tracked: Set<() => void>;
  } {
    const warned: number[] = [];
    const tracked = new Set<() => void>();
    return {
      warned,
      tracked,
      watch: {
        warn: (waitedMs) => void warned.push(waitedMs),
        track: (clear) => void tracked.add(clear),
        untrack: (clear) => void tracked.delete(clear),
      },
    };
  }

  /** A source whose cancel() settles only when released. */
  function heldCancel(): { stream: ReadableStream<Uint8Array>; release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { stream: new ReadableStream<Uint8Array>({ cancel: () => held }), release };
  }

  it('warns once, after 30 s, while cancel() has not settled, and still holds the cleanups', async () => {
    const fake = createFakeRuntime();
    const registry = new ServiceRegistry();
    registry.register(CAPABILITIES.RUNTIME, fake.runtime);
    const stall = stallWatch();
    let cleaned = 0;
    const source = heldCancel();
    const client = new AbortController();
    wrapDeferredStream(
      source.stream,
      [() => void cleaned++],
      registry,
      () => {},
      client.signal,
      undefined,
      stall.watch,
    );
    client.abort();
    await settle();
    expect(stall.tracked.size).toBe(1);
    fake.tick(29_999);
    await settle();
    expect(stall.warned).toEqual([]);
    fake.tick(30_000);
    fake.tick(30_000);
    await settle();
    // One warning; the fake clock has advanced 59 999 ms by now.
    expect(stall.warned).toHaveLength(1);
    expect(stall.warned[0]).toBeGreaterThanOrEqual(30_000);
    expect(stall.tracked.size).toBe(0);
    expect(cleaned).toBe(0);
    source.release();
    await settle();
    expect(cleaned).toBe(1);
  });

  it('clears the stall timer and never warns when cancel() settles first', async () => {
    const fake = createFakeRuntime();
    const registry = new ServiceRegistry();
    registry.register(CAPABILITIES.RUNTIME, fake.runtime);
    const cleared = vi.spyOn(fake.runtime, 'clearTimeout');
    const stall = stallWatch();
    const source = heldCancel();
    const client = new AbortController();
    wrapDeferredStream(
      source.stream,
      [() => {}],
      registry,
      () => {},
      client.signal,
      undefined,
      stall.watch,
    );
    client.abort();
    await settle();
    source.release();
    await settle();
    expect(cleared).toHaveBeenCalledOnce();
    expect(stall.tracked.size).toBe(0);
    fake.tick(30_000);
    await settle();
    expect(stall.warned).toEqual([]);
  });

  it('asks the runtime to unref the stall timer where it can', async () => {
    const fake = createFakeRuntime();
    const unrefed: unknown[] = [];
    const runtime = Object.assign(fake.runtime, {
      unrefTimer: (handle: unknown) => void unrefed.push(handle),
    });
    const registry = new ServiceRegistry();
    registry.register(CAPABILITIES.RUNTIME, runtime);
    const client = new AbortController();
    wrapDeferredStream(
      heldCancel().stream,
      [() => {}],
      registry,
      () => {},
      client.signal,
      undefined,
      stallWatch().watch,
    );
    client.abort();
    await settle();
    expect(unrefed).toHaveLength(1);
  });

  it('sets no stall timer without a stall watch', async () => {
    const fake = createFakeRuntime();
    const registry = new ServiceRegistry();
    registry.register(CAPABILITIES.RUNTIME, fake.runtime);
    const timers = vi.spyOn(fake.runtime, 'setTimeout');
    const client = new AbortController();
    wrapDeferredStream(heldCancel().stream, [() => {}], registry, () => {}, client.signal);
    client.abort();
    await settle();
    expect(timers).not.toHaveBeenCalled();
  });

  it('runs the cleanups without waiting for a source with no cancel()', async () => {
    let cleaned = 0;
    const client = new AbortController();
    wrapDeferredStream(
      new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }),
      [() => void cleaned++],
      withRuntime().registry,
      () => {},
      client.signal,
    );
    client.abort();
    await settle();
    expect(cleaned).toBe(1);
  });

  it('ignores an abort that comes after the stream finished', async () => {
    let cleaned = 0;
    let aborts = 0;
    const client = new AbortController();
    const wrapped = wrapDeferredStream(
      new Blob(['ok']).stream(),
      [() => void cleaned++],
      new ServiceRegistry(),
      () => {},
      client.signal,
      () => void aborts++,
    );
    expect(await new Response(wrapped).text()).toBe('ok');
    client.abort();
    await Promise.resolve();
    expect(cleaned).toBe(1);
    expect(aborts).toBe(0);
  });

  it('attaches nothing when there is no cleanup to run', async () => {
    let aborts = 0;
    const client = new AbortController();
    wrapDeferredStream(
      endless(() => {}),
      [],
      new ServiceRegistry(),
      () => {},
      client.signal,
      () => void aborts++,
    );
    client.abort();
    await Promise.resolve();
    expect(aborts).toBe(0);
  });
});
