/**
 * Startup deadline, starving-module yield, and listener-registration failure —
 * the three ways a slot used to be held with nothing able to release it (M45c
 * security audit findings 1, 2 and 5).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IWorkerHandle, IWorkerHost } from '@setu-ts/common';
import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerBudget } from '../../src/pool/worker-budget.ts';
import { WorkerTaskError } from '../../src/errors.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';

const STARTUP_MS = 60_000;

function setup(limit = 1) {
  const budget = new WorkerBudget(limit);
  const timers = new FakeTimers();
  const runtime = createFakeRuntime(timers);
  const host = new FakeHost(2);
  const make = (specifier: string, taskTimeoutMs = 0, injected: IWorkerHost = host) =>
    new TaskPool(
      { specifier, size: 2, maxQueue: 100, taskTimeoutMs, startupTimeoutMs: STARTUP_MS },
      injected,
      runtime,
      budget,
    );
  return { budget, timers, host, make };
}

/** Lets the budget's deferred hand-over continuation run. */
const tick = () => Promise.resolve();

describe('TaskPool startup deadline', () => {
  it('fails the oldest task and hands the slot on when a worker never signals ready', async () => {
    const { timers, host, make } = setup();
    const a = make('a'); // taskTimeoutMs: 0 — nothing else would ever reclaim this slot
    const b = make('b');
    const stuck = a.run('never');
    const waiting = b.run('b');
    expect(host.spawnedSpecifiers).toEqual(['a']);

    timers.fire(Infinity);
    await expect(stuck).rejects.toBeInstanceOf(WorkerTaskError);
    await expect(stuck).rejects.toMatchObject({ remoteName: 'WorkerStartupTimeout' });
    expect(host.handles[0].terminated).toBe(true);
    expect(a.stats()).toMatchObject({ workers: 0, queued: 0, failed: 1 });

    await tick();
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk('done');
    await expect(waiting).resolves.toBe('done');
    await a.shutdown();
    await b.shutdown();
  });

  it('clears the deadline once the worker signals ready', async () => {
    const { timers, host, make } = setup();
    const a = make('a');
    const task = a.run(1);
    expect(timers.armed).toBe(1);
    host.handles[0].emitReady();
    expect(timers.armed).toBe(0);
    timers.fire(Infinity);
    host.handles[0].replyOk('ok');
    await expect(task).resolves.toBe('ok');
    expect(host.handles[0].terminated).toBe(false);
    await a.shutdown();
  });

  it('clears the deadline when the pool shuts down while a worker is starting', async () => {
    const { timers, make } = setup();
    const a = make('a');
    const task = a.run(1).catch((error: Error) => error.name);
    await a.shutdown();
    expect(timers.armed).toBe(0);
    await expect(task).resolves.toBe('WorkerPoolUnavailableError');
  });

  it('ignores a deadline firing for a worker that already became ready', async () => {
    const { timers, host, make } = setup();
    const a = make('a');
    const task = a.run(1);
    host.handles[0].emitReady();
    timers.fire(Infinity); // nothing armed; an already-ready slot is left alone
    expect(a.stats().workers).toBe(1);
    host.handles[0].replyOk('ok');
    await expect(task).resolves.toBe('ok');
    await a.shutdown();
  });
});

describe('TaskPool yields a starting worker to a starved module', () => {
  it('a never-ready module with steady demand releases its slot on each task expiry', async () => {
    const { timers, host, make } = setup();
    const a = make('a', 100);
    const b = make('b');
    const first = a.run(1).catch((error: Error) => error.name);
    // Untimed, so demand for A stays queued after the first task expires: the
    // old rule kept one starting worker per queued task and never yielded.
    const second = a.run(2, 0).catch((error: Error) => error.name);
    const waiting = b.run('b');
    expect(host.spawnedSpecifiers).toEqual(['a']);

    timers.fire(); // task timeouts only; the startup deadline (60 s) does not fire
    await expect(first).resolves.toBe('WorkerTaskTimeoutError');
    expect(host.handles[0].terminated).toBe(true);
    expect(a.stats()).toMatchObject({ workers: 0, queued: 1 });

    await tick();
    expect(host.spawnedSpecifiers).toEqual(['a', 'b']);
    host.handles[1].emitReady();
    host.handles[1].replyOk('served');
    await expect(waiting).resolves.toBe('served');
    await a.shutdown();
    await expect(second).resolves.toBe('WorkerPoolUnavailableError');
    await b.shutdown();
  });

  it('keeps its starting worker when no other module is starved', async () => {
    const { timers, host, make } = setup(2);
    const a = make('a', 100);
    const first = a.run(1).catch((error: Error) => error.name);
    const later = a.run(2, 0); // still queued after the first expires
    timers.fire();
    await expect(first).resolves.toBe('WorkerTaskTimeoutError');
    expect(host.handles.filter((handle) => !handle.terminated)).toHaveLength(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('kept');
    await expect(later).resolves.toBe('kept');
    await a.shutdown();
  });
});

describe('TaskPool listener registration failure', () => {
  it('charges no slot and terminates the handle when registration throws', async () => {
    const { host, make } = setup();
    let terminated = 0;
    const brokenHost: IWorkerHost = {
      spawn: (): IWorkerHandle => ({
        postMessage: () => {},
        onMessage: () => {
          throw new Error('listener-registration-failed');
        },
        onError: () => {},
        terminate: () => {
          terminated++;
          return Promise.resolve();
        },
      }),
      availableParallelism: () => 2,
    };
    const broken = make('broken', 0, brokenHost);
    const healthy = make('healthy');
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(broken.run(attempt)).rejects.toThrow('listener-registration-failed');
    }
    expect(terminated).toBe(3);
    expect(broken.stats()).toMatchObject({ workers: 0, queued: 0, failed: 3 });

    // With maxWorkers 1, a leaked slot would leave this module unable to spawn.
    const task = healthy.run('ok');
    expect(host.spawnedSpecifiers).toEqual(['healthy']);
    host.handles[0].emitReady();
    host.handles[0].replyOk('ok');
    await expect(task).resolves.toBe('ok');
    await broken.shutdown();
    await healthy.shutdown();
  });
});
