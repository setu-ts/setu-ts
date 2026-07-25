/**
 * Unit tests for the web worker host (Deno/Bun `Worker` normalization),
 * driven through the injectable {@linkcode WebWorkerGlobals} seam.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createWebWorkerHost,
  readWebWorkerGlobals,
} from '../../src/adapters/shared/web-worker-host.ts';
import type { WebWorkerLike } from '../../src/adapters/shared/web-worker-host.ts';

/** Recording fake for the web `Worker` constructor. */
class FakeWebWorker implements WebWorkerLike {
  static instances: FakeWebWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly specifier: string, readonly options: { type: 'module' }) {
    FakeWebWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function makeHost(concurrency?: number) {
  FakeWebWorker.instances = [];
  return createWebWorkerHost({
    Worker: FakeWebWorker,
    ...(concurrency !== undefined ? { hardwareConcurrency: concurrency } : {}),
  });
}

describe('createWebWorkerHost', () => {
  it('should spawn a module worker with the given specifier', () => {
    const host = makeHost(4);
    host.spawn('file:///tasks/echo.ts');
    expect(FakeWebWorker.instances).toHaveLength(1);
    expect(FakeWebWorker.instances[0].specifier).toBe('file:///tasks/echo.ts');
    expect(FakeWebWorker.instances[0].options).toEqual({ type: 'module' });
  });

  it('should throw a clear error when the runtime has no Worker constructor', () => {
    const host = createWebWorkerHost({});
    expect(() => host.spawn('file:///x.ts')).toThrow('Web Worker API is not available');
  });

  it('should forward postMessage to the worker', () => {
    const host = makeHost(1);
    const handle = host.spawn('file:///x.ts');
    handle.postMessage({ hello: true });
    expect(FakeWebWorker.instances[0].posted).toEqual([{ hello: true }]);
  });

  it('should unwrap MessageEvent.data for onMessage listeners', () => {
    const host = makeHost(1);
    const handle = host.spawn('file:///x.ts');
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));
    FakeWebWorker.instances[0].onmessage?.({ data: { n: 7 } });
    expect(received).toEqual([{ n: 7 }]);
  });

  it('should pass an Error through onError unchanged', () => {
    const host = makeHost(1);
    const handle = host.spawn('file:///x.ts');
    const received: Error[] = [];
    handle.onError((error) => received.push(error));
    const original = new Error('kaput');
    FakeWebWorker.instances[0].onerror?.(original);
    expect(received[0]).toBe(original);
  });

  it('should normalize an ErrorEvent-like object to an Error with its message', () => {
    const host = makeHost(1);
    const handle = host.spawn('file:///x.ts');
    const received: Error[] = [];
    handle.onError((error) => received.push(error));
    FakeWebWorker.instances[0].onerror?.({ message: 'eval failed' });
    expect(received[0]).toBeInstanceOf(Error);
    expect(received[0].message).toBe('eval failed');
  });

  it('should normalize an event without a message to a generic Error', () => {
    const host = makeHost(1);
    const handle = host.spawn('file:///x.ts');
    const received: Error[] = [];
    handle.onError((error) => received.push(error));
    FakeWebWorker.instances[0].onerror?.(undefined);
    expect(received[0].message).toBe('Worker error');
  });

  it('should resolve terminate() after terminating the worker', async () => {
    const host = makeHost(1);
    const handle = host.spawn('file:///x.ts');
    await handle.terminate();
    expect(FakeWebWorker.instances[0].terminated).toBe(true);
  });

  it('should report the injected hardware concurrency', () => {
    expect(makeHost(8).availableParallelism()).toBe(8);
  });

  it('should fall back to 1 when hardware concurrency is unknown', () => {
    expect(makeHost().availableParallelism()).toBe(1);
  });

  it('should default to the real globals and report at least 1', () => {
    const host = createWebWorkerHost();
    expect(host.availableParallelism()).toBeGreaterThanOrEqual(1);
  });
});

describe('readWebWorkerGlobals', () => {
  it('should pick up Worker and hardwareConcurrency when present', () => {
    const globals = readWebWorkerGlobals({
      Worker: FakeWebWorker,
      navigator: { hardwareConcurrency: 6 },
    });
    expect(globals.Worker).toBe(FakeWebWorker);
    expect(globals.hardwareConcurrency).toBe(6);
  });

  it('should omit members absent from the scope', () => {
    const globals = readWebWorkerGlobals({});
    expect('Worker' in globals).toBe(false);
    expect('hardwareConcurrency' in globals).toBe(false);
  });

  it('should omit hardwareConcurrency when navigator does not report it', () => {
    const globals = readWebWorkerGlobals({ Worker: FakeWebWorker, navigator: {} });
    expect(globals.Worker).toBe(FakeWebWorker);
    expect('hardwareConcurrency' in globals).toBe(false);
  });

  it('should read the real globalThis by default (Deno has both members)', () => {
    const globals = readWebWorkerGlobals();
    expect(globals.Worker).toBeDefined();
  });
});
