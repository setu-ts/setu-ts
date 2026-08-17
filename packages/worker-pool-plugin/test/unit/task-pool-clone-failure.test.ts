/**
 * Regression tests for X8-2 — a task input that `postMessage` refuses.
 *
 * The defect was load-dependent, which is why every earlier test missed it:
 * dispatched straight from `run()` the throw rejects the caller's promise
 * normally, but dispatched from the queue drain — inside an `onMessage`
 * callback — the identical throw is an UNCAUGHT exception that killed the
 * host process (observed: `error: Uncaught DataCloneError`, exit 1).
 *
 * Both paths are driven here, and the drain path is the one that fails
 * without the guard in `TaskPool.dispatch`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { TaskPool } from '../../src/pool/task-pool.ts';
import { WorkerPoolCollector } from '../../src/metrics/worker-pool-collector.ts';
import {
  REASON_LABEL,
  TASK_MODULE_LABEL,
  WORKER_POOL_METRICS,
} from '../../src/metrics/metric-names.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { RecordingMetrics, throwOnReport } from '../fixtures/metrics-fakes.ts';

const SPEC = 'file:///tasks/echo.ts';
const POISON = '__poison__';

/**
 * A pool whose host refuses exactly one input value, the way a real
 * `postMessage` refuses a function or a class instance with methods.
 */
function makePool(size: number): {
  pool: TaskPool;
  host: FakeHost;
  metrics: RecordingMetrics;
} {
  const host = new FakeHost(2, (request) => {
    if (request.input === POISON) {
      throw new DOMException(`${POISON} could not be cloned.`, 'DataCloneError');
    }
  });
  const timers = new FakeTimers();
  const metrics = new RecordingMetrics();
  const pool = new TaskPool(
    { specifier: SPEC, size, maxQueue: 1024, taskTimeoutMs: 0 },
    host,
    createFakeRuntime(timers),
    new WorkerPoolCollector(metrics, throwOnReport),
  );
  return { pool, host, metrics };
}

describe('TaskPool — a non-cloneable input (X8-2)', () => {
  it('should reject the task when dispatched straight from run() (path A)', async () => {
    const { pool, host } = makePool(1);

    // Warm the pool first: the slot must be ready AND idle before the poison
    // task is submitted, or `run()` merely queues it and the drain does the
    // dispatch — which is path C, not path A.
    const warmup = pool.run('good');
    host.handles[0].emitReady();
    host.handles[0].replyOk('warm');
    await expect(warmup).resolves.toBe('warm');
    expect(pool.stats()).toMatchObject({ workers: 1, busy: 0, queued: 0 });

    // This dispatch happens synchronously inside run(), in the caller's own
    // promise — the path that was already well-behaved before the fix.
    const promise = pool.run(POISON);
    expect(host.handles[0].requests.map((request) => request.input)).toEqual(['good']);

    await expect(promise).rejects.toThrow('could not be cloned');
  });

  it('should reject the task when dispatched from the queue drain (path C)', async () => {
    const { pool, host } = makePool(1);

    // A busy pool of one: the poison task waits, then dispatches from inside
    // the reply handler. Pre-fix this throw escaped as an uncaught exception.
    const running = pool.run('good');
    host.handles[0].emitReady();
    const poisoned = pool.run(POISON);

    host.handles[0].replyOk('first-result');

    await expect(running).resolves.toBe('first-result');
    await expect(poisoned).rejects.toThrow('could not be cloned');
  });

  it('should keep serving on the same pool after refusing a bad input', async () => {
    const { pool, host } = makePool(1);

    const running = pool.run('good');
    host.handles[0].emitReady();
    const poisoned = pool.run(POISON);
    const queued = pool.run('also-good');

    host.handles[0].replyOk('first-result');
    await expect(running).resolves.toBe('first-result');
    await expect(poisoned).rejects.toThrow('could not be cloned');

    // The queue must not stall behind the refused task: the same slot takes
    // the next waiting task in the same drain.
    host.handles[0].replyOk('third-result');
    await expect(queued).resolves.toBe('third-result');

    expect(pool.stats()).toMatchObject({ completed: 2, failed: 1, queued: 0, busy: 0 });
  });

  it('should retain the worker, which never received the bad request', async () => {
    const { pool, host } = makePool(1);

    const running = pool.run('good');
    host.handles[0].emitReady();
    const poisoned = pool.run(POISON);
    host.handles[0].replyOk('ok');

    await expect(running).resolves.toBe('ok');
    await expect(poisoned).rejects.toThrow();

    expect(host.handles).toHaveLength(1);
    expect(host.handles[0].terminated).toBe(false);
    // Only the good task's request was ever handed over.
    expect(host.handles[0].requests.map((request) => request.input)).toEqual(['good']);
    expect(pool.stats().workers).toBe(1);
  });

  it('should wrap a non-Error thrown value so the caller still gets an Error', async () => {
    // A host (or a runtime) that throws a bare string must not reach the
    // task's `reject` as a non-Error: `IWorkerPool.run` documents typed
    // errors, and `instanceof` checks downstream would silently miss.
    const host = new FakeHost(2, (request) => {
      if (request.input === POISON) {
        throw 'not an error object';
      }
    });
    const pool = new TaskPool(
      { specifier: SPEC, size: 1, maxQueue: 1024, taskTimeoutMs: 0 },
      host,
      createFakeRuntime(new FakeTimers()),
      new WorkerPoolCollector(new RecordingMetrics(), throwOnReport),
    );

    const promise = pool.run(POISON);
    host.handles[0].emitReady();

    await expect(promise).rejects.toThrow('not an error object');
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
    });
  });

  it('should count the refusal as a failure with reason clone', async () => {
    const { pool, host, metrics } = makePool(1);

    const promise = pool.run(POISON);
    host.handles[0].emitReady();
    await expect(promise).rejects.toThrow();

    expect(
      metrics.require(WORKER_POOL_METRICS.FAILED).valueFor({
        [TASK_MODULE_LABEL]: SPEC,
        [REASON_LABEL]: 'clone',
      }),
    ).toBe(1);
    expect(pool.stats().failed).toBe(1);
  });
});
