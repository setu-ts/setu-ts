/**
 * Integration tests: the plugin registered in a real kernel application —
 * capability resolution, a run round-trip via the resolved service, and
 * worker termination on app stop.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import type { IWorkerPool } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { WorkerPoolPlugin } from '../../src/index.ts';
import { FakeHost } from '../fixtures/fakes.ts';

describe('WorkerPoolPlugin — integration (real kernel app)', () => {
  it('should resolve an IWorkerPool and round-trip a task through it', async () => {
    const host = new FakeHost();
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ host })],
    });
    await app.start();

    expect(app.services.has(CAPABILITIES.WORKER_POOL)).toBe(true);
    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);

    const promise = pool.run<{ n: number }, string>('file:///t.ts', { n: 1 });
    host.handles[0].emitReady();
    host.handles[0].replyOk('round-trip');
    await expect(promise).resolves.toBe('round-trip');
    expect(pool.stats()[0]).toMatchObject({ taskModule: 'file:///t.ts', completed: 1 });

    await app.stop();
  });

  it('should terminate spawned workers when the application stops', async () => {
    const host = new FakeHost();
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ host })],
    });
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const pending = pool.run('file:///t.ts', 1);
    host.handles[0].emitReady();

    await app.stop();
    expect(host.handles.every((h) => h.terminated)).toBe(true);
    await expect(pending).rejects.toThrow('shut down');
  });
});
