import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication, type IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  createDatabaseIdempotencyStore,
  DatabasePlugin,
  type IDatabaseService,
} from '@setu-ts/database-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { CAPABILITIES, type IIdempotencyService, type IRuntimeServices } from '@setu-ts/common';

const scratch = '.tmp/m113l-webhooks-guide';
type RegisterWebhook = (app: IKernelApplication, key: CryptoKey) => void;
let registerWebhook: RegisterWebhook;

beforeAll(async () => {
  // Execute the actual published fence, so prose and its proof share one recipe.
  const markdown = await readFile('docs/webhooks.md', 'utf8');
  const code = markdown.split('```typescript\n')[1]?.split('```')[0];
  if (!code) throw new Error('Missing webhook recipe');
  await mkdir(scratch, { recursive: true });
  const outfile = `${scratch}/recipe.mjs`;
  await build({
    stdin: {
      contents: code,
      loader: 'ts',
      sourcefile: 'webhooks-guide.ts',
      resolveDir: process.cwd(),
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    tsconfig: 'test/fixtures/snippets/tsconfig.json',
  });
  const module: unknown = await import(pathToFileURL(resolve(outfile)).href);
  if (
    typeof module !== 'object' ||
    module === null ||
    !('registerWebhook' in module) ||
    typeof module.registerWebhook !== 'function'
  )
    throw new Error('Missing registerWebhook export');
  registerWebhook = module.registerWebhook as RegisterWebhook;
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('webhook guide through the real kernel and tier-C store', () => {
  it('handles a verified event once and refuses bad/stale signatures before within or business writes', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
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
      const replay = await send(body, stamp);
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
      expect(within).toHaveBeenCalledTimes(2);
      expect(await repo.findAll()).toEqual([{ id: 'event-1', type: 'invoice.paid' }]);
    } finally {
      vi.restoreAllMocks();
      await app.stop();
    }
  });
});
