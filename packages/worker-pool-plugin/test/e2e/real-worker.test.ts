/**
 * E2E: the whole stack on REAL worker threads — kernel app + RuntimePlugin
 * (real Deno worker host) + WorkerPoolPlugin, running fixture task modules
 * that register via `defineWorkerTask`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IWorkerPool } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { MetricsPlugin } from '@setu-ts/metrics-plugin';

import { WorkerPoolPlugin, WorkerTaskError, WorkerTaskTimeoutError } from '../../src/index.ts';
import { WORKER_POOL_METRICS } from '../../src/metrics/metric-names.ts';

const echoTaskUrl = new URL('../fixtures/echo-task.ts', import.meta.url).href;
const errorTaskUrl = new URL('../fixtures/error-task.ts', import.meta.url).href;
const noHandlerTaskUrl = new URL('../fixtures/no-handler-task.ts', import.meta.url).href;
const importThrowsTaskUrl = new URL('../fixtures/import-throws-task.ts', import.meta.url).href;

describe('WorkerPoolPlugin — e2e on real worker threads', () => {
  it('completes two modules under one slot and shares SAB writes with the caller', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ maxWorkers: 1 })],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const fillTaskUrl = new URL('../fixtures/fill-task.ts', import.meta.url).href;
      const buf = new SharedArrayBuffer(64);
      const first = pool.run(echoTaskUrl, { n: 21 });
      const second = pool.run(fillTaskUrl, { buf });
      expect(pool.stats().reduce((sum, stats) => sum + stats.workers, 0)).toBe(1);
      await expect(first).resolves.toEqual({ doubled: 42, from: 'worker' });
      await expect(second).resolves.toBe(64);
      expect(new Uint8Array(buf).every((byte) => byte === 42)).toBe(true);
      const copied = new ArrayBuffer(64);
      await expect(pool.run(fillTaskUrl, { buf: copied })).resolves.toBe(64);
      expect(new Uint8Array(copied).every((byte) => byte === 0)).toBe(true);
    } finally {
      await app.stop();
    }
  });
  it('should run a task on a real thread and return its output', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin()],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const result = await pool.run<{ n: number }, { doubled: number; from: string }>(
        echoTaskUrl,
        { n: 21 },
      );
      expect(result).toEqual({ doubled: 42, from: 'worker' });
      expect(pool.stats()[0]).toMatchObject({ taskModule: echoTaskUrl, completed: 1 });
    } finally {
      await app.stop();
    }
  });

  it('should complete concurrent tasks on a size-2 pool', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WorkerPoolPlugin({ pools: { [echoTaskUrl]: { size: 2 } } }),
      ],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const [a, b] = await Promise.all([
        pool.run<{ n: number }, { doubled: number }>(echoTaskUrl, { n: 1 }),
        pool.run<{ n: number }, { doubled: number }>(echoTaskUrl, { n: 2 }),
      ]);
      expect(a.doubled).toBe(2);
      expect(b.doubled).toBe(4);
      expect(pool.stats()[0].completed).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('should surface a remote handler throw as WorkerTaskError', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin()],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const failing = pool.run(errorTaskUrl, null);
      await expect(failing).rejects.toBeInstanceOf(WorkerTaskError);
      await expect(failing).rejects.toMatchObject({
        remoteName: 'RangeError',
        message: `Worker task failed (${errorTaskUrl}): RangeError: worker says no`,
      });
    } finally {
      await app.stop();
    }
  });

  it('should time out (not hang) a real module that never registers a handler', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ taskTimeoutMs: 300, maxWorkers: 1 })],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const stuck = pool.run(noHandlerTaskUrl, { n: 1 });
      await expect(stuck).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
      await expect(stuck).rejects.toMatchObject({ timeoutMs: 300 });
      expect(pool.stats()[0]).toMatchObject({ workers: 0, queued: 0 });
      await expect(pool.run(echoTaskUrl, { n: 21 }, { timeoutMs: 2000 })).resolves.toEqual({
        doubled: 42,
        from: 'worker',
      });
    } finally {
      await app.stop();
    }
  });

  it('survives a task module that throws at import, and keeps serving others', async () => {
    // Before the runtime host cancelled the worker error event, Deno re-raised
    // it in the parent as `Unhandled error in child worker` and this test
    // process died before reaching the second assertion.
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ maxWorkers: 1, taskTimeoutMs: 3_000 })],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const broken = pool.run(importThrowsTaskUrl, {});
      await expect(broken).rejects.toBeInstanceOf(WorkerTaskError);
      await expect(broken).rejects.toThrow('fixture-import-failure');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(pool.run(echoTaskUrl, { n: 2 })).resolves.toEqual({
        doubled: 4,
        from: 'worker',
      });
    } finally {
      await app.stop();
    }
  });

  it("returns a never-ready worker's slot by startup deadline even with task timeouts off", async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WorkerPoolPlugin({ maxWorkers: 1, taskTimeoutMs: 0, startupTimeoutMs: 300 }),
      ],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const stuck = pool.run(noHandlerTaskUrl, {});
      const other = pool.run(echoTaskUrl, { n: 5 });
      await expect(stuck).rejects.toBeInstanceOf(WorkerTaskError);
      await expect(stuck).rejects.toMatchObject({ remoteName: 'WorkerStartupTimeout' });
      await expect(other).resolves.toEqual({ doubled: 10, from: 'worker' });
    } finally {
      await app.stop();
    }
  });

  it('should render metrics for work done on a real thread', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), MetricsPlugin(), WorkerPoolPlugin({ taskTimeoutMs: 2000 })],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      await pool.run(echoTaskUrl, { n: 1 });
      await expect(pool.run(errorTaskUrl, { n: 1 })).rejects.toBeInstanceOf(WorkerTaskError);

      // The one place the instruments are driven by a genuine thread rather
      // than a fake host: real spawn, real structured clone, real reply.
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      const body = response.body as string;
      expect(body).toContain(`${WORKER_POOL_METRICS.COMPLETED}{task_module="${echoTaskUrl}"} 1`);
      expect(body).toContain(
        `${WORKER_POOL_METRICS.FAILED}{reason="handler",task_module="${errorTaskUrl}"} 1`,
      );
      expect(body).toContain(`${WORKER_POOL_METRICS.WORKERS}{task_module="${echoTaskUrl}"} 1`);
    } finally {
      await app.stop();
    }
  });
});
