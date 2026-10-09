/**
 * A worker error that settles no task — an idle worker crashing, or a startup
 * crash with nothing queued — rejects nothing, so it must be reported.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerBudget } from '../../src/pool/worker-budget.ts';
import { WorkerPoolPlugin } from '../../src/index.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

function setup(reporter?: (error: Error) => void) {
  const host = new FakeHost(2);
  const pool = new TaskPool(
    { specifier: 'm', size: 1, maxQueue: 10, taskTimeoutMs: 0, startupTimeoutMs: 60_000 },
    host,
    createFakeRuntime(new FakeTimers()),
    new WorkerBudget(Infinity),
    undefined,
    reporter,
  );
  return { host, pool };
}

describe('TaskPool reports worker errors that settle no task', () => {
  it('reports an idle worker crash, and only that', async () => {
    const reported: string[] = [];
    const { host, pool } = setup((error) => reported.push(error.message));
    const task = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(task).resolves.toBe('done');
    host.handles[0].emitWorkerError(new Error('idle-crash'));
    expect(reported).toEqual(['idle-crash']);
    expect(pool.stats().workers).toBe(0);
    await pool.shutdown();
  });

  it('does not report a crash that rejected the in-flight task', async () => {
    const reported: string[] = [];
    const { host, pool } = setup((error) => reported.push(error.message));
    const task = pool.run(1).catch((error: Error) => error.name);
    host.handles[0].emitReady();
    host.handles[0].emitWorkerError(new Error('busy-crash'));
    await expect(task).resolves.toBe('WorkerTaskError');
    expect(reported).toEqual([]);
    await pool.shutdown();
  });

  it('does not report a startup crash that failed a waiting task', async () => {
    const reported: string[] = [];
    const { host, pool } = setup((error) => reported.push(error.message));
    const task = pool.run(1).catch((error: Error) => error.name);
    host.handles[0].emitWorkerError(new Error('startup-crash'));
    await expect(task).resolves.toBe('WorkerTaskError');
    expect(reported).toEqual([]);
    await pool.shutdown();
  });

  it('contains a reporter that throws', async () => {
    const { host, pool } = setup(() => {
      throw new Error('reporter-broken');
    });
    const task = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('ok');
    await task;
    expect(() => host.handles[0].emitWorkerError(new Error('idle'))).not.toThrow();
    await pool.shutdown();
  });

  it('logs the unsettled error through the plugin logger', async () => {
    const host = new FakeHost(2);
    const { ctx, logged } = createFakeContext(createFakeRuntime(new FakeTimers()));
    await WorkerPoolPlugin({ host }).register!(ctx);
    const pool = ctx.services.get<{ run(m: string, i: unknown): Promise<unknown> }>('worker-pool');
    const task = pool.run('file:///m.ts', 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('ok');
    await task;
    host.handles[0].emitWorkerError(new Error('idle-crash'));
    const entry = logged.find((e) => e.message.includes('with no task to settle'));
    expect(entry?.metadata).toEqual({ taskModule: 'file:///m.ts', error: 'idle-crash' });
  });
});
