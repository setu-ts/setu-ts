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

import { WorkerPoolPlugin, WorkerTaskError, WorkerTaskTimeoutError } from '../../src/index.ts';

const echoTaskUrl = new URL('../fixtures/echo-task.ts', import.meta.url).href;
const errorTaskUrl = new URL('../fixtures/error-task.ts', import.meta.url).href;
const noHandlerTaskUrl = new URL('../fixtures/no-handler-task.ts', import.meta.url).href;

describe('WorkerPoolPlugin — e2e on real worker threads', () => {
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
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ taskTimeoutMs: 300 })],
    });
    await app.start();
    try {
      const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const stuck = pool.run(noHandlerTaskUrl, { n: 1 });
      await expect(stuck).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
      await expect(stuck).rejects.toMatchObject({ timeoutMs: 300 });
    } finally {
      await app.stop();
    }
  });
});
