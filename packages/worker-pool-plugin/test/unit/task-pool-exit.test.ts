/**
 * Regression tests for X8-7 — a worker that ends its own thread.
 *
 * The register's case D is the damaging one: on a `size: 1` pool with
 * `taskTimeoutMs: 0`, one self-terminated worker held its slot forever, so
 * `run()` never settled and every later task on that module queued behind a
 * slot that would never free. Nothing detected it, because a thread that simply
 * stops raises no `'error'` and the task timeout — disabled by `0` — was the
 * only thing that ever settled such a task.
 *
 * `taskTimeoutMs: 0` is used throughout deliberately: with a timeout armed the
 * pool eventually recovers either way, so these tests would pass without the
 * fix.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerExitError } from '../../src/errors.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';

const SPEC = 'file:///tasks/heavy.ts';

/**
 * Builds a pool over a host that DOES report worker exits (Node/Bun), with the
 * task timeout disabled so the exit signal is the only possible settle path.
 */
function makeReportingPool(size = 1, maxQueue = 1024): { pool: TaskPool; host: FakeHost } {
  const host = new FakeHost(2, undefined, true);
  const pool = new TaskPool(
    { specifier: SPEC, size, maxQueue, taskTimeoutMs: 0 },
    host,
    createFakeRuntime(new FakeTimers()),
  );
  return { pool, host };
}

/**
 * Awaits a rejection and narrows it to {@linkcode WorkerExitError}, failing
 * loudly if the pool settled with anything else — so a test reading `.code`
 * cannot silently pass against a different error.
 */
async function captureExit(promise: Promise<unknown>): Promise<WorkerExitError> {
  try {
    await promise;
  } catch (raised) {
    if (raised instanceof WorkerExitError) {
      return raised;
    }
    throw new Error(`expected WorkerExitError, got ${String(raised)}`);
  }
  throw new Error('expected the task to reject, but it resolved');
}

describe('TaskPool — a worker that ends its own thread (X8-7)', () => {
  it('should settle the in-flight task with WorkerExitError and no timeout armed', async () => {
    const { pool, host } = makeReportingPool();
    const promise = pool.run({ n: 1 });
    host.handles[0].emitReady();
    expect(pool.stats()).toMatchObject({ busy: 1 });

    host.handles[0].emitExit(0);

    await expect(promise).rejects.toThrow(WorkerExitError);
    await expect(promise).rejects.toThrow('exited while its task was in flight');
  });

  it('should carry the specifier and the reported exit code on the error', async () => {
    const { pool, host } = makeReportingPool();
    const promise = pool.run({ n: 1 });
    host.handles[0].emitReady();
    host.handles[0].emitExit(137);

    const error = await captureExit(promise);
    expect(error.taskModule).toBe(SPEC);
    expect(error.code).toBe(137);
  });

  it('should report an unknown code as null rather than inventing one', async () => {
    const { pool, host } = makeReportingPool();
    const promise = pool.run({ n: 1 });
    host.handles[0].emitReady();
    host.handles[0].emitExit(null);

    const error = await captureExit(promise);
    expect(error.code).toBeNull();
    expect(error.message).toContain('code unknown');
  });

  it('should free the wedged slot so a later task runs on a fresh worker (case D)', async () => {
    // This is X8-7's own reproduction: without the fix the second task stays
    // pending forever because the pool believes slot 0 is still busy.
    const { pool, host } = makeReportingPool(1);

    const first = pool.run({ n: 1 });
    host.handles[0].emitReady();
    host.handles[0].emitExit(0);
    await expect(first).rejects.toThrow(WorkerExitError);

    expect(pool.stats()).toMatchObject({ workers: 0, busy: 0 });

    const second = pool.run({ n: 2 });
    expect(host.handles).toHaveLength(2);
    host.handles[1].emitReady();
    host.handles[1].replyOk('recovered');

    await expect(second).resolves.toBe('recovered');
  });

  it('should fail the oldest waiting task when the worker dies before signalling ready', async () => {
    // A module that cannot load leaves the pool respawning into the same
    // failure; failing the waiting task surfaces the cause instead.
    const { pool, host } = makeReportingPool(1);
    const promise = pool.run({ n: 1 });

    host.handles[0].emitExit(1);

    await expect(promise).rejects.toThrow(WorkerExitError);
  });

  it('should count an exit as a failure in the stats the health indicator reads', async () => {
    const { pool, host } = makeReportingPool();
    const promise = pool.run({ n: 1 });
    host.handles[0].emitReady();
    host.handles[0].emitExit(0);
    await promise.catch(() => {});

    expect(pool.stats()).toMatchObject({ failed: 1, completed: 0 });
  });
});

describe('TaskPool — an exit the pool asked for', () => {
  it('should not double-settle or reject a queued task on shutdown', async () => {
    // A real reporting runtime raises its exit event after `terminate()` too
    // (Bun emits `close` with code 0), so shutdown would otherwise report every
    // worker as crashed — and on a not-ready slot would reject an unrelated
    // pending task through the startup-failure branch.
    const { pool, host } = makeReportingPool(1, 10);

    const inFlight = pool.run({ n: 1 });
    host.handles[0].emitReady();
    const queued = pool.run({ n: 2 });

    await pool.shutdown();

    // Both settle as shutdown, not as an exit — one disposition each.
    await expect(inFlight).rejects.toThrow('Worker pool has been shut down');
    await expect(queued).rejects.toThrow('Worker pool has been shut down');
    expect(host.handles[0].terminated).toBe(true);
  });

  it('should not re-settle a task whose timeout already terminated its worker', async () => {
    const timers = new FakeTimers();
    const host = new FakeHost(2, undefined, true);
    const pool = new TaskPool(
      { specifier: SPEC, size: 1, maxQueue: 10, taskTimeoutMs: 50 },
      host,
      createFakeRuntime(timers),
    );

    const promise = pool.run({ n: 1 });
    host.handles[0].emitReady();
    timers.fire();

    // The timeout terminated the worker, which fires its exit; the task must
    // still report the timeout it actually hit.
    await expect(promise).rejects.toThrow('timed out');
    expect(pool.stats()).toMatchObject({ failed: 1 });
  });
});

describe('TaskPool — a host that cannot report exits (Deno)', () => {
  it('should register no exit listener and behave exactly as before', async () => {
    const host = new FakeHost(2, undefined, false);
    const pool = new TaskPool(
      { specifier: SPEC, size: 1, maxQueue: 10, taskTimeoutMs: 0 },
      host,
      createFakeRuntime(new FakeTimers()),
    );

    const promise = pool.run({ n: 1 });
    const handle = host.handles[0];
    handle.emitReady();

    // The member is genuinely absent, which is the signal an application reads
    // through `IWorkerHost.reportsExit` — not a listener that never fires.
    expect('onExit' in handle).toBe(false);
    expect(host.reportsExit).toBeUndefined();

    handle.replyOk('done');
    await expect(promise).resolves.toBe('done');
  });
});

describe('TaskPool — shutdown ordering the exit path depends on', () => {
  it('should settle queued tasks as shutdown even when no worker ever became ready', async () => {
    // The scenario that makes the exit path's disposition matter: both slots
    // are spawned and neither signals ready, so every one of their exits takes
    // the startup-failure branch — which rejects the OLDEST QUEUED task. The
    // tasks must still report the shutdown, because that is what happened to
    // them; reporting a worker exit would name the wrong cause.
    const host = new FakeHost(2, undefined, true);
    const pool = new TaskPool(
      { specifier: SPEC, size: 2, maxQueue: 10, taskTimeoutMs: 0 },
      host,
      createFakeRuntime(new FakeTimers()),
    );

    const first = pool.run({ n: 1 });
    const second = pool.run({ n: 2 });
    expect(host.handles).toHaveLength(2);
    expect(pool.stats()).toMatchObject({ workers: 2, queued: 2 });

    await pool.shutdown();

    await expect(first).rejects.toThrow('Worker pool has been shut down');
    await expect(second).rejects.toThrow('Worker pool has been shut down');
    expect(host.handles.every((handle) => handle.terminated)).toBe(true);
  });
});
