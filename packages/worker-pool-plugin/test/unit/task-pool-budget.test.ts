import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IWorkerHost } from '@setu-ts/common';
import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerBudget } from '../../src/pool/worker-budget.ts';
import { WorkerTaskTimeoutError } from '../../src/errors.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { WorkerPoolCollector } from '../../src/metrics/worker-pool-collector.ts';
import { WORKER_POOL_METRICS } from '../../src/metrics/metric-names.ts';
import { RecordingMetrics, throwOnReport } from '../fixtures/metrics-fakes.ts';

function setup(limit = 1, host = new FakeHost(2, undefined, true)) {
  const budget = new WorkerBudget(limit);
  const timers = new FakeTimers();
  const runtime = createFakeRuntime(timers);
  const metrics = new RecordingMetrics();
  const collector = new WorkerPoolCollector(metrics, throwOnReport);
  const make = (specifier: string, size = 2, injected: IWorkerHost = host) =>
    new TaskPool(
      { specifier, size, maxQueue: 100, taskTimeoutMs: 0 },
      injected,
      runtime,
      budget,
      collector,
    );
  return { budget, timers, host, metrics, make, a: make('a'), b: make('b') };
}

describe('TaskPool shared budget', () => {
  it('evicts another idle worker, transfers asynchronously, and syncs its gauge', async () => {
    const { a, b, host, metrics } = setup();
    const first = a.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk(1);
    await first;
    const second = b.run(2);
    expect(host.handles[0].terminated).toBe(true);
    expect(a.stats().workers).toBe(0);
    expect(metrics.require(WORKER_POOL_METRICS.WORKERS).valueFor({ task_module: 'a' })).toBe(0);
    expect(host.handles).toHaveLength(1);
    await Promise.resolve();
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk(2);
    await second;
    await a.shutdown();
    await b.shutdown();
  });

  it('hands an idle settled slot to a waiting module', async () => {
    const { a, b, host } = setup();
    const first = a.run(1);
    host.handles[0].emitReady();
    const second = b.run(2);
    expect(host.handles).toHaveLength(1);
    host.handles[0].replyOk(1);
    await first;
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk(2);
    await second;
    await a.shutdown();
    await b.shutdown();
  });

  it('serves a starved module before the last task and retiring pool does not regain its slot', async () => {
    const { a, b, host } = setup();
    const first = a.run(1);
    const last = a.run(3);
    host.handles[0].emitReady();
    const middle = b.run(2);
    host.handles[0].replyOk(1);
    expect(a.stats()).toMatchObject({ workers: 0, queued: 1 });
    expect(host.handles).toHaveLength(1);
    await Promise.resolve();
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk(2);
    await middle;
    expect(host.spawnedSpecifiers).toEqual(['a', 'b', 'a']);
    host.handles[2].emitReady();
    host.handles[2].replyOk(3);
    await Promise.all([first, last]);
    await a.shutdown();
    await b.shutdown();
  });

  it('does not preempt for a waiter that already owns a starting slot', async () => {
    const { a, b, host } = setup(2);
    const first = a.run(1);
    host.handles[0].emitReady();
    const second = b.run(2);
    const third = b.run(3);
    const fourth = a.run(4);
    host.handles[0].replyOk(1);
    expect(host.handles[0].terminated).toBe(false);
    expect(host.handles[0].requests.map((request) => request.input)).toEqual([1, 4]);
    host.handles[0].replyOk(4);
    await Promise.resolve();
    // Rule 1 does give the now-idle slot to the non-starved waiter.
    expect(host.spawnedSpecifiers).toEqual(['a', 'b', 'b']);
    host.handles[1].emitReady();
    host.handles[2].emitReady();
    host.handles[1].replyOk(2);
    host.handles[2].replyOk(3);
    await Promise.all([first, second, third, fourth]);
    await a.shutdown();
    await b.shutdown();
  });

  it('hands over a slot made idle by a clone failure at readiness', async () => {
    const host = new FakeHost(2, (request) => {
      if (request.input === 'poison') throw new DOMException('cannot clone', 'DataCloneError');
    });
    const { a, b } = setup(1, host);
    const rejected = a.run('poison');
    const waiting = b.run('good');
    host.handles[0].emitReady();
    await expect(rejected).rejects.toThrow('cannot clone');
    expect(host.handles[0].terminated).toBe(true);
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk('good');
    await waiting;
    await a.shutdown();
    await b.shutdown();
  });

  it('hands over a redundant starting worker when it becomes ready', async () => {
    const { a, b, host } = setup(2);
    const first = a.run(1);
    const second = a.run(2);
    host.handles[0].emitReady();
    host.handles[0].replyOk(1);
    host.handles[0].replyOk(2);
    await Promise.all([first, second]);
    const third = b.run(3);
    const fourth = b.run(4);
    // B evicts A's ready slot; A's other slot is still loading.
    host.handles[1].emitReady();
    expect(host.handles[1].terminated).toBe(true);
    await Promise.resolve();
    expect(host.spawnedSpecifiers).toEqual(['a', 'a', 'b', 'b']);
    host.handles[2].emitReady();
    host.handles[3].emitReady();
    host.handles[2].replyOk(3);
    host.handles[3].replyOk(4);
    await Promise.all([third, fourth]);
    await a.shutdown();
    await b.shutdown();
  });

  it('hands over a clone-failed slot from run without an onMessage transition', async () => {
    // Structured cloning can invoke input getters synchronously. This host
    // reproduces a getter queuing another module before cloning then fails.
    let waiting: Promise<unknown> | undefined;
    const host = new FakeHost(2, (request) => {
      if (request.input === 'poison') {
        waiting = b.run('other');
        throw new DOMException('getter could not clone', 'DataCloneError');
      }
    });
    const { a, b } = setup(1, host);
    const warm = a.run('warm');
    host.handles[0].emitReady();
    host.handles[0].replyOk('warm');
    await warm;
    const failed = a.run('poison');
    expect(host.handles[0].terminated).toBe(true);
    await expect(failed).rejects.toThrow('getter could not clone');
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk('other');
    await waiting;
    await a.shutdown();
    await b.shutdown();
  });

  for (const cause of ['crash', 'exit', 'timeout'] as const) {
    it(`releases budget exactly once after ${cause}`, async () => {
      const { a, b, host, timers } = setup();
      const first = a.run(1, cause === 'timeout' ? 10 : 0);
      const assertion = expect(first).rejects.toThrow();
      host.handles[0].emitReady();
      const waiting = b.run(2);
      if (cause === 'crash') {
        host.handles[0].emitWorkerError(new Error('crashed'));
        host.handles[0].emitExit(1);
      } else if (cause === 'exit') host.handles[0].emitExit(1);
      else timers.fire();
      await assertion;
      expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
      host.handles[1].emitReady();
      host.handles[1].replyOk(2);
      await waiting;
      await a.shutdown();
      await b.shutdown();
    });
  }

  it('retains budget on clone failure and cancels a task timed out waiting for budget', async () => {
    const host = new FakeHost(2, () => {
      throw new Error('clone');
    });
    const { a, b, budget, timers } = setup(1, host);
    const rejected = a.run(1);
    host.handles[0].emitReady();
    await expect(rejected).rejects.toThrow('clone');
    expect(a.stats().workers).toBe(1);
    // Make the retained worker busy using a separate, healthy host scenario.
    await a.shutdown();
    const owner = new FakeHost();
    const active = new TaskPool(
      { specifier: 'owner', size: 1, maxQueue: 10, taskTimeoutMs: 0 },
      owner,
      createFakeRuntime(timers),
      budget,
    );
    const running = active.run(1);
    owner.handles[0].emitReady();
    const waiting = b.run(2, 10);
    expect(budget.hasWaiters()).toBe(true);
    timers.fire();
    await expect(waiting).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    expect(budget.hasWaiters()).toBe(false);
    owner.handles[0].replyOk(1);
    await running;
    await active.shutdown();
    await b.shutdown();
  });

  it('settles the oldest ghost task on spawn throw, clears its timer and holds no budget', async () => {
    const { make, timers, host } = setup();
    const error = new URIError('not a url');
    const failing = make('bad', 1, {
      spawn: () => {
        throw error;
      },
      availableParallelism: () => 1,
    });
    const failed = failing.run(1, 10);
    await expect(failed).rejects.toBe(error);
    expect(failing.stats()).toMatchObject({ workers: 0, queued: 0, failed: 1 });
    expect(timers.armed).toBe(0);
    timers.fire();
    expect(failing.stats().failed).toBe(1);
    const good = make('good');
    const next = good.run(2);
    expect(host.handles).toHaveLength(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk(2);
    await next;
    await failing.shutdown();
    await good.shutdown();
  });

  it('continues queued work after a transient hand-over spawn failure without another run', async () => {
    const { make, a, host, timers } = setup();
    const error = new Error('transient spawn failure');
    let attempts = 0;
    const recovering = make('recovering', 1, {
      spawn: (specifier) => {
        if (++attempts === 1) throw error;
        return host.spawn(specifier);
      },
      availableParallelism: () => 1,
    });
    const active = a.run('active');
    host.handles[0].emitReady();
    const failed = recovering.run('first');
    const assertion = expect(failed).rejects.toBe(error);
    const second = recovering.run('second');
    const third = recovering.run('third');
    host.handles[0].replyOk('active');
    await assertion;
    expect(attempts).toBe(2);
    expect(recovering.stats()).toMatchObject({ workers: 1, queued: 2, failed: 1 });
    host.handles[1].emitReady();
    host.handles[1].replyOk('second');
    host.handles[1].replyOk('third');
    await expect(second).resolves.toBe('second');
    await expect(third).resolves.toBe('third');
    await active;
    expect(host.handles[1].requests.map((request) => request.input)).toEqual(['second', 'third']);
    expect(recovering.stats()).toMatchObject({ completed: 2, queued: 0, failed: 1 });
    expect(timers.armed).toBe(0);
    await a.shutdown();
    await recovering.shutdown();
  });

  it('settles a backlog on repeated spawn failure without leaking timers or budget', async () => {
    const { make, a, host, timers, budget } = setup();
    const errors = [new URIError('first'), new URIError('second'), new URIError('third')];
    let attempts = 0;
    const failing = make('bad', 1, {
      spawn: () => {
        throw errors[attempts++];
      },
      availableParallelism: () => 1,
    });
    const active = a.run('active');
    host.handles[0].emitReady();
    const failed = [0, 1, 2].map((input) => failing.run(input, 10));
    const assertions = failed.map((task, index) => expect(task).rejects.toBe(errors[index]));
    host.handles[0].replyOk('active');
    await assertions[0];
    expect(attempts).toBe(3);
    await Promise.all(assertions);
    expect(failing.stats()).toMatchObject({ workers: 0, queued: 0, failed: 3 });
    expect(timers.armed).toBe(0);
    expect(budget.hasWaiters()).toBe(false);
    timers.fire();
    expect(failing.stats().failed).toBe(3);
    const good = make('good');
    const next = good.run('next');
    expect(host.spawnedSpecifiers).toEqual(['a', 'good']);
    host.handles[1].emitReady();
    host.handles[1].replyOk('next');
    await Promise.all([active, next]);
    await a.shutdown();
    await failing.shutdown();
    await good.shutdown();
  });

  it('returns a failed spawn reservation to the next waiter before retrying its backlog', async () => {
    const { make, a, host } = setup();
    let attempts = 0;
    const recovering = make('recovering', 1, {
      spawn: (specifier) => {
        if (++attempts === 1) throw new Error('transient spawn failure');
        return host.spawn(specifier);
      },
      availableParallelism: () => 1,
    });
    const other = make('other', 1);
    const active = a.run('active');
    host.handles[0].emitReady();
    const failed = recovering.run('first');
    const assertion = expect(failed).rejects.toThrow('transient spawn failure');
    const remaining = recovering.run('remaining');
    const waiting = other.run('waiting');
    host.handles[0].replyOk('active');
    await assertion;
    expect(host.spawnedSpecifiers).toEqual(['a', 'other']);
    expect(attempts).toBe(1);
    host.handles[1].emitReady();
    host.handles[1].replyOk('waiting');
    await waiting;
    expect(host.spawnedSpecifiers).toEqual(['a', 'other', 'recovering']);
    host.handles[2].emitReady();
    host.handles[2].replyOk('remaining');
    await Promise.all([active, remaining]);
    await a.shutdown();
    await other.shutdown();
    await recovering.shutdown();
  });

  it('handles a spawn throw in a hand-over continuation without an unhandled rejection', async () => {
    const { make, a, host, timers, budget } = setup();
    const failing = make('bad', 1, {
      spawn: () => {
        throw 'spawn refused';
      },
      availableParallelism: () => 1,
    });
    const first = a.run(1);
    host.handles[0].emitReady();
    const failed = failing.run(2, 10);
    const assertion = expect(failed).rejects.toThrow('spawn refused');
    host.handles[0].replyOk(1);
    await assertion;
    await first;
    expect(failing.stats()).toMatchObject({ queued: 0, failed: 1 });
    expect(budget.hasWaiters()).toBe(false);
    await a.shutdown();
    await failing.shutdown();
    // Shutdown also awaits the bounded termination of the retired owner.
    expect(timers.armed).toBe(0);
  });
});
