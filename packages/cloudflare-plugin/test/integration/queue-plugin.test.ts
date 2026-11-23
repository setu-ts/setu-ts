import { WorkersResponse } from '../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * The `queue` arm driven through a real kernel application: registration under
 * the committed token, a producer reached from a handler, and the delivered
 * batch read back out through the processor.
 *
 * The write is read back through the same public surface rather than out of the
 * fake, so a producer that recorded nothing would fail here.
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { HealthCheckResult, IApplication, IQueue } from '@setu-ts/common';

import type { ILogger, IPlugin } from '@setu-ts/common';
import { CloudflareBindingMissingError, CloudflarePlugin } from '../../src/index.ts';
import { createQueueHandler } from '../../src/index.ts';
import {
  FakeKv,
  FakeQueueBatch,
  FakeQueueMessage,
  FakeQueueProducer,
  RecordingLogger,
} from '../fakes.ts';

/** Runs a named health indicator the way `health-plugin` would. */
async function checkHealth(app: IApplication, name: string): Promise<HealthCheckResult> {
  const indicators = app.services.getAll<{ name: string; check: () => Promise<HealthCheckResult> }>(
    CAPABILITIES.HEALTH_INDICATOR,
  );
  const indicator = indicators.find((entry) => entry.name === name);
  if (indicator === undefined) throw new Error(`no indicator named '${name}'`);
  return await indicator.check();
}

describe('CloudflarePlugin queue arm', () => {
  it('registers IQueue under the bare token and enqueues from a handler', async () => {
    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: producer },
          queue: { binding: 'JOBS', deadLetterQueue: false },
        }),
      ],
    });

    app.router.post('/signup', async (ctx) => {
      const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
      const id = await queue.add('send-welcome', { to: 'new@example.test' }, { maxAttempts: 3 });
      return ctx.response.json({ jobId: id });
    });

    await app.start();
    const response = await app.inject({ method: 'POST', url: '/signup' });

    const { jobId } = JSON.parse(response.body ?? '') as { jobId: string };
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);

    // The id the caller received is the id inside the envelope on the wire.
    expect(producer.sends.at(0)?.body).toEqual({
      v: 1,
      name: 'send-welcome',
      id: jobId,
      data: { to: 'new@example.test' },
      maxAttempts: 3,
    });

    await app.stop();
  });

  it('round-trips a job: enqueued through IQueue, delivered through the queue export', async () => {
    // The full loop, both halves through their public surfaces.
    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: producer },
          queue: { binding: 'JOBS', deadLetterQueue: false },
        }),
      ],
    });

    const processed: { readonly id: string; readonly to: string; readonly attempts: number }[] = [];
    app.router.post('/enqueue', async (ctx) => {
      const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
      queue.process<{ to: string }>('send-welcome', (job) => {
        processed.push({ id: job.id, to: job.data.to, attempts: job.attempts });
      });
      return ctx.response.json({ id: await queue.add('send-welcome', { to: 'a@example.test' }) });
    });

    await app.start();
    const enqueued = await app.inject({ method: 'POST', url: '/enqueue' });
    const { id } = JSON.parse(enqueued.body ?? '') as { id: string };

    // Deliver exactly what the producer recorded, the way the platform would.
    const message = new FakeQueueMessage('cf-msg-1', producer.sends.at(0)?.body, 1);
    await createQueueHandler(app)(new FakeQueueBatch('jobs', [message]));

    expect(processed).toEqual([{ id, to: 'a@example.test', attempts: 1 }]);
    expect(message.disposition).toBe('acked');

    await app.stop();
  });

  it('resolves a named queue instance under its derived token', async () => {
    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { REPORTS: producer },
          queue: { binding: 'REPORTS', name: 'reports', deadLetterQueue: false },
        }),
      ],
    });

    await app.start();

    expect(app.services.has('queue.reports')).toBe(true);
    // The bare token stays free, which is the point of naming an instance.
    expect(app.services.has(CAPABILITIES.QUEUE)).toBe(false);

    const queue = app.services.get<IQueue>('queue.reports');
    let ran = false;
    queue.process('build', () => {
      ran = true;
    });
    await queue.add('build', {});

    await createQueueHandler(app, { name: 'reports' })(
      new FakeQueueBatch('reports', [new FakeQueueMessage('cf-1', producer.sends.at(0)?.body)]),
    );

    expect(ran).toBe(true);
    await app.stop();
  });

  it('reads maxDelaySeconds off the arm — the option is applied, not stored', async () => {
    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: producer },
          queue: { binding: 'JOBS', maxDelaySeconds: 30 },
        }),
      ],
    });

    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);

    await expect(queue.add('j', {}, { delayMs: 31_000 })).rejects.toThrow(/at most 30s/);
    await expect(queue.add('j', {}, { delayMs: 30_000 })).resolves.toBeDefined();

    await app.stop();
  });

  it('refuses to start when the queue binding is absent', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), CloudflarePlugin({ env: {}, queue: { binding: 'JOBS' } })],
    });

    await expect(app.start()).rejects.toBeInstanceOf(CloudflareBindingMissingError);
  });

  it('performs no binding I/O at registration', async () => {
    // A producer whose send rejects, the way a real binding does from global
    // scope. Registration must complete without ever calling it.
    const exploding = {
      send: (): Promise<void> => Promise.reject(new Error('I/O in global scope')),
      sendBatch: (): Promise<void> => Promise.reject(new Error('I/O in global scope')),
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { JOBS: exploding }, queue: { binding: 'JOBS' } }),
      ],
    });

    await app.start();
    expect(app.services.has(CAPABILITIES.QUEUE)).toBe(true);
    await app.stop();
  });

  it('reports the queue arm on the health indicator', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { JOBS: new FakeQueueProducer() }, queue: { binding: 'JOBS' } }),
      ],
    });

    await app.start();
    expect((await checkHealth(app, 'cloudflare')).data?.queue).toBe(true);
    await app.stop();
  });

  it('reports queue false when the arm is not configured', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), CloudflarePlugin({ env: {} })] });

    await app.start();
    expect((await checkHealth(app, 'cloudflare')).data?.queue).toBe(false);
    expect(app.services.has(CAPABILITIES.QUEUE)).toBe(false);
    await app.stop();
  });

  it('reports a dispatch failure through a logger registered AFTER it', async () => {
    // The kernel resolves ctx.logger lazily and a capability may be registered
    // imperatively, with no `provides` for the resolver to order against.
    // Capturing the value at register() silenced every dispatch report — the
    // same defect M52 fixed on the waitUntil seam.
    const logger = new RecordingLogger();
    const lateLogger: IPlugin = {
      name: 'late-logger',
      version: '0.0.0',
      register(ctx): void {
        ctx.services.register(CAPABILITIES.LOGGER, logger as ILogger);
      },
    };

    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: producer },
          queue: { binding: 'JOBS', deadLetterQueue: false },
        }),
        lateLogger,
      ],
    });

    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    queue.process('known', () => {});
    await queue.add('known', {});

    // A name nothing is registered for: the report is the only signal.
    await createQueueHandler(app)(
      new FakeQueueBatch('jobs', [
        new FakeQueueMessage('cf-1', { v: 1, name: 'unknown', id: 'i', data: null }),
      ]),
    );

    expect(logger.messages()).toEqual(['cloudflare-queue: message not routable, retried']);
    expect(logger.records.at(0)?.meta).toMatchObject({ job: 'unknown', registered: ['known'] });

    await app.stop();
  });
});

describe('CloudflarePlugin queue arm: exhausted jobs (V13-197)', () => {
  it('passes maxRetries, deadLetterQueue and retryDelaySeconds through to the queue', async () => {
    const producer = new FakeQueueProducer();
    const dlq = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: producer, JOBS_DLQ: dlq },
          queue: {
            binding: 'JOBS',
            maxRetries: 2,
            deadLetterQueue: 'JOBS_DLQ',
            retryDelaySeconds: 5,
          },
        }),
      ],
    });
    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    const failed: string[] = [];
    queue.process(
      'j',
      () => {
        throw new Error('always');
      },
      { onFailed: (job) => void failed.push(job.id) },
    );
    await queue.add('j', { n: 1 });
    const body = producer.sends.at(0)?.body;

    const first = new FakeQueueMessage('cf-1', body, 1);
    const last = new FakeQueueMessage('cf-1', body, 2);
    await createQueueHandler(app)(new FakeQueueBatch('jobs', [first]));
    await createQueueHandler(app)(new FakeQueueBatch('jobs', [last]));

    expect(first.retryOptions).toEqual({ delaySeconds: 5 });
    expect(last.disposition).toBe('acked');
    expect(failed).toHaveLength(1);
    expect(dlq.sends.at(0)?.body).toMatchObject({ name: 'j', data: { n: 1 }, attempts: 2 });
    expect(typeof (dlq.sends.at(0)?.body as { failedAt?: unknown }).failedAt).toBe('number');
    await app.stop();
  });

  it('refuses at boot a deadLetterQueue naming a binding that is not a queue producer', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: new FakeQueueProducer(), CACHE: new FakeKv() },
          queue: { binding: 'JOBS', deadLetterQueue: 'CACHE' },
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow(/CACHE/);
  });

  it('refuses process() when the arm names no dead-letter target', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { JOBS: new FakeQueueProducer() }, queue: { binding: 'JOBS' } }),
      ],
    });
    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    expect(() => {
      queue.process('j', () => {});
    }).toThrow(/deadLetterQueue/);
    await app.stop();
  });

  it('refuses at boot a deadLetterQueue that is the queue it serves', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { JOBS: new FakeQueueProducer() },
          queue: { binding: 'JOBS', deadLetterQueue: 'JOBS' },
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow(/the queue it serves/);
  });
});
