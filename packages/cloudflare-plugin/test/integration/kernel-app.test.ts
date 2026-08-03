/**
 * The plugin driven through a real kernel application — registration, service
 * resolution, and a handler that writes through the cache and reads it back.
 *
 * Everything here goes through `createApplication` plus the real
 * `RuntimePlugin`, so the capabilities are resolved and typed exactly as an
 * application resolves them.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HealthCheckResult,
  IApplication,
  ICacheStore,
  ILogger,
  IPlugin,
  IStorage,
} from '@hono-enterprise/common';

import type { ICloudflareBindings } from '../../src/index.ts';
import { CloudflareBindingMissingError, CloudflarePlugin } from '../../src/index.ts';
import { ExplodingKv, FakeKv, FakeR2 } from '../fakes.ts';

/**
 * Runs a named health indicator the way `health-plugin` would.
 *
 * `ctx.health.register` stores each indicator as a multi-provider entry under
 * `CAPABILITIES.HEALTH_INDICATOR`, so reading them back out of the registry
 * exercises the real registration path rather than a patched method.
 */
async function checkHealth(app: IApplication, name: string): Promise<HealthCheckResult> {
  const indicators = app.services.getAll<{ name: string; check: () => Promise<HealthCheckResult> }>(
    CAPABILITIES.HEALTH_INDICATOR,
  );
  const indicator = indicators.find((entry) => entry.name === name);
  if (indicator === undefined) {
    throw new Error(
      `no indicator named '${name}'; registered: ${indicators.map((i) => i.name).join(', ')}`,
    );
  }
  return await indicator.check();
}

describe('CloudflarePlugin in a kernel application', () => {
  it('publishes the bindings capability, and a handler reads a binding through it', async () => {
    const kv = new FakeKv();
    const app = createApplication({
      plugins: [RuntimePlugin(), CloudflarePlugin({ env: { SETTINGS: kv, TIER: 'pro' } })],
    });

    app.router.get('/tier', (ctx) => {
      const cf = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
      return ctx.response.json({ tier: cf.vars().TIER, bindings: cf.names() });
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/tier' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')).toEqual({ tier: 'pro', bindings: ['SETTINGS'] });
    await app.stop();
  });

  it('serves the cache capability from KV, writing and reading back through a handler', async () => {
    const kv = new FakeKv();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { CACHE_KV: kv }, cache: { binding: 'CACHE_KV', prefix: 'c:' } }),
      ],
    });

    app.router.post('/cache', async (ctx) => {
      const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
      await cache.set('greeting', { text: 'hello' }, 30);
      return ctx.response.json({ written: true });
    });

    app.router.get('/cache', async (ctx) => {
      const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
      return ctx.response.json({ value: await cache.get<{ text: string }>('greeting') });
    });

    await app.start();

    await app.inject({ method: 'POST', url: '/cache' });
    const read = await app.inject({ method: 'GET', url: '/cache' });

    // Read back through the same public surface, not out of the fake.
    expect(JSON.parse(read.body ?? '')).toEqual({ value: { text: 'hello' } });
    // ...and the 30s TTL reached KV as its 60s floor, with the prefix applied.
    expect(kv.puts.at(0)?.key).toBe('c:greeting');
    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(60);

    await app.stop();
  });

  it('serves the storage capability from R2, writing and reading back', async () => {
    const bucket = new FakeR2();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { UPLOADS: bucket }, storage: { binding: 'UPLOADS' } }),
      ],
    });

    app.router.get('/roundtrip', async (ctx) => {
      const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
      await storage.put('note.txt', new TextEncoder().encode('persisted'));
      const bytes = await storage.get('note.txt');
      return ctx.response.json({ text: new TextDecoder().decode(bytes) });
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/roundtrip' });

    expect(JSON.parse(response.body ?? '')).toEqual({ text: 'persisted' });
    await app.stop();
  });

  it('passes every configured store option through to the store it builds', async () => {
    // Each option must be READ on a real path, not merely stored: this drives
    // the plugin under a fully non-default configuration and asserts the values
    // reached KV and R2.
    const kv = new FakeKv();
    const bucket = new FakeR2();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { CACHE_KV: kv, UPLOADS: bucket },
          cache: { binding: 'CACHE_KV', prefix: 'c:', defaultTtlSeconds: 90 },
          storage: { binding: 'UPLOADS', prefix: 'uploads/' },
        }),
      ],
    });

    app.router.get('/wire', async (ctx) => {
      const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
      const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
      await cache.set('k', 'v'); // no TTL: the configured default applies
      await storage.put('a.bin', new Uint8Array([1]));
      return ctx.response.json({ ok: true });
    });

    await app.start();
    await app.inject({ method: 'GET', url: '/wire' });

    expect(kv.puts.at(0)?.key).toBe('c:k');
    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(90);
    expect([...bucket.objects.keys()]).toEqual(['uploads/a.bin']);

    await app.stop();
  });

  it('resolves a named cache instance under its derived token', async () => {
    const kv = new FakeKv();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { CACHE_KV: kv },
          cache: { binding: 'CACHE_KV', name: 'edge' },
        }),
      ],
    });

    await app.start();

    expect(app.services.has('cache.edge')).toBe(true);
    // The bare token stays free, which is the point of naming an instance.
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(false);

    await app.stop();
  });

  it('passes a handler waitUntil, which reaches the injected platform host', async () => {
    const seen: Promise<unknown>[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: {},
          waitUntil: (promise): void => {
            seen.push(promise);
          },
        }),
      ],
    });

    let ran = false;
    app.router.get('/ping', (ctx) => {
      const cf = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
      cf.waitUntil(
        Promise.resolve().then(() => {
          ran = true;
        }),
      );
      return ctx.response.json({ ok: true });
    });

    await app.start();
    await app.inject({ method: 'GET', url: '/ping' });

    expect(seen).toHaveLength(1);
    await Promise.all(seen);
    expect(ran).toBe(true);

    await app.stop();
  });

  it('reports a background failure through a logger registered after it', async () => {
    // The kernel resolves ctx.logger lazily and a capability may be registered
    // imperatively — without a `provides` declaration the resolver can order
    // against. Capturing the logger at register() swallowed the report.
    const reported: string[] = [];
    const noop = (): void => {};
    const logger = {
      fatal: noop,
      error: (message: string): void => {
        reported.push(message);
      },
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
      child: (): ILogger => logger,
    } as unknown as ILogger;

    const lateLogger: IPlugin = {
      name: 'late-logger',
      version: '0.0.0',
      register(ctx): void {
        ctx.services.register(CAPABILITIES.LOGGER, logger);
      },
    };

    const settled: Promise<unknown>[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: {},
          waitUntil: (promise): void => {
            settled.push(promise);
          },
        }),
        lateLogger,
      ],
    });

    app.router.get('/bg', (ctx) => {
      ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE)
        .waitUntil(Promise.reject(new Error('analytics upload failed')));
      return ctx.response.json({ ok: true });
    });

    await app.start();
    await app.inject({ method: 'GET', url: '/bg' });
    await Promise.all(settled);

    expect(reported).toEqual(['cloudflare: background task failed']);
    await app.stop();
  });

  it('refuses to start when a required binding is absent, naming every one', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { CACHE_KV: new FakeKv() },
          requireBindings: ['CACHE_KV', 'SESSIONS', 'UPLOADS'],
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/SESSIONS/);
    // `in` would walk the prototype chain and let this through, defeating the
    // whole point of a fail-fast check.
    await expect(
      createApplication({
        plugins: [
          RuntimePlugin(),
          CloudflarePlugin({ env: { CACHE_KV: new FakeKv() }, requireBindings: ['toString'] }),
        ],
      }).start(),
    ).rejects.toThrow(/toString/);
    await expect(
      createApplication({
        plugins: [
          RuntimePlugin(),
          CloudflarePlugin({ env: {}, requireBindings: ['SESSIONS'] }),
        ],
      }).start(),
    ).rejects.toBeInstanceOf(CloudflareBindingMissingError);
  });

  it('refuses to start when a configured binding is present with the wrong shape', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        // An R2 bucket wired into the cache arm: a wrangler.toml mistake.
        CloudflarePlugin({ env: { UPLOADS: new FakeR2() }, cache: { binding: 'UPLOADS' } }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/a KV namespace/);
  });

  it('performs no binding I/O at registration, where the platform forbids it', async () => {
    // Every method on this namespace rejects, exactly as a real KV read does
    // when called from global scope.
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { CACHE_KV: new ExplodingKv() },
          cache: { binding: 'CACHE_KV' },
          requireBindings: ['CACHE_KV'],
        }),
      ],
    });

    await app.start();
    // Registration completed, and so does the health probe.
    const health = await checkHealth(app, 'cloudflare');
    expect(health.data?.cache).toBe(true);

    await app.stop();
  });

  it('reports degraded off Cloudflare Workers, with the binding inventory', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { CACHE_KV: new FakeKv(), TIER: 'pro' } }),
      ],
    });

    await app.start();
    const health = await checkHealth(app, 'cloudflare');

    // The suite runs on Deno, so the plugin is honestly off-platform.
    expect(health.status).toBe('degraded');
    expect(health.data?.bindings).toEqual(['CACHE_KV']);
    expect(health.data?.vars).toBe(1);
    expect(health.data?.waitUntil).toBe('absent');

    await app.stop();
  });

  it('reports up when the runtime says it is on Workers', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'cloudflare-workers' }),
        CloudflarePlugin({ env: {}, waitUntil: (): void => {} }),
      ],
    });

    await app.start();
    const health = await checkHealth(app, 'cloudflare');

    expect(health.status).toBe('up');
    expect(health.data?.waitUntil).toBe('injected');

    await app.stop();
  });
});
