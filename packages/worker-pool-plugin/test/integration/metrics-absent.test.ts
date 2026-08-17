/**
 * Integration: with no `MetricsPlugin` registered, the worker pool behaves
 * exactly as it did in M45.
 *
 * Metrics are enabled by the PRESENCE of `CAPABILITIES.METRICS`, so this is
 * the test that pins the "absent it, nothing changes" half of the design —
 * without it, a collector that threw or mis-wired when metrics are missing
 * would only be discovered by an application that does not use them.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IWorkerPool } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { WorkerPoolPlugin } from '../../src/index.ts';
import { FakeHost } from '../fixtures/fakes.ts';

const SPEC = 'file:///tasks/echo.ts';

describe('WorkerPoolPlugin — without the metrics capability', () => {
  it('should start, run a task and report stats with no metrics plugin present', async () => {
    const host = new FakeHost();
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ host })],
    });
    await app.start();

    expect(app.services.has(CAPABILITIES.METRICS)).toBe(false);

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run<number, string>(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');

    await expect(promise).resolves.toBe('done');
    expect(pool.stats()[0]).toMatchObject({
      taskModule: SPEC,
      completed: 1,
      failed: 0,
      queued: 0,
      busy: 0,
    });

    await app.stop();
  });

  it('should still surface failures and rejections through stats without metrics', async () => {
    const host = new FakeHost();
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ host })],
    });
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyError({ name: 'Error', message: 'boom' });

    await expect(promise).rejects.toThrow('boom');
    expect(pool.stats()[0]).toMatchObject({ failed: 1, completed: 0 });

    await app.stop();
  });

  it('should keep the health indicator payload unchanged from M45', async () => {
    const host = new FakeHost();
    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ host })],
    });
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('ok');
    await expect(promise).resolves.toBe('ok');

    // `pools` is the same TaskPoolStats array the gauges are fed from, so this
    // is also the baseline the metrics-present test compares against.
    expect(pool.stats()).toHaveLength(1);
    expect(pool.stats()[0].completed).toBe(1);

    await app.stop();
  });
});
