import { describe, expect, it, vi } from 'vitest';
import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerBudget } from '../../src/pool/worker-budget.ts';
import { WorkerPoolService } from '../../src/services/worker-pool-service.ts';
import { WorkerPoolCollector } from '../../src/metrics/worker-pool-collector.ts';
import { WORKER_POOL_METRICS } from '../../src/metrics/metric-names.ts';
import {
  WorkerPoolUnavailableError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '../../src/errors.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { RecordingMetrics, throwOnReport } from '../fixtures/metrics-fakes.ts';

const SPEC = 'file:///tasks/echo.ts';

function setup(
  maxQueue = 10,
  budget = new WorkerBudget(1),
  host = new FakeHost(1, undefined, true),
) {
  const timers = new FakeTimers();
  const runtime = createFakeRuntime(timers, host);
  const metrics = new RecordingMetrics();
  const collector = new WorkerPoolCollector(metrics, throwOnReport);
  const pool = new TaskPool(
    {
      specifier: SPEC,
      label: 'echo',
      size: 1,
      maxQueue,
      taskTimeoutMs: 0,
      startupTimeoutMs: 60_000,
    },
    host,
    runtime,
    budget,
    collector,
  );
  return { pool, timers, host, runtime, metrics, collector };
}

function expectAborted(metrics: RecordingMetrics, count = 1): void {
  const rejected = metrics.require(WORKER_POOL_METRICS.REJECTED);
  expect(rejected.valueFor({ task_module: 'echo', reason: 'aborted' })).toBe(count);
  expect(rejected.total()).toBe(count);
  expect(metrics.require(WORKER_POOL_METRICS.FAILED).total()).toBe(0);
}

describe('TaskPool cancellation', () => {
  it.each([{ message: 'object reason' }, 'string reason', null])(
    'refuses pre-aborted work exactly: %j',
    async (reason) => {
      const { pool, host, timers, metrics } = setup();
      const controller = new AbortController();
      controller.abort(reason);
      await expect(pool.run('never', 50, controller.signal)).rejects.toBe(reason);
      expect(pool.stats()).toMatchObject({ queued: 0, workers: 0, completed: 0, failed: 0 });
      expect(host.handles).toHaveLength(0);
      expect(timers.armed).toBe(0);
      expectAborted(metrics);
      expect(metrics.require(WORKER_POOL_METRICS.COMPLETED).total()).toBe(0);
      await pool.shutdown();
    },
  );

  it('keeps closed-pool precedence, but abort wins over a full queue', async () => {
    const { pool, host, metrics } = setup(1);
    const first = pool.run('first');
    const controller = new AbortController();
    controller.abort('withdrawn');
    await expect(pool.run('never', 0, controller.signal)).rejects.toBe('withdrawn');
    expectAborted(metrics);
    host.handles[0].emitReady();
    host.handles[0].replyOk('first');
    await expect(first).resolves.toBe('first');
    await pool.shutdown();
    await expect(pool.run('closed', 0, controller.signal)).rejects.toBeInstanceOf(
      WorkerPoolUnavailableError,
    );
    expect(
      metrics
        .require(WORKER_POOL_METRICS.REJECTED)
        .valueFor({ task_module: 'echo', reason: 'pool_closed' }),
    ).toBe(1);
  });

  it('withdraws queued work, clears its timer, and preserves FIFO for the next task', async () => {
    const { pool, host, timers, metrics } = setup();
    const first = pool.run('first');
    host.handles[0].emitReady();
    const controller = new AbortController();
    const removed = pool.run('removed', 50, controller.signal);
    const assertion = expect(removed).rejects.toBe('cancel queued');
    const next = pool.run('next');
    expect(timers.armed).toBe(1);
    controller.abort('cancel queued');
    await assertion;
    expect(timers.armed).toBe(0);
    expect(pool.stats()).toMatchObject({ queued: 1, failed: 0, completed: 0 });
    expectAborted(metrics);
    host.handles[0].replyOk(1);
    expect(host.handles[0].requests.map((request) => request.input)).toEqual(['first', 'next']);
    host.handles[0].replyOk(2);
    await expect(first).resolves.toBe(1);
    await expect(next).resolves.toBe(2);
    await pool.shutdown();
  });

  it('reclaims a starting worker when its only queued call is withdrawn', async () => {
    const { pool, host, timers, metrics } = setup();
    const controller = new AbortController();
    const result = pool.run('loading', 50, controller.signal);
    const assertion = expect(result).rejects.toBe('cancel startup');
    controller.abort('cancel startup');
    await assertion;
    expect(host.handles[0].terminated).toBe(true);
    expect(pool.stats()).toMatchObject({ workers: 0, queued: 0, failed: 0 });
    expectAborted(metrics);
    await pool.shutdown();
    expect(timers.armed).toBe(0);
  });

  it('returns starting capacity to a starved module', async () => {
    const budget = new WorkerBudget(1);
    const a = setup(10, budget);
    const b = setup(10, budget);
    const controller = new AbortController();
    const removed = a.pool.run('removed', 50, controller.signal);
    const assertion = expect(removed).rejects.toBe('yield');
    const remaining = a.pool.run('remaining');
    const other = b.pool.run('other');
    controller.abort('yield');
    await assertion;
    await Promise.resolve();
    expect(a.host.handles[0].terminated).toBe(true);
    b.host.handles[0].emitReady();
    b.host.handles[0].replyOk('other');
    await expect(other).resolves.toBe('other');
    await Promise.resolve();
    a.host.handles[1].emitReady();
    a.host.handles[1].replyOk('remaining');
    await expect(remaining).resolves.toBe('remaining');
    await a.pool.shutdown();
    await b.pool.shutdown();
  });

  it('terminates running work, replaces the worker, and ignores its late traffic', async () => {
    const { pool, host, metrics, timers } = setup();
    const controller = new AbortController();
    const reason = { cancelled: true };
    const removed = pool.run('removed', 50, controller.signal);
    const assertion = expect(removed).rejects.toBe(reason);
    host.handles[0].emitReady();
    const terminate = vi.spyOn(host.handles[0], 'terminate');
    const next = pool.run('next');
    controller.abort(reason);
    await assertion;
    expect(terminate).toHaveBeenCalledTimes(1);
    expectAborted(metrics);
    expect(pool.stats()).toMatchObject({ failed: 0, completed: 0 });
    host.handles[0].replyOk('late');
    host.handles[0].emitWorkerError(new Error('late crash'));
    host.handles[0].emitExit(1);
    host.handles[1].emitReady();
    host.handles[1].replyOk('next');
    await expect(next).resolves.toBe('next');
    expect(pool.stats()).toMatchObject({ completed: 1, failed: 0 });
    expectAborted(metrics);
    await pool.shutdown();
    expect(timers.armed).toBe(0);
  });

  it.each(['success', 'handler', 'timeout', 'shutdown', 'crash', 'clone', 'abort'] as const)(
    'detaches the once listener after %s; a later abort has no effects',
    async (outcome) => {
      const host = new FakeHost(
        1,
        outcome === 'clone'
          ? () => {
              throw new Error('clone');
            }
          : undefined,
        true,
      );
      const { pool, metrics, timers } = setup(10, new WorkerBudget(1), host);
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const result = pool.run('input', 50, controller.signal);
      // Observe rejection before driving any synchronous event.
      const assertion =
        outcome === 'success'
          ? expect(result).resolves.toBe('done')
          : outcome === 'handler' || outcome === 'crash'
            ? expect(result).rejects.toBeInstanceOf(WorkerTaskError)
            : outcome === 'timeout'
              ? expect(result).rejects.toBeInstanceOf(WorkerTaskTimeoutError)
              : outcome === 'shutdown'
                ? expect(result).rejects.toBeInstanceOf(WorkerPoolUnavailableError)
                : outcome === 'abort'
                  ? expect(result).rejects.toBe('abort')
                  : expect(result).rejects.toThrow('clone');
      host.handles[0].emitReady();
      if (outcome === 'success') host.handles[0].replyOk('done');
      if (outcome === 'handler') host.handles[0].replyError({ name: 'Error', message: 'handler' });
      if (outcome === 'timeout') timers.fire(50);
      if (outcome === 'shutdown') await pool.shutdown();
      if (outcome === 'crash') host.handles[0].emitWorkerError(new Error('crash'));
      if (outcome === 'abort') controller.abort('abort');
      await assertion;
      expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1]);
      const terminate = vi.spyOn(host.handles[0], 'terminate');
      const stats = pool.stats();
      const rejected = metrics.require(WORKER_POOL_METRICS.REJECTED).total();
      controller.abort('too late');
      // A callback already captured by a host must also be harmless after settlement.
      const listener = add.mock.calls[0][1];
      if (typeof listener === 'function') listener.call(controller.signal, new Event('abort'));
      expect(terminate).not.toHaveBeenCalled();
      expect(pool.stats()).toEqual(stats);
      expect(metrics.require(WORKER_POOL_METRICS.REJECTED).total()).toBe(rejected);
      await pool.shutdown();
      expect(timers.armed).toBe(0);
    },
  );

  it.each([true, false])('shutdown/abort race: abort first = %s', async (abortFirst) => {
    const { pool, host, metrics } = setup();
    const controller = new AbortController();
    const running = pool.run('running', 50, controller.signal);
    const queued = pool.run('queued', 50, controller.signal);
    host.handles[0].emitReady();
    const assertions = [running, queued].map((promise) =>
      abortFirst
        ? expect(promise).rejects.toBe('cancel')
        : expect(promise).rejects.toBeInstanceOf(WorkerPoolUnavailableError),
    );
    if (abortFirst) controller.abort('cancel');
    await pool.shutdown();
    controller.abort('cancel');
    await Promise.all(assertions);
    expect(metrics.require(WORKER_POOL_METRICS.REJECTED).total()).toBe(abortFirst ? 2 : 0);
    expect(pool.stats()).toMatchObject({ completed: 0, failed: abortFirst ? 0 : 2 });
  });
  it('a value that is not an AbortSignal queues nothing and arms no timer', async () => {
    const { pool, timers, host } = setup();
    const bogus = { aborted: false } as unknown as AbortSignal;
    await expect(pool.run('x', 50, bogus)).rejects.toBeInstanceOf(TypeError);
    expect(pool.stats()).toMatchObject({ queued: 0, workers: 0 });
    expect(timers.armed).toBe(0);
    expect(host.handles).toHaveLength(0);
    await pool.shutdown();
  });

  it('does not dispatch to a worker an abort terminated while its input was copied', async () => {
    const controller = new AbortController();
    // Stands in for structured clone reading an input getter that aborts the call.
    const host = new FakeHost(
      2,
      (request) => {
        if (request.input === 'A') controller.abort('reentrant');
      },
      true,
    );
    const { pool, metrics } = setup(10, new WorkerBudget(1), host);
    const a = pool.run('A', 0, controller.signal);
    const aborted = expect(a).rejects.toBe('reentrant');
    const b = pool.run('B');
    host.handles[0].emitReady();
    await aborted;
    expect(host.handles[0].terminated).toBe(true);
    expect(host.handles[0].requests.map((request) => request.input)).toEqual(['A']);
    host.handles[1].emitReady();
    host.handles[1].replyOk('B done');
    await expect(b).resolves.toBe('B done');
    expectAborted(metrics);
    await pool.shutdown();
  });

  it('an abort during the input copy that then fails counts as aborted, never failed', async () => {
    const controller = new AbortController();
    // Stands in for structured clone running an aborting getter, then refusing a function.
    const host = new FakeHost(
      2,
      (request) => {
        if (request.input === 'A') {
          controller.abort('reentrant');
          throw new Error('DataCloneError');
        }
      },
      true,
    );
    const { pool, metrics } = setup(10, new WorkerBudget(1), host);
    const a = pool.run('A', 0, controller.signal);
    const aborted = expect(a).rejects.toBe('reentrant');
    host.handles[0].emitReady();
    await aborted;
    expect(pool.stats()).toMatchObject({ failed: 0, completed: 0 });
    expectAborted(metrics);
    await pool.shutdown();
  });

  it('a signal Proxy whose accessors throw late cannot strand a call or escape', async () => {
    const { pool, host, metrics } = setup();
    const real = new AbortController();
    let armed = false;
    const hostile = new Proxy(new AbortController().signal, {
      get(target, key) {
        if (armed && (key === 'aborted' || key === 'reason' || key === 'removeEventListener')) {
          throw new Error('late getter');
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const first = pool.run('first', 0, real.signal);
    const firstAborted = expect(first).rejects.toBe('stop');
    const second = pool.run('second', 0, hostile);
    host.handles[0].emitReady();
    armed = true;
    // The sweep reads the queued call's throwing `aborted`: counted as aborted.
    real.abort('stop');
    await firstAborted;
    await expect(second).rejects.toBeInstanceOf(Error);
    await expect(second).rejects.toMatchObject({ message: 'late getter' });
    expectAborted(metrics, 2);
    // A throwing removeEventListener does not stop a success from settling.
    armed = false;
    const third = pool.run('third', 0, hostile);
    host.handles[1].emitReady();
    armed = true;
    host.handles[1].replyOk('done');
    await expect(third).resolves.toBe('done');
    await pool.shutdown();
  });

  it('one signal shared by several calls starts no replacement worker for them', async () => {
    const host = new FakeHost(4, undefined, true);
    const timers = new FakeTimers();
    const metrics = new RecordingMetrics();
    const pool = new TaskPool(
      {
        specifier: SPEC,
        label: 'echo',
        size: 3,
        maxQueue: 100,
        taskTimeoutMs: 0,
        startupTimeoutMs: 60_000,
      },
      host,
      createFakeRuntime(timers, host),
      new WorkerBudget(3),
      new WorkerPoolCollector(metrics, throwOnReport),
    );
    const controller = new AbortController();
    const calls = Array.from({ length: 8 }, (_, i) => pool.run(i, 0, controller.signal));
    const settled = Promise.allSettled(calls);
    for (const handle of host.handles) handle.emitReady();
    expect(host.handles).toHaveLength(3);
    controller.abort('gone');
    const results = await settled;
    expect(results.every((r) => r.status === 'rejected' && r.reason === 'gone')).toBe(true);
    expect(host.handles).toHaveLength(3);
    expect(pool.stats()).toMatchObject({ queued: 0, workers: 0, failed: 0 });
    expectAborted(metrics, 8);
    await pool.shutdown();
  });
});

describe('WorkerPoolService cancellation', () => {
  it.each([{ cancelled: true }, 'string'])(
    'passes the exact pre-aborted reason through: %j',
    async (reason) => {
      const { host, runtime, collector, metrics, timers } = setup();
      const service = new WorkerPoolService({}, runtime, collector);
      const controller = new AbortController();
      controller.abort(reason);
      await expect(service.run(SPEC, 1, { signal: controller.signal })).rejects.toBe(reason);
      expect(host.handles).toHaveLength(0);
      expect(timers.armed).toBe(0);
      expect(service.stats()[0]).toMatchObject({ queued: 0, completed: 0, failed: 0 });
      expectAborted(metrics);
      await service.shutdown();
    },
  );

  it.each([
    null,
    {},
    { aborted: false },
    'signal',
    { aborted: 1, addEventListener: () => undefined, removeEventListener: () => undefined },
    { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  ])(
    'refuses a signal that is not an AbortSignal (%j) before admission, uncounted',
    async (signal) => {
      const timers = new FakeTimers();
      const metrics = new RecordingMetrics();
      const service = new WorkerPoolService(
        {},
        createFakeRuntime(timers, new FakeHost(1, undefined, true)),
        new WorkerPoolCollector(metrics, throwOnReport),
      );
      const error = await service
        .run(SPEC, 1, { signal: signal as unknown as AbortSignal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/^signal must be an AbortSignal; received /);
      expect(service.stats()).toEqual([]);
      expect(metrics.require(WORKER_POOL_METRICS.REJECTED).total()).toBe(0);
      expect(timers.armed).toBe(0);
      await service.shutdown();
    },
  );

  it('a throwing options getter rejects the call instead of throwing', async () => {
    const service = new WorkerPoolService(
      {},
      createFakeRuntime(new FakeTimers(), new FakeHost(1, undefined, true)),
    );
    const options = {
      get signal(): AbortSignal {
        throw new Error('getter');
      },
    };
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = service.run(SPEC, 1, options);
    }).not.toThrow();
    await expect(pending).rejects.toBeInstanceOf(Error);
    await expect(pending).rejects.toMatchObject({ message: 'getter' });
    expect(service.stats()).toEqual([]);
    await service.shutdown();
  });

  it.each(['aborted', 'reason'] as const)(
    'a signal whose %s getter throws rejects the call instead of throwing',
    async (prop) => {
      const service = new WorkerPoolService(
        {},
        createFakeRuntime(new FakeTimers(), new FakeHost(1, undefined, true)),
      );
      // A Proxy over a real signal passes `instanceof`; the guard around
      // pool.run still turns its throwing accessor into a rejection.
      const controller = new AbortController();
      if (prop === 'reason') controller.abort();
      const signal = new Proxy(controller.signal, {
        get(target, key) {
          if (key === prop) throw new Error('getter');
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = service.run(SPEC, 1, { signal });
      }).not.toThrow();
      await expect(pending).rejects.toBeInstanceOf(Error);
      await expect(pending).rejects.toMatchObject({ message: 'getter' });
      await service.shutdown();
    },
  );

  it('keeps timeout validation, closed service, and unavailable host ahead of cancellation', async () => {
    const timers = new FakeTimers();
    const metrics = new RecordingMetrics();
    const service = new WorkerPoolService(
      {},
      createFakeRuntime(timers),
      new WorkerPoolCollector(metrics, throwOnReport),
    );
    const controller = new AbortController();
    controller.abort('cancel');
    const options = { signal: controller.signal };
    await expect(service.run(SPEC, 1, options)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(
      metrics
        .require(WORKER_POOL_METRICS.REJECTED)
        .valueFor({ task_module: 'echo', reason: 'unavailable' }),
    ).toBe(1);
    await service.shutdown();
    await expect(service.run(SPEC, 1, { ...options, timeoutMs: -1 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(service.run(SPEC, 1, options)).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    expect(
      metrics
        .require(WORKER_POOL_METRICS.REJECTED)
        .valueFor({ task_module: 'echo', reason: 'pool_closed' }),
    ).toBe(1);
    expect(metrics.require(WORKER_POOL_METRICS.REJECTED).total()).toBe(2);
  });
});
