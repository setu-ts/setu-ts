/**
 * The module an application actually deploys.
 *
 * Cloudflare invokes `fetch`, `queue` and `scheduled` as three separate
 * module-level exports of one Worker, sharing one application instance. This
 * assembles exactly that object and drives all three, which is the only place
 * the wiring between them is exercised end to end: a job enqueued by an HTTP
 * request, a batch delivered to the `queue` export, and a Cron Trigger firing
 * the `scheduled` export that enqueues more work.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IQueue } from '@hono-enterprise/common';

import {
  cacheApiMiddleware,
  CloudflarePlugin,
  createQueueHandler,
  createScheduledHandler,
  WorkersCron,
} from '../../src/index.ts';
import type { QueueHandler, ScheduledHandler } from '../../src/index.ts';
import { FakeCacheApi, FakeQueueBatch, FakeQueueMessage, FakeQueueProducer } from '../fakes.ts';

/** The three exports a deployed Worker module carries. */
interface WorkerModule {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly queue: QueueHandler;
  readonly scheduled: ScheduledHandler;
}

/** Builds the Worker the way an application's entry file does. */
async function buildWorker(): Promise<{
  readonly worker: WorkerModule;
  readonly producer: FakeQueueProducer;
  readonly cache: FakeCacheApi;
  readonly welcomed: string[];
  readonly settle: () => Promise<void>;
  readonly stop: () => Promise<void>;
}> {
  const producer = new FakeQueueProducer();
  const cache = new FakeCacheApi();
  const background: Promise<unknown>[] = [];

  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      CloudflarePlugin({
        env: { JOBS: producer },
        queue: { binding: 'JOBS' },
        waitUntil: (promise): void => {
          background.push(promise);
        },
      }),
    ],
  });

  app.router.post('/signup', async (ctx) => {
    const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
    return ctx.response.json({ id: await queue.add('welcome', { to: 'new@example.test' }) });
  });

  app.router.get('/catalog', {
    handler: (ctx) => ctx.response.json({ items: ['a'] }),
    middleware: [cacheApiMiddleware({ cache, ttlSeconds: 60 })],
  });

  await app.start();

  // Processors and triggers are registered against the started application,
  // exactly as an entry file would after createApp().
  const welcomed: string[] = [];
  app.services.get<IQueue>(CAPABILITIES.QUEUE).process<{ to: string }>('welcome', (job) => {
    welcomed.push(job.data.to);
  });

  const cron = new WorkersCron();
  cron.on('0 3 * * *', async () => {
    await app.services.get<IQueue>(CAPABILITIES.QUEUE).add('welcome', {
      to: 'nightly@example.test',
    });
  });

  const worker: WorkerModule = {
    fetch: (request) => app.fetch(request),
    queue: createQueueHandler(app),
    scheduled: createScheduledHandler(cron),
  };

  return {
    worker,
    producer,
    cache,
    welcomed,
    // waitUntil work is precisely what nobody awaits, so a test that wants to
    // observe its effect has to drain it the way the platform's 30s grace
    // window does.
    settle: async (): Promise<void> => {
      await Promise.all(background);
    },
    stop: async (): Promise<void> => {
      await Promise.all(background);
      await app.stop();
    },
  };
}

describe('a deployed Worker module', () => {
  it('serves fetch, and the cached route hits on the second request', async () => {
    const { worker, cache, settle, stop } = await buildWorker();

    const first = await worker.fetch(new Request('https://worker.test/catalog'));
    expect(first.headers.get('x-cache-api')).toBe('MISS');
    expect(await first.json()).toEqual({ items: ['a'] });

    // The put rode waitUntil, so it has to settle before a hit is possible.
    await settle();
    expect(cache.puts).toHaveLength(1);

    const second = await worker.fetch(new Request('https://worker.test/catalog'));
    expect(second.headers.get('x-cache-api')).toBe('HIT');
    expect(await second.json()).toEqual({ items: ['a'] });

    await stop();
  });

  it('carries a job from an HTTP request through to the queue export', async () => {
    const { worker, producer, welcomed, stop } = await buildWorker();

    const response = await worker.fetch(
      new Request('https://worker.test/signup', { method: 'POST' }),
    );
    const { id } = await response.json() as { id: string };

    // Deliver exactly what the producer recorded, as the platform would.
    const message = new FakeQueueMessage('cf-1', producer.sends.at(0)?.body, 1);
    await worker.queue(new FakeQueueBatch('jobs', [message]));

    expect(welcomed).toEqual(['new@example.test']);
    expect(message.disposition).toBe('acked');
    expect(typeof id).toBe('string');

    await stop();
  });

  it('fires the scheduled export, which enqueues work the queue export then runs', async () => {
    // The full three-export loop: cron → producer → queue consumer.
    const { worker, producer, welcomed, stop } = await buildWorker();

    await worker.scheduled({ cron: '0 3 * * *', scheduledTime: 1_700_000_000_000 });

    expect(producer.sends).toHaveLength(1);

    await worker.queue(
      new FakeQueueBatch('jobs', [new FakeQueueMessage('cf-1', producer.sends.at(0)?.body, 1)]),
    );

    expect(welcomed).toEqual(['nightly@example.test']);

    await stop();
  });

  it('ignores a trigger the Worker has no handler for, without failing the invocation', async () => {
    const { worker, producer, stop } = await buildWorker();

    await expect(worker.scheduled({ cron: '*/1 * * * *', scheduledTime: 1 }))
      .resolves.toBeUndefined();
    expect(producer.sends).toEqual([]);

    await stop();
  });
});
