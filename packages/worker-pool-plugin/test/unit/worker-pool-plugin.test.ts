/**
 * Unit tests for the WorkerPoolPlugin factory: metadata, service
 * registration, health indicator, and onClose shutdown — driven with the
 * fake plugin context.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IWorkerPool } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { WorkerPoolPlugin } from '../../src/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';

describe('WorkerPoolPlugin — metadata', () => {
  it('should declare name, version, provides, and priority', () => {
    const plugin = WorkerPoolPlugin();
    expect(plugin.name).toBe('worker-pool-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual([CAPABILITIES.WORKER_POOL]);
    expect(plugin.optionalDependencies).toEqual(['logger']);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });
});

describe('WorkerPoolPlugin — register', () => {
  it('should register the service under CAPABILITIES.WORKER_POOL', () => {
    const host = new FakeHost();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    WorkerPoolPlugin({ host }).register(fake.ctx);
    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;
    expect(pool).toBeDefined();
    expect(typeof pool.run).toBe('function');
  });

  it('should report an available, up health indicator with pool stats', async () => {
    const host = new FakeHost();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    WorkerPoolPlugin().register(fake.ctx);

    const indicator = fake.healthIndicators.get('worker-pool');
    expect(indicator).toBeDefined();
    const result = await indicator?.();
    expect(result?.status).toBe('up');
    expect(result?.data).toEqual({ available: true, pools: [] });

    // Stats appear once a pool exists.
    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;
    void pool.run('file:///t.ts', 1).catch(() => undefined);
    const after = await indicator?.();
    expect((after?.data as { pools: unknown[] }).pools).toHaveLength(1);
  });

  it('should report available:false on a runtime without workers', async () => {
    const fake = createFakeContext(createFakeRuntime(new FakeTimers()));
    WorkerPoolPlugin().register(fake.ctx);
    const result = await fake.healthIndicators.get('worker-pool')?.();
    expect(result?.status).toBe('up');
    expect(result?.data).toEqual({ available: false, pools: [] });
  });

  it('should shut the service down via the onClose handler', async () => {
    const host = new FakeHost();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    WorkerPoolPlugin({ host }).register(fake.ctx);

    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;
    const pending = pool.run('file:///t.ts', 1);
    host.handles[0].emitReady();

    expect(fake.onCloseHandlers).toHaveLength(1);
    await fake.onCloseHandlers[0]();
    expect(host.handles[0].terminated).toBe(true);
    await expect(pending).rejects.toThrow('shut down');
  });
});
