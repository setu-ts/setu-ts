/**
 * Unit tests for WorkerPoolService — host resolution, lazy pool creation,
 * option merging, unavailability behavior, stats aggregation, and shutdown.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { WorkerPoolService } from '../../src/services/worker-pool-service.ts';
import { WorkerPoolUnavailableError } from '../../src/errors.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';

const SPEC_A = 'file:///tasks/a.ts';
const SPEC_B = 'file:///tasks/b.ts';

describe('WorkerPoolService — host resolution', () => {
  it('should use the runtime workers host when no host option is given', () => {
    const runtimeHost = new FakeHost();
    const service = new WorkerPoolService(
      undefined,
      createFakeRuntime(new FakeTimers(), runtimeHost),
    );
    void service.run(SPEC_A, 1).catch(() => undefined);
    expect(runtimeHost.spawnedSpecifiers).toEqual([SPEC_A]);
  });

  it('should prefer an injected host over the runtime workers host', () => {
    const runtimeHost = new FakeHost();
    const injected = new FakeHost();
    const service = new WorkerPoolService(
      { host: injected },
      createFakeRuntime(new FakeTimers(), runtimeHost),
    );
    void service.run(SPEC_A, 1).catch(() => undefined);
    expect(injected.spawnedSpecifiers).toEqual([SPEC_A]);
    expect(runtimeHost.spawnedSpecifiers).toEqual([]);
  });
});

describe('WorkerPoolService — unavailable runtime', () => {
  it('should reject run() with WorkerPoolUnavailableError when no host exists', async () => {
    const service = new WorkerPoolService(undefined, createFakeRuntime(new FakeTimers()));
    await expect(service.run(SPEC_A, 1)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
  });

  it('should return empty stats and resolve shutdown when no host exists', async () => {
    const service = new WorkerPoolService(undefined, createFakeRuntime(new FakeTimers()));
    expect(service.stats()).toEqual([]);
    await service.shutdown();
  });
});

describe('WorkerPoolService — pools and option merging', () => {
  it('should create one pool per task module lazily and reuse it', async () => {
    const host = new FakeHost();
    const service = new WorkerPoolService({ host }, createFakeRuntime(new FakeTimers()));

    const first = service.run<number, string>(SPEC_A, 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('r1');
    await expect(first).resolves.toBe('r1');

    // Second run on the same module reuses the same pool (and idle worker).
    const second = service.run<number, string>(SPEC_A, 2);
    expect(host.handles).toHaveLength(1);
    host.handles[0].replyOk('r2');
    await expect(second).resolves.toBe('r2');

    // A different module gets its own pool and worker.
    void service.run(SPEC_B, 3).catch(() => undefined);
    expect(host.handles).toHaveLength(2);
    expect(host.spawnedSpecifiers).toEqual([SPEC_A, SPEC_B]);
  });

  it('should default the pool size to the host availableParallelism', () => {
    const host = new FakeHost(3);
    const service = new WorkerPoolService({ host }, createFakeRuntime(new FakeTimers()));
    for (let i = 0; i < 5; i++) {
      void service.run(SPEC_A, i).catch(() => undefined);
    }
    expect(host.handles).toHaveLength(3);
  });

  it('should apply NON-default global options (defaultPoolSize, taskTimeoutMs)', () => {
    const host = new FakeHost(8);
    const timers = new FakeTimers();
    const service = new WorkerPoolService(
      { host, defaultPoolSize: 1, taskTimeoutMs: 250 },
      createFakeRuntime(timers),
    );
    void service.run(SPEC_A, 1).catch(() => undefined);
    void service.run(SPEC_A, 2).catch(() => undefined);
    expect(host.handles).toHaveLength(1); // defaultPoolSize=1 beats parallelism 8
    host.handles[0].emitReady();
    expect(timers.armed).toBe(1); // taskTimeoutMs=250 armed a timer
  });

  it('should let per-module overrides beat the global options', async () => {
    const host = new FakeHost(8);
    const timers = new FakeTimers();
    const service = new WorkerPoolService(
      {
        host,
        defaultPoolSize: 4,
        maxQueue: 100,
        taskTimeoutMs: 250,
        pools: { [SPEC_A]: { size: 1, maxQueue: 1, taskTimeoutMs: 0 } },
      },
      createFakeRuntime(timers),
    );
    const active = service.run(SPEC_A, 'active');
    host.handles[0].emitReady();
    expect(host.handles).toHaveLength(1); // size override
    expect(timers.armed).toBe(0); // timeout override 0 disables

    const queued = service.run(SPEC_A, 'queued');
    // maxQueue override 1: a third concurrent task is shed.
    await expect(service.run(SPEC_A, 'overflow')).rejects.toMatchObject({ limit: 1 });

    host.handles[0].replyOk('r1');
    host.handles[0].replyOk('r2');
    await active;
    await queued;
  });

  it('should pass the per-call timeout override through to the pool', () => {
    const host = new FakeHost();
    const timers = new FakeTimers();
    const service = new WorkerPoolService(
      { host, taskTimeoutMs: 0 },
      createFakeRuntime(timers),
    );
    void service.run(SPEC_A, 1, { timeoutMs: 75 }).catch(() => undefined);
    host.handles[0].emitReady();
    expect(timers.armed).toBe(1);
  });
});

describe('WorkerPoolService — stats and shutdown', () => {
  it('should aggregate stats across pools', () => {
    const host = new FakeHost();
    const service = new WorkerPoolService({ host }, createFakeRuntime(new FakeTimers()));
    void service.run(SPEC_A, 1).catch(() => undefined);
    void service.run(SPEC_B, 2).catch(() => undefined);
    const stats = service.stats();
    expect(stats.map((s) => s.taskModule).sort()).toEqual([SPEC_A, SPEC_B]);
    expect(stats.every((s) => s.workers === 1)).toBe(true);
  });

  it('should shut down every pool', async () => {
    const host = new FakeHost();
    const service = new WorkerPoolService({ host }, createFakeRuntime(new FakeTimers()));
    const a = service.run(SPEC_A, 1);
    const b = service.run(SPEC_B, 2);
    await service.shutdown();
    await expect(a).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    await expect(b).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(host.handles.every((h) => h.terminated)).toBe(true);
  });
});
