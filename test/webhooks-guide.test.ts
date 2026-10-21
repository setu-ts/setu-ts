import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, type IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import {
  createDatabaseIdempotencyStore,
  DatabasePlugin,
  type IDatabaseService,
} from '@setu-ts/database-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import {
  CAPABILITIES,
  type IHealthService,
  type IIdempotencyService,
  type IJob,
  type IPlugin,
  type IQueue,
  type IRuntimeServices,
} from '@setu-ts/common';

const scratch = '.tmp/m113l-webhooks-guide';
type RegisterWebhook = (app: IKernelApplication, key: CryptoKey) => void;
let registerWebhook: RegisterWebhook;
let webhookRuntime: IPlugin;
let queuePlugin: IPlugin;
let acceptAndEnqueue: (
  idempotency: IIdempotencyService,
  queue: IQueue,
  event: { id: string },
) => Promise<void>;

beforeAll(async () => {
  // Execute the actual published fence, so prose and its proof share one recipe.
  const markdown = await readFile('docs/webhooks.md', 'utf8');
  await mkdir(scratch, { recursive: true });
  const loadFence = async (index: number, name: string): Promise<unknown> => {
    const code = markdown.split('```typescript\n')[index + 1]?.split('```')[0];
    if (!code) throw new Error(`Missing webhook ${name} recipe`);
    const outfile = `${scratch}/${name}.mjs`;
    await build({
      stdin: {
        contents: code,
        loader: 'ts',
        sourcefile: `webhooks-${name}.ts`,
        resolveDir: process.cwd(),
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      tsconfig: 'test/fixtures/snippets/tsconfig.json',
    });
    return import(pathToFileURL(resolve(outfile)).href);
  };
  const module = await loadFence(0, 'http');
  if (
    typeof module !== 'object' ||
    module === null ||
    !('registerWebhook' in module) ||
    typeof module.registerWebhook !== 'function' ||
    !('webhookRuntime' in module) ||
    typeof module.webhookRuntime !== 'object' ||
    module.webhookRuntime === null
  )
    throw new Error('Missing registerWebhook export');
  registerWebhook = module.registerWebhook as RegisterWebhook;
  webhookRuntime = module.webhookRuntime as IPlugin;
  const queueModule = await loadFence(2, 'queue');
  if (
    typeof queueModule !== 'object' ||
    queueModule === null ||
    !('queuePlugin' in queueModule) ||
    typeof queueModule.queuePlugin !== 'object' ||
    queueModule.queuePlugin === null ||
    !('acceptAndEnqueue' in queueModule) ||
    typeof queueModule.acceptAndEnqueue !== 'function'
  )
    throw new Error('Missing queue recipe exports');
  queuePlugin = queueModule.queuePlugin as IPlugin;
  acceptAndEnqueue = queueModule.acceptAndEnqueue as typeof acceptAndEnqueue;
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('webhook guide through the real kernel and tier-C store', () => {
  it('handles a verified event once and refuses bad/stale signatures before within or business writes', async () => {
    const app = createApplication({
      plugins: [
        webhookRuntime,
        DatabasePlugin(),
        IdempotencyPlugin({
          transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
        }),
      ],
    });
    app.middleware.add(errorHandler(), { priority: 0, name: 'error-handler' });
    await app.start();
    try {
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const key = await runtime.subtle.importKey(
        'raw',
        new TextEncoder().encode('test-only-webhook-secret'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
      registerWebhook(app, key);
      const service = app.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
      const within = vi.spyOn(service, 'within');
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository<{ id: string; type: string }>('WebhookReceipt');
      const send = async (body: string, stamp: string, signature?: string) => {
        const bytes = new TextEncoder().encode(`${stamp}.${body}`);
        const mac = await runtime.subtle.sign('HMAC', key, bytes);
        const hex = Array.from(new Uint8Array(mac), (n) => n.toString(16).padStart(2, '0')).join(
          '',
        );
        return app.inject({
          method: 'POST',
          url: '/webhooks/provider',
          body,
          headers: { 'webhook-timestamp': stamp, 'webhook-signature': signature ?? hex },
        });
      };
      const stamp = String(Math.floor(runtime.now() / 1000));
      const body = '{ "id": "event-1", "type": "invoice.paid" }';
      const first = await send(body, stamp);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ accepted: true });
      expect(await repo.findById('event-1')).toEqual({ id: 'event-1', type: 'invoice.paid' });
      const replay = await send('{"id":"event-1","type":"invoice.paid","retry":2}', stamp);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ accepted: true });
      expect(await repo.count()).toBe(1);
      expect(within).toHaveBeenCalledTimes(2);

      const invalid = await send('{"id":"bad","type":"invoice.paid"}', stamp, '00'.repeat(32));
      expect(invalid.statusCode).toBe(401);
      const stale = await send(
        '{"id":"stale","type":"invoice.paid"}',
        String(Math.floor(runtime.now() / 1000) - 301),
      );
      expect(stale.statusCode).toBe(401);
      const malformedId = await send('{"id":"invalid id","type":"invoice.paid"}', stamp);
      expect(malformedId.statusCode).toBe(400);
      const oversized = await app.inject({
        method: 'POST',
        url: '/webhooks/provider',
        body: 'not JSON',
        headers: { 'content-length': String(1024 * 1024 + 1) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(within).toHaveBeenCalledTimes(2);
      expect(await repo.findAll()).toEqual([{ id: 'event-1', type: 'invoice.paid' }]);
      const changedEvent = await send('{"id":"event-1","type":"invoice.refunded"}', stamp);
      expect(changedEvent.statusCode).toBe(422);
      expect(within).toHaveBeenCalledTimes(3);
      expect(await repo.findAll()).toEqual([{ id: 'event-1', type: 'invoice.paid' }]);
    } finally {
      vi.restoreAllMocks();
      await app.stop();
    }
  });

  it.each([
    {
      name: 'future timestamp',
      offset: 301,
      signature: undefined,
      body: '{"id":"future","type":"invoice.paid"}',
      verifyCalls: 0,
    },
    {
      name: 'malformed signature',
      offset: 0,
      signature: 'not-hex',
      body: '{"id":"malformed","type":"invoice.paid"}',
      verifyCalls: 0,
    },
    {
      name: 'invalid signature on non-JSON body',
      offset: 0,
      signature: '00'.repeat(32),
      body: 'this is not JSON',
      verifyCalls: 1,
    },
  ])('refuses $name before parsing or work', async ({ offset, signature, body, verifyCalls }) => {
    const app = createApplication({
      plugins: [
        webhookRuntime,
        DatabasePlugin(),
        IdempotencyPlugin({
          transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
        }),
      ],
    });
    await app.start();
    try {
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      const key = await runtime.subtle.importKey(
        'raw',
        new TextEncoder().encode('test-only-webhook-secret'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
      registerWebhook(app, key);
      const now = Math.floor(runtime.now() / 1000) * 1000;
      vi.spyOn(runtime, 'now').mockReturnValue(now);
      const stamp = String(now / 1000 + offset);
      const mac = await runtime.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${stamp}.${body}`),
      );
      const hex = Array.from(new Uint8Array(mac), (n) => n.toString(16).padStart(2, '0')).join('');
      const verify = vi.spyOn(runtime.subtle, 'verify');
      const service = app.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
      const within = vi.spyOn(service, 'within');
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/provider',
        body,
        headers: { 'webhook-timestamp': stamp, 'webhook-signature': signature ?? hex },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Invalid delivery' });
      expect(verify).toHaveBeenCalledTimes(verifyCalls);
      expect(within).not.toHaveBeenCalled();
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(await db.getRepository('WebhookReceipt').findAll()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await app.stop();
    }
  });

  it('drains two separately enqueued copies of an event with one processor run', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HealthPlugin(),
        DatabasePlugin(),
        IdempotencyPlugin({
          transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
        }),
        queuePlugin,
      ],
    });
    await app.start();
    try {
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      const idempotency = app.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
      const health = app.services.get<IHealthService>(CAPABILITIES.HEALTH);
      const processor = vi.fn<(job: IJob<{ id: string }>) => void>();
      const failed = vi.fn();
      queue.process('process-webhook', processor, { onFailed: failed });
      const enqueue = vi.spyOn(queue, 'add');
      await acceptAndEnqueue(idempotency, queue, { id: 'event-queue' });
      await acceptAndEnqueue(idempotency, queue, { id: 'event-queue' });
      expect(enqueue).toHaveBeenCalledTimes(2);
      const ids = await Promise.all(enqueue.mock.results.map((result) => result.value));
      expect(new Set(ids).size).toBe(2);
      // Drain both jobs, rather than accepting a count observed before the second dispatch.
      await vi.waitFor(
        async () => {
          const report = await health.check();
          expect(report.checks.queue?.data).toMatchObject({
            backlog: 0,
            queues: { 'process-webhook': { ready: 0, processing: 0, dead: 0 } },
          });
        },
        { timeout: 8000, interval: 50 },
      );
      expect(failed).not.toHaveBeenCalled();
      expect(processor).toHaveBeenCalledTimes(1);
      expect(processor.mock.calls[0]?.[0]).toMatchObject({ data: { id: 'event-queue' } });
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(await db.getRepository('WebhookReceipt').findAll()).toEqual([{ id: 'event-queue' }]);
    } finally {
      vi.restoreAllMocks();
      await app.stop();
    }
  });
});
