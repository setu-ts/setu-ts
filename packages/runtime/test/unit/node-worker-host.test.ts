/**
 * Unit tests for the node worker host (`node:worker_threads` normalization),
 * driven through the injectable {@linkcode NodeWorkerModules} seam.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createNodeWorkerHost } from '../../src/adapters/node/node-worker-host.ts';
import type { NodeWorkerLike } from '../../src/adapters/node/node-worker-host.ts';

/** Recording fake for the `worker_threads.Worker` constructor. */
class FakeNodeWorker implements NodeWorkerLike {
  static instances: FakeNodeWorker[] = [];
  readonly posted: unknown[] = [];
  readonly listeners = new Map<string, (arg: unknown) => void>();
  terminated = false;

  constructor(readonly specifier: string | URL) {
    FakeNodeWorker.instances.push(this);
  }

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  on(event: 'message' | 'error', listener: (arg: unknown) => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

function makeHost(parallelism = 2) {
  FakeNodeWorker.instances = [];
  return createNodeWorkerHost({
    Worker: FakeNodeWorker,
    availableParallelism: () => parallelism,
  });
}

describe('createNodeWorkerHost', () => {
  it('should pass file: specifiers to the constructor as URL instances', () => {
    const host = makeHost();
    host.spawn('file:///tasks/echo.ts');
    expect(FakeNodeWorker.instances[0].specifier).toBeInstanceOf(URL);
    expect(String(FakeNodeWorker.instances[0].specifier)).toBe('file:///tasks/echo.ts');
  });

  it('should pass non-file specifiers through as strings', () => {
    const host = makeHost();
    host.spawn('./tasks/echo.js');
    expect(FakeNodeWorker.instances[0].specifier).toBe('./tasks/echo.js');
  });

  it('should forward postMessage to the worker', () => {
    const host = makeHost();
    const handle = host.spawn('./x.js');
    handle.postMessage({ n: 1 });
    expect(FakeNodeWorker.instances[0].posted).toEqual([{ n: 1 }]);
  });

  it('should deliver message payloads unwrapped to onMessage listeners', () => {
    const host = makeHost();
    const handle = host.spawn('./x.js');
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));
    FakeNodeWorker.instances[0].listeners.get('message')?.({ n: 9 });
    expect(received).toEqual([{ n: 9 }]);
  });

  it('should pass Error instances through onError unchanged', () => {
    const host = makeHost();
    const handle = host.spawn('./x.js');
    const received: Error[] = [];
    handle.onError((error) => received.push(error));
    const original = new Error('thread died');
    FakeNodeWorker.instances[0].listeners.get('error')?.(original);
    expect(received[0]).toBe(original);
  });

  it('should wrap non-Error error payloads in an Error', () => {
    const host = makeHost();
    const handle = host.spawn('./x.js');
    const received: Error[] = [];
    handle.onError((error) => received.push(error));
    FakeNodeWorker.instances[0].listeners.get('error')?.('string failure');
    expect(received[0]).toBeInstanceOf(Error);
    expect(received[0].message).toBe('string failure');
  });

  it('should normalize terminate() to Promise<void>', async () => {
    const host = makeHost();
    const handle = host.spawn('./x.js');
    const result = await handle.terminate();
    expect(result).toBeUndefined();
    expect(FakeNodeWorker.instances[0].terminated).toBe(true);
  });

  it('should delegate availableParallelism to the injected os function', () => {
    expect(makeHost(12).availableParallelism()).toBe(12);
  });

  it('should default to the real node:worker_threads and node:os modules', () => {
    const host = createNodeWorkerHost();
    expect(host.availableParallelism()).toBeGreaterThanOrEqual(1);
  });
});
