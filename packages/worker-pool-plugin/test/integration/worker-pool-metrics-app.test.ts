/**
 * Integration: the worker pool and the REAL `MetricsPlugin` in one kernel
 * application, read through `GET /metrics`.
 *
 * This is the test that keeps the recording double honest. Every other
 * metrics test drives `RecordingMetrics`; only this one proves the collector
 * agrees with the real `MetricsService` and that the Prometheus renderer
 * actually emits the series — the contract-violating-double rule (M37b
 * ioredis, M53 `zrangebyscore`, M55 `readStream`).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MetricsPlugin, MetricsService } from '@setu-ts/metrics-plugin';
import type { IMetricsService, IPlugin, IWorkerPool } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

import { WorkerPoolPlugin } from '../../src/index.ts';
import { WORKER_POOL_METRICS } from '../../src/metrics/metric-names.ts';
import { FakeHost } from '../fixtures/fakes.ts';

const SPEC = 'file:///tasks/echo.ts';

function createApp(host: FakeHost) {
  return createApplication({
    plugins: [RuntimePlugin(), MetricsPlugin(), WorkerPoolPlugin({ host })],
  });
}

/** Reads the rendered Prometheus exposition text. */
async function scrape(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  return response.body as string;
}

describe('WorkerPoolPlugin — metrics through a real MetricsPlugin', () => {
  it('should declare all six series before anything has sampled them', async () => {
    const app = createApp(new FakeHost());
    await app.start();

    // No task has run. The instruments are created eagerly at register(), so
    // a freshly started replica already advertises the pool.
    const body = await scrape(app);
    for (const name of Object.values(WORKER_POOL_METRICS)) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} `);
    }
    expect(body).toContain(`# TYPE ${WORKER_POOL_METRICS.WORKERS} gauge`);
    expect(body).toContain(`# TYPE ${WORKER_POOL_METRICS.COMPLETED} counter`);

    await app.stop();
  });

  it('should render the labelled series a completed task produces', async () => {
    const host = new FakeHost();
    const app = createApp(host);
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run<number, string>(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');

    const body = await scrape(app);
    expect(body).toContain(
      `${WORKER_POOL_METRICS.COMPLETED}{task_module="${SPEC}"} 1`,
    );
    expect(body).toContain(`${WORKER_POOL_METRICS.WORKERS}{task_module="${SPEC}"} 1`);
    expect(body).toContain(`${WORKER_POOL_METRICS.BUSY}{task_module="${SPEC}"} 0`);
    expect(body).toContain(`${WORKER_POOL_METRICS.QUEUED}{task_module="${SPEC}"} 0`);

    await app.stop();
  });

  it('should render a failure with its reason label', async () => {
    const host = new FakeHost();
    const app = createApp(host);
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyError({ name: 'Error', message: 'boom' });
    await expect(promise).rejects.toThrow('boom');

    const body = await scrape(app);
    expect(body).toContain(
      `${WORKER_POOL_METRICS.FAILED}{reason="handler",task_module="${SPEC}"} 1`,
    );

    await app.stop();
  });

  it('should show saturation: queued rising while every worker is busy', async () => {
    const host = new FakeHost(1);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        WorkerPoolPlugin({ host, defaultPoolSize: 1, maxQueue: 1 }),
      ],
    });
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const running = pool.run(SPEC, 1);
    host.handles[0].emitReady();
    const queued = pool.run(SPEC, 2);
    const refused = pool.run(SPEC, 3);
    await expect(refused).rejects.toThrow();

    // The operator-facing shape of a saturated pool: every worker busy, the
    // queue occupied, and overflow counted separately from task failures.
    const saturated = await scrape(app);
    expect(saturated).toContain(`${WORKER_POOL_METRICS.BUSY}{task_module="${SPEC}"} 1`);
    expect(saturated).toContain(`${WORKER_POOL_METRICS.WORKERS}{task_module="${SPEC}"} 1`);
    expect(saturated).toContain(`${WORKER_POOL_METRICS.QUEUED}{task_module="${SPEC}"} 1`);
    expect(saturated).toContain(
      `${WORKER_POOL_METRICS.REJECTED}{reason="queue_full",task_module="${SPEC}"} 1`,
    );
    expect(saturated).not.toContain(`${WORKER_POOL_METRICS.FAILED}{`);

    host.handles[0].replyOk('first');
    await expect(running).resolves.toBe('first');
    host.handles[0].replyOk('second');
    await expect(queued).resolves.toBe('second');

    const drained = await scrape(app);
    expect(drained).toContain(`${WORKER_POOL_METRICS.QUEUED}{task_module="${SPEC}"} 0`);
    expect(drained).toContain(`${WORKER_POOL_METRICS.COMPLETED}{task_module="${SPEC}"} 2`);

    await app.stop();
  });

  it('should still see the instruments when the metrics provider registers LATE', async () => {
    // The shipped MetricsPlugin has priority 100 against this plugin's 500, so
    // priority alone would order it first and hide a missing dependency edge.
    // A replacement provider (AI_GUIDELINES §3.4 — any plugin is replaceable)
    // at a HIGHER priority number is the case where only the
    // `optionalDependencies` edge can save the wiring.
    const host = new FakeHost();
    const lateMetrics: IPlugin = {
      name: 'late-metrics-plugin',
      version: '0.0.0',
      provides: [CAPABILITIES.METRICS],
      priority: PLUGIN_PRIORITY.LOW,
      register(ctx) {
        ctx.services.register<IMetricsService>(
          CAPABILITIES.METRICS,
          new MetricsService({ defaultBuckets: [1], defaultQuantiles: [0.5] }),
        );
      },
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), WorkerPoolPlugin({ host }), lateMetrics],
    });
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run<number, string>(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');

    const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);
    expect(metrics.get(WORKER_POOL_METRICS.COMPLETED)).toBeDefined();

    await app.stop();
  });

  it('should agree with the health indicator, which reads the same snapshot', async () => {
    const host = new FakeHost();
    const app = createApp(host);
    await app.start();

    const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
    const promise = pool.run(SPEC, 1);
    host.handles[0].emitReady();
    host.handles[0].replyOk('done');
    await expect(promise).resolves.toBe('done');

    const stats = pool.stats()[0];
    const body = await scrape(app);
    expect(body).toContain(
      `${WORKER_POOL_METRICS.WORKERS}{task_module="${SPEC}"} ${stats.workers}`,
    );
    expect(body).toContain(`${WORKER_POOL_METRICS.BUSY}{task_module="${SPEC}"} ${stats.busy}`);
    expect(body).toContain(
      `${WORKER_POOL_METRICS.QUEUED}{task_module="${SPEC}"} ${stats.queued}`,
    );
    expect(body).toContain(
      `${WORKER_POOL_METRICS.COMPLETED}{task_module="${SPEC}"} ${stats.completed}`,
    );

    await app.stop();
  });
});
