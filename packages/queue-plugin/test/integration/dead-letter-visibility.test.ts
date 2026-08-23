/**
 * X8-4 — a dead-lettered job, seen through a REAL application.
 *
 * Every other test of these three surfaces drives a fake: a recording metrics
 * service, a hand-rolled plugin context, an adapter double. Only this one
 * proves the collector agrees with the real `MetricsService`, that the
 * Prometheus renderer actually emits the series, and that the real
 * `HealthPlugin` serves the depths — the contract-violating-double rule (M37b
 * ioredis, M53 `zrangebyscore`, M55 `readStream`).
 *
 * The scenario is the register's: a job fails every attempt, exhausts its
 * retries and is dead-lettered. Before this it produced NOTHING an operator
 * could see — `/health` reported `{"adapter":"RedisQueue"}` and `/metrics`
 * carried no queue series at all.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import type { IQueue } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { QueuePlugin } from '../../src/index.ts';
import { QUEUE_METRICS } from '../../src/metrics/metric-names.ts';

const POLL_MS = 5;

/** Waits for `predicate`, or fails the test rather than hanging forever. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('dead-letter visibility through a real application (X8-4)', () => {
  it('should report the dead letter in /metrics and its depth in /health', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        HealthPlugin(),
        QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS, defaultMaxAttempts: 2 }),
      ],
    });
    await app.start();

    try {
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      const failures: unknown[] = [];
      let deadLettered = 0;

      queue.process('thumbnail', () => {
        throw new Error('thumbnailer exploded');
      }, {
        onFailed: (job, error) => {
          deadLettered++;
          failures.push({ id: job.id, name: job.name, attempts: job.attempts, error });
        },
      });

      await queue.add('thumbnail', { key: 'photo.png' });
      await until(() => deadLettered > 0, 'the job to exhaust its retries');

      // 1. The programmatic surface: the application was told, once, with the
      //    job and the error the processor threw on its final attempt.
      expect(deadLettered).toBe(1);
      expect(failures[0]).toMatchObject({ name: 'thumbnail', attempts: 2 });

      // 2. The alertable surface, rendered by the REAL Prometheus renderer.
      const metricsBody = await (await app.fetch(
        new Request('http://localhost/metrics'),
      )).text();
      expect(metricsBody).toContain(`# TYPE ${QUEUE_METRICS.JOBS} counter`);
      expect(metricsBody).toMatch(
        new RegExp(`${QUEUE_METRICS.JOBS}\\{[^}]*outcome="dead_lettered"[^}]*\\} 1`),
      );
      expect(metricsBody).toMatch(
        new RegExp(`${QUEUE_METRICS.JOBS}\\{[^}]*outcome="retried"[^}]*\\} 1`),
      );

      // 3. The durable surface: a depth the counter cannot give after a
      //    restart, served by the real HealthPlugin.
      const healthBody = await (await app.fetch(
        new Request('http://localhost/health'),
      )).json() as {
        checks?: Record<string, { data?: { queues?: Record<string, unknown> } }>;
      };
      const queueCheck = healthBody.checks?.[CAPABILITIES.QUEUE];
      expect(queueCheck?.data?.queues).toEqual({
        thumbnail: { ready: 0, processing: 0, dead: 1 },
      });
    } finally {
      await app.stop();
    }
  });
});
