/**
 * Unit tests asserting each runtime adapter wires (or omits) the
 * `IRuntimeServices.workers` host correctly.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IWorkerHandle, IWorkerHost } from '@hono-enterprise/common';
import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';
import type { DenoHost } from '../../src/adapters/deno/deno-runtime.ts';
import { createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';
import type { BunHost } from '../../src/adapters/bun/bun-runtime.ts';
import { createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import type { NodeHost } from '../../src/adapters/node/node-runtime.ts';
import { createCloudflareRuntimeServices } from '../../src/adapters/workers/cf-runtime.ts';

/** Worker host fake recording spawn calls. */
function fakeWorkerHost(): IWorkerHost & { spawned: string[] } {
  const spawned: string[] = [];
  const handle: IWorkerHandle = {
    postMessage: () => undefined,
    onMessage: () => undefined,
    onError: () => undefined,
    terminate: () => Promise.resolve(),
  };
  return {
    spawned,
    spawn: (specifier: string) => {
      spawned.push(specifier);
      return handle;
    },
    availableParallelism: () => 3,
  };
}

const fakeDenoHost: DenoHost = {
  version: { deno: '2.0.0' },
  hostname: () => 'test-host',
  env: { toObject: () => ({}) },
  exit: () => {
    throw new Error('exit');
  },
  readFile: () => Promise.resolve(new Uint8Array()),
  realPath: (path: string) => Promise.resolve(path),
  writeFile: () => Promise.resolve(),
  stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0, mtime: null }),
  readdir: () => [],
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

const fakeBunHost: BunHost = {
  version: '1.1.0',
  hostname: 'test-host',
  env: {},
  exit: () => {
    throw new Error('exit');
  },
  readFile: () => new Uint8Array(),
  realPath: (path: string) => path,
  writeFile: () => undefined,
  stat: () => ({ isFile: true, isDirectory: false, size: 0, mtime: new Date() }),
  readdir: () => [],
  mkdir: () => true,
  rm: () => true,
};

const fakeNodeHost: NodeHost = {
  nodeVersion: 'v22.0.0',
  hostname: 'test-host',
  env: {},
  exit: () => {
    throw new Error('exit');
  },
  readFile: () => Promise.resolve(new Uint8Array()),
  realPath: (path: string) => Promise.resolve(path),
  writeFile: () => Promise.resolve(),
  stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0, mtime: new Date() }),
  readdir: () => Promise.resolve([]),
  mkdir: () => Promise.resolve(),
  rm: () => Promise.resolve(),
};

describe('runtime adapters — workers wiring', () => {
  it('should expose the injected worker host on the Deno adapter', () => {
    const workers = fakeWorkerHost();
    const services = createDenoRuntimeServices(fakeDenoHost, workers);
    expect(services.workers).toBeDefined();
    services.workers?.spawn('file:///t.ts');
    expect(workers.spawned).toEqual(['file:///t.ts']);
    expect(services.workers?.availableParallelism()).toBe(3);
  });

  it('should default the Deno adapter to a web worker host', () => {
    const services = createDenoRuntimeServices(fakeDenoHost);
    expect(services.workers).toBeDefined();
    expect(services.workers?.availableParallelism()).toBeGreaterThanOrEqual(1);
  });

  it('should expose the injected worker host on the Bun adapter', () => {
    const workers = fakeWorkerHost();
    const services = createBunRuntimeServices(fakeBunHost, workers);
    services.workers?.spawn('file:///t.ts');
    expect(workers.spawned).toEqual(['file:///t.ts']);
  });

  it('should expose the injected worker host on the Node adapter', () => {
    const workers = fakeWorkerHost();
    const services = createNodeRuntimeServices(fakeNodeHost, workers);
    services.workers?.spawn('file:///t.ts');
    expect(workers.spawned).toEqual(['file:///t.ts']);
  });

  it('should default the Node adapter to the node worker host', () => {
    const services = createNodeRuntimeServices(fakeNodeHost);
    expect(services.workers).toBeDefined();
    expect(services.workers?.availableParallelism()).toBeGreaterThanOrEqual(1);
  });

  it('should leave workers ABSENT on the Cloudflare adapter', () => {
    const services = createCloudflareRuntimeServices();
    expect(services.workers).toBeUndefined();
    expect('workers' in services).toBe(false);
  });
});
