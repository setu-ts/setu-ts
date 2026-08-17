/**
 * Unit tests for the WorkerPoolPlugin factory: metadata, service
 * registration, health indicator, and onClose shutdown — driven with the
 * fake plugin context.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ICounter, IMetricsService, IWorkerPool, MetricOptions } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

import { WorkerPoolPlugin } from '../../src/index.ts';
import {
  REASON_LABEL,
  TASK_MODULE_LABEL,
  WORKER_POOL_METRICS,
} from '../../src/metrics/metric-names.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { RecordingMetrics } from '../fixtures/metrics-fakes.ts';
import manifest from '../../deno.json' with { type: 'json' };

describe('WorkerPoolPlugin — metadata', () => {
  it('should declare name, version, provides, and priority', () => {
    const plugin = WorkerPoolPlugin();
    expect(plugin.name).toBe('worker-pool-plugin');
    expect(plugin.version).toBe(manifest.version);
    expect(plugin.provides).toEqual([CAPABILITIES.WORKER_POOL]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });

  it('should declare metrics as an optional dependency, which is what orders it', () => {
    const plugin = WorkerPoolPlugin();
    // Not cosmetic: the resolver turns an optional token whose provider EXISTS
    // into a real dependency edge, so this is what guarantees MetricsPlugin's
    // register() runs first and the instruments exist before any pool pushes.
    expect(plugin.optionalDependencies).toEqual(['logger', CAPABILITIES.METRICS]);
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

describe('WorkerPoolPlugin — optional metrics wiring', () => {
  it('should create the instruments when the metrics capability is registered', () => {
    const host = new FakeHost();
    const metrics = new RecordingMetrics();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    fake.registered.set(CAPABILITIES.METRICS, metrics);

    WorkerPoolPlugin({ host }).register(fake.ctx);

    // Eagerly, at register() — before any task has run.
    expect([...metrics.metrics.keys()]).toHaveLength(6);
  });

  it('should touch no metrics at all when the capability is absent', async () => {
    const host = new FakeHost();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    expect(fake.ctx.services.has(CAPABILITIES.METRICS)).toBe(false);

    WorkerPoolPlugin({ host }).register(fake.ctx);
    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;

    // A full lifecycle with no collector must behave exactly as M45's did.
    const promise = pool.run('file:///t.ts', 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');
    expect(pool.stats()[0]).toMatchObject({ completed: 1, failed: 0 });
  });

  it('should push a pool run through to the instruments once wired', async () => {
    const host = new FakeHost();
    const metrics = new RecordingMetrics();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    fake.registered.set(CAPABILITIES.METRICS, metrics);
    WorkerPoolPlugin({ host }).register(fake.ctx);

    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;
    const promise = pool.run('file:///t.ts', 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');

    expect(
      metrics.require(WORKER_POOL_METRICS.COMPLETED)
        .valueFor({ [TASK_MODULE_LABEL]: 'file:///t.ts' }),
    ).toBe(1);
  });

  it('should report a failed instrument write through ctx.logger', async () => {
    const host = new FakeHost();
    const base = new RecordingMetrics();
    // Delegated explicitly rather than spread: `RecordingMetrics` is a class,
    // so `{ ...base }` would copy its fields and DROP every prototype method.
    const metrics: IMetricsService = {
      counter: (name: string, options?: MetricOptions): ICounter => {
        const real = base.counter(name, options);
        if (name !== WORKER_POOL_METRICS.COMPLETED) {
          return real;
        }
        const boom = (): never => {
          throw new Error('metrics backend down');
        };
        return { name, type: 'counter', help: name, inc: boom, observe: boom };
      },
      gauge: (name, options) => base.gauge(name, options),
      histogram: (name, options) => base.histogram(name, options),
      summary: (name, options) => base.summary(name, options),
      get: (name) => base.get(name),
    };

    const fake = createFakeContext(createFakeRuntime(new FakeTimers(), host));
    fake.registered.set(CAPABILITIES.METRICS, metrics);
    WorkerPoolPlugin({ host }).register(fake.ctx);

    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;
    const promise = pool.run('file:///t.ts', 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');

    // The task is unaffected; the failure surfaces on the logger instead.
    await expect(promise).resolves.toBe('done');
    expect(fake.logged).toHaveLength(1);
    expect(fake.logged[0].message).toContain('metrics write failed');
    expect(fake.logged[0].metadata).toEqual({ error: 'metrics backend down' });
  });

  it('should report a rejection when the runtime provides no worker host', async () => {
    const metrics = new RecordingMetrics();
    const fake = createFakeContext(createFakeRuntime(new FakeTimers()));
    fake.registered.set(CAPABILITIES.METRICS, metrics);
    WorkerPoolPlugin().register(fake.ctx);

    const pool = fake.registered.get(CAPABILITIES.WORKER_POOL) as IWorkerPool;
    await expect(pool.run('file:///t.ts', 1)).rejects.toThrow();

    // No pool exists on a thread-less runtime, so this counter is the only
    // signal that work was attempted at all.
    expect(
      metrics.require(WORKER_POOL_METRICS.REJECTED).valueFor({
        [TASK_MODULE_LABEL]: 'file:///t.ts',
        [REASON_LABEL]: 'unavailable',
      }),
    ).toBe(1);
  });
});
