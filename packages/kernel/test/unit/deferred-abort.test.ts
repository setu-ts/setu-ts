/**
 * `wrapDeferredStream` with the request's signal (V13-200): cleanups run once,
 * on whichever comes first, the stream finishing or the signal aborting.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';

import { CAPABILITIES } from '@setu-ts/common';

import { wrapDeferredStream } from '../../src/context/deferred.ts';
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
