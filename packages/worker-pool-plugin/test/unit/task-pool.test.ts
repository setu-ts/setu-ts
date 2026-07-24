/**
 * Unit tests for TaskPool — dispatch, reuse, spawn caps, queue bound,
 * timeout, error/crash semantics, shutdown, and stats — driven with the
 * scriptable FakeHost/FakeHandle and manual timers.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { TaskPool } from '../../src/pool/task-pool.ts';
import type { TaskPoolConfig } from '../../src/pool/task-pool.ts';
import {
  WorkerPoolUnavailableError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '../../src/errors.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';

const SPEC = 'file:///tasks/echo.ts';

function makePool(config?: Partial<TaskPoolConfig>, parallelism = 2): {
  pool: TaskPool;
  host: FakeHost;
  timers: FakeTimers;
} {
  const host = new FakeHost(parallelism);
  const timers = new FakeTimers();
  const runtime = createFakeRuntime(timers);
  const pool = new TaskPool(
    {
      specifier: SPEC,
      size: config?.size ?? 2,
      maxQueue: config?.maxQueue ?? 1024,
      taskTimeoutMs: config?.taskTimeoutMs ?? 0,
      ...config,
    },
    host,
    runtime,
  );
  return { pool, host, timers };
}

/** Lets queued microtasks settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TaskPool — dispatch and reuse', () => {
  it('should spawn a worker with the pool specifier and dispatch after ready', async () => {
    const { pool, host } = makePool();
    const promise = pool.run({ n: 1 });
    expect(host.spawnedSpecifiers).toEqual([SPEC]);
    expect(host.handles[0].requests).toHaveLength(0);

    host.handles[0].emitReady();
    expect(host.handles[0].requests).toHaveLength(1);
    expect(host.handles[0].requests[0].input).toEqual({ n: 1 });

    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');
  });

  it('should reuse an idle ready worker instead of spawning another', async () => {
    const { pool, host } = makePool();
    const first = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('one');
    await first;

    const second = pool.run(2);
    expect(host.handles).toHaveLength(1);
    host.handles[0].replyOk('two');
    await expect(second).resolves.toBe('two');
  });

  it('should dispatch queued tasks FIFO as workers free up', async () => {
    const { pool, host } = makePool({ size: 1 });
    const results: unknown[] = [];
    const a = pool.run('a').then((r) => results.push(r));
    const b = pool.run('b').then((r) => results.push(r));
    const c = pool.run('c').then((r) => results.push(r));

    host.handles[0].emitReady();
    expect(host.handles).toHaveLength(1);
    expect(host.handles[0].requests.map((r) => r.input)).toEqual(['a']);

    host.handles[0].replyOk('ra');
    expect(host.handles[0].requests.map((r) => r.input)).toEqual(['a', 'b']);
    host.handles[0].replyOk('rb');
    expect(host.handles[0].requests.map((r) => r.input)).toEqual(['a', 'b', 'c']);
    host.handles[0].replyOk('rc');

    await Promise.all([a, b, c]);
    expect(results).toEqual(['ra', 'rb', 'rc']);
  });

  it('should spawn workers on demand up to size and no further', () => {
    const { pool, host } = makePool({ size: 2 });
    void pool.run(1).catch(() => undefined);
    void pool.run(2).catch(() => undefined);
    void pool.run(3).catch(() => undefined);
    expect(host.handles).toHaveLength(2);
  });

  it('should not spawn a second worker for a task already covered by a starting one', () => {
    const { pool, host } = makePool({ size: 4 });
    void pool.run(1).catch(() => undefined);
    expect(host.handles).toHaveLength(1);
    // Task 1 is waiting on the still-starting worker 1; task 2 gets worker 2.
    void pool.run(2).catch(() => undefined);
    expect(host.handles).toHaveLength(2);
  });

  it('should ignore replies with a stale id and non-protocol messages', async () => {
    const { pool, host } = makePool();
    const promise = pool.run(1);
    host.handles[0].emitReady();
    const request = host.handles[0].requests[0];
    host.handles[0].emitRaw({ unrelated: true });
    host.handles[0].emitRaw({ __hewp: 1, kind: 'reply', id: request.id + 999, ok: true });
    host.handles[0].replyOk('real');
    await expect(promise).resolves.toBe('real');
    expect(pool.stats().completed).toBe(1);
  });
});

describe('TaskPool — queue bound', () => {
  it('should reject with WorkerQueueFullError beyond maxQueue', async () => {
    const { pool, host } = makePool({ size: 1, maxQueue: 1 });
    const running = pool.run('active');
    host.handles[0].emitReady();
    // 'active' is in flight; one slot in the queue remains.
    const queued = pool.run('queued');
    await expect(pool.run('overflow')).rejects.toBeInstanceOf(WorkerQueueFullError);

    host.handles[0].replyOk('r1');
    host.handles[0].replyOk('r2');
    await running;
    await queued;
  });
});

describe('TaskPool — timeout', () => {
  it('should reject, terminate, and replace the worker on timeout', async () => {
    const { pool, host, timers } = makePool({ size: 1, taskTimeoutMs: 100 });
    const promise = pool.run('slow');
    host.handles[0].emitReady();
    expect(timers.armed).toBe(1);

    timers.fire();
    await expect(promise).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    await expect(promise).rejects.toMatchObject({ taskModule: SPEC, timeoutMs: 100 });
    expect(host.handles[0].terminated).toBe(true);

    // The pool must still serve later tasks with a fresh worker.
    const next = pool.run('next');
    expect(host.handles).toHaveLength(2);
    host.handles[1].emitReady();
    host.handles[1].replyOk('ok');
    await expect(next).resolves.toBe('ok');
    expect(pool.stats().failed).toBe(1);
    expect(pool.stats().completed).toBe(1);
  });

  it('should honor a per-call timeout override', async () => {
    const { pool, host, timers } = makePool({ taskTimeoutMs: 0 });
    const promise = pool.run('x', 50);
    host.handles[0].emitReady();
    expect(timers.armed).toBe(1);
    timers.fire();
    await expect(promise).rejects.toMatchObject({ timeoutMs: 50 });
  });

  it('should arm no timer when the timeout is 0 (disabled)', async () => {
    const { pool, host, timers } = makePool({ taskTimeoutMs: 0 });
    const promise = pool.run('x');
    host.handles[0].emitReady();
    expect(timers.armed).toBe(0);
    host.handles[0].replyOk('ok');
    await expect(promise).resolves.toBe('ok');
  });

  it('should clear the timer when the task completes in time', async () => {
    const { pool, host, timers } = makePool({ taskTimeoutMs: 100 });
    const promise = pool.run('x');
    host.handles[0].emitReady();
    expect(timers.armed).toBe(1);
    host.handles[0].replyOk('ok');
    await promise;
    expect(timers.armed).toBe(0);
  });
});

describe('TaskPool — error and crash semantics', () => {
  it('should reject with WorkerTaskError on a handler error and KEEP the worker', async () => {
    const { pool, host } = makePool();
    const failing = pool.run('bad');
    host.handles[0].emitReady();
    host.handles[0].replyError({ name: 'RangeError', message: 'nope' });
    await expect(failing).rejects.toBeInstanceOf(WorkerTaskError);
    await expect(failing).rejects.toMatchObject({ remoteName: 'RangeError' });

    // Same worker still serves the next task.
    const next = pool.run('good');
    expect(host.handles).toHaveLength(1);
    host.handles[0].replyOk('fine');
    await expect(next).resolves.toBe('fine');
    expect(pool.stats()).toMatchObject({ completed: 1, failed: 1 });
  });

  it('should default the remote shape when an error reply carries none', async () => {
    const { pool, host } = makePool();
    const failing = pool.run('bad');
    host.handles[0].emitReady();
    const request = host.handles[0].requests[0];
    host.handles[0].emitRaw({ __hewp: 1, kind: 'reply', id: request.id, ok: false });
    await expect(failing).rejects.toMatchObject({
      message: `Worker task failed (${SPEC}): Error: Unknown worker error`,
    });
  });

  it('should drop a crashed worker, reject its in-flight task, and re-dispatch queued work', async () => {
    const { pool, host, timers } = makePool({ size: 1, taskTimeoutMs: 100 });
    const inFlight = pool.run('dies');
    const queued = pool.run('survives');
    host.handles[0].emitReady();

    host.handles[0].emitWorkerError(new Error('segfault-ish'));
    await expect(inFlight).rejects.toBeInstanceOf(WorkerTaskError);
    await expect(inFlight).rejects.toMatchObject({ remoteName: 'Error' });
    expect(timers.armed).toBe(0); // crashed task's timer cleared; queued task not yet dispatched

    // Queued task re-dispatched to a replacement worker once it is ready.
    expect(host.handles).toHaveLength(2);
    host.handles[1].emitReady();
    expect(timers.armed).toBe(1);
    host.handles[1].replyOk('alive');
    await expect(queued).resolves.toBe('alive');
    expect(pool.stats()).toMatchObject({ workers: 1, completed: 1, failed: 1 });
  });

  it('should drop a worker that crashes while idle without failing anything', async () => {
    const { pool, host } = makePool();
    const first = pool.run(1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('ok');
    await first;

    host.handles[0].emitWorkerError(new Error('idle crash'));
    expect(pool.stats()).toMatchObject({ workers: 0, failed: 0 });
  });
});

describe('TaskPool — shutdown', () => {
  it('should terminate workers and reject in-flight and queued tasks', async () => {
    const { pool, host } = makePool({ size: 1 });
    const inFlight = pool.run('in-flight');
    const queued = pool.run('queued');
    host.handles[0].emitReady();

    await pool.shutdown();
    await expect(inFlight).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    await expect(queued).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(host.handles[0].terminated).toBe(true);
    expect(pool.stats()).toMatchObject({ workers: 0, queued: 0 });
  });

  it('should reject run() after shutdown and stay idempotent', async () => {
    const { pool } = makePool();
    await pool.shutdown();
    await pool.shutdown();
    await expect(pool.run('late')).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
  });
});

describe('TaskPool — stats', () => {
  it('should report workers, busy, and queued live', async () => {
    const { pool, host } = makePool({ size: 1 });
    expect(pool.stats()).toEqual({
      taskModule: SPEC,
      workers: 0,
      busy: 0,
      queued: 0,
      completed: 0,
      failed: 0,
    });

    const a = pool.run('a');
    const b = pool.run('b');
    host.handles[0].emitReady();
    expect(pool.stats()).toMatchObject({ workers: 1, busy: 1, queued: 1 });

    host.handles[0].replyOk('ra');
    host.handles[0].replyOk('rb');
    await Promise.all([a, b]);
    expect(pool.stats()).toMatchObject({ busy: 0, queued: 0, completed: 2 });
    await settle();
  });
});
