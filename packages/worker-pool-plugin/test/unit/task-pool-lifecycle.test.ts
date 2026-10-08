import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerBudget } from '../../src/pool/worker-budget.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';

function setup(size = 1) {
  const timers = new FakeTimers();
  const host = new FakeHost(2, undefined, true);
  const budget = new WorkerBudget(size);
  const make = (specifier: string) =>
    new TaskPool(
      { specifier, size, maxQueue: 10, taskTimeoutMs: 0 },
      host,
      createFakeRuntime(timers),
      budget,
    );
  return { timers, host, make, a: make('a'), b: make('b') };
}

async function drain() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('TaskPool security lifecycle regressions', () => {
  it('reclaims a non-ready slot on task expiry and serves another module', async () => {
    const { timers, host, a, b } = setup();
    const failed = expect(a.run(1, 10)).rejects.toThrow('timed out');
    const good = b.run(2);
    timers.fire();
    await failed;
    expect(a.stats()).toMatchObject({ workers: 0, queued: 0, failed: 1 });
    expect(host.handles[0].terminated).toBe(true);
    await drain();
    host.handles[1].emitReady();
    host.handles[1].replyOk(2);
    await expect(good).resolves.toBe(2);
    await Promise.all([a.shutdown(), b.shutdown()]);
    expect(timers.armed).toBe(0);
  });

  it('reclaims only starting capacity no longer needed by the pending queue', async () => {
    const { timers, host, a } = setup(2);
    const failed = expect(a.run(1, 10)).rejects.toThrow();
    const kept = a.run(2);
    timers.fire();
    await failed;
    expect(a.stats()).toMatchObject({ workers: 1, queued: 1 });
    const live = host.handles.find((handle) => !handle.terminated)!;
    live.emitReady();
    live.replyOk(2);
    await kept;
    await a.shutdown();
  });

  for (const mode of ['throw', 'reject'] as const) {
    it(`contains termination ${mode} during idle eviction and in-flight timeout`, async () => {
      const { timers, host, a, b } = setup();
      const first = a.run(1);
      host.handles[0].emitReady();
      host.handles[0].replyOk(1);
      await first;
      host.handles[0].terminate = () => {
        if (mode === 'throw') throw new Error('termination failure');
        return Promise.reject(new Error('termination failure'));
      };
      const second = b.run(2);
      await drain();
      host.handles[1].emitReady();
      host.handles[1].replyOk(2);
      await expect(second).resolves.toBe(2);
      host.handles[1].terminate = host.handles[0].terminate;
      const timed = expect(b.run(3, 10)).rejects.toThrow('timed out');
      timers.fire();
      await timed;
      await Promise.all([a.shutdown(), b.shutdown()]);
      expect(timers.armed).toBe(0);
    });
  }

  for (const retired of [false, true]) {
    it(`bounds never-resolving termination at shutdown (retired=${retired})`, async () => {
      const { timers, host, a, b } = setup();
      const first = a.run(1);
      host.handles[0].emitReady();
      host.handles[0].replyOk(1);
      await first;
      host.handles[0].terminate = () => new Promise<void>(() => {});
      if (retired) {
        const second = b.run(2);
        await drain();
        host.handles[1].emitReady();
        host.handles[1].replyOk(2);
        await second;
      }
      let settled = false;
      const stopping = Promise.all([a.shutdown(), b.shutdown()]).then(() => {
        settled = true;
      });
      await drain();
      expect(settled).toBe(false);
      timers.fire();
      await drain();
      expect(settled).toBe(true);
      await stopping;
      expect(timers.armed).toBe(0);
      expect(a.stats().workers + b.stats().workers).toBe(0);
    });
  }

  it('ignores duplicate startup errors and late callbacks from a dropped slot', async () => {
    const { host, a } = setup();
    const first = expect(a.run(1)).rejects.toThrow('first');
    const second = a.run(2).then((result) => ({ result }), (error: Error) => ({ error }));
    host.handles[0].emitWorkerError(new Error('first'));
    host.handles[0].emitWorkerError(new Error('duplicate'));
    host.handles[0].emitReady();
    host.handles[0].emitExit(1);
    await first;
    expect(a.stats()).toMatchObject({ failed: 1, queued: 1, workers: 1 });
    host.handles[1].emitReady();
    host.handles[1].replyOk(2);
    await expect(second).resolves.toEqual({ result: 2 });
    await a.shutdown();
    host.handles[1].emitReady();
    host.handles[1].emitWorkerError(new Error('after stop'));
    expect(a.stats()).toMatchObject({ failed: 1, completed: 1, workers: 0 });
  });
});
