/**
 * The edge cache middleware on a real route, resolving `waitUntil` from the
 * plugin the way a deployed Worker does.
 *
 * Driven through `app.fetch` rather than `app.inject`, for a reason worth
 * stating: a HIT is replayed with `IResponse.stream`, so a cached response of
 * any size reaches the client without landing in memory — and `inject()`
 * refuses to read a streaming body. `fetch` is also the entry point a Worker
 * actually calls, so this exercises the deployed path.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import type { IApplication } from '@hono-enterprise/common';

import { cacheApiMiddleware, CloudflarePlugin } from '../../src/index.ts';
import { FakeCacheApi } from '../fakes.ts';

/** Drives one GET through the application's fetch entry. */
function get(app: IApplication, path: string): Promise<Response> {
  return app.fetch(new Request(`https://worker.test${path}`));
}

describe('cacheApiMiddleware in a kernel application', () => {
  it('misses, stores through the plugin waitUntil, then hits without the handler', async () => {
    const cache = new FakeCacheApi();
    const background: Promise<unknown>[] = [];

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: {},
          waitUntil: (promise): void => {
            background.push(promise);
          },
        }),
      ],
    });

    let handlerCalls = 0;
    app.router.get('/catalog', {
      handler: (ctx) => {
        handlerCalls += 1;
        return ctx.response.json({ items: ['a', 'b'] });
      },
      middleware: [cacheApiMiddleware({ cache, ttlSeconds: 300 })],
    });

    await app.start();

    const first = await get(app, '/catalog');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-cache-api')).toBe('MISS');
    expect(await first.json()).toEqual({ items: ['a', 'b'] });
    expect(handlerCalls).toBe(1);

    // The write went to the platform sink rather than blocking the response.
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts.at(0)?.response.headers.get('cache-control')).toBe('public, max-age=300');
    // ...and the client's own response never carried the directive.
    expect(first.headers.get('cache-control')).toBeNull();

    const second = await get(app, '/catalog');
    expect(second.headers.get('x-cache-api')).toBe('HIT');
    // Served from the cache, byte for byte, with the handler never re-entered.
    expect(await second.json()).toEqual({ items: ['a', 'b'] });
    expect(handlerCalls).toBe(1);

    await app.stop();
  });

  it('caches per URL, so a different query string is a separate entry', async () => {
    const cache = new FakeCacheApi();
    const app = createApplication({ plugins: [RuntimePlugin(), CloudflarePlugin({ env: {} })] });

    app.router.get('/search', {
      handler: (ctx) => ctx.response.json({ q: ctx.query.q ?? '' }),
      middleware: [cacheApiMiddleware({ cache })],
    });

    await app.start();

    const one = await get(app, '/search?q=one');
    expect(await one.json()).toEqual({ q: 'one' });

    const two = await get(app, '/search?q=two');
    expect(two.headers.get('x-cache-api')).toBe('MISS');
    expect(await two.json()).toEqual({ q: 'two' });
    expect(cache.entries.size).toBe(2);

    // The first URL now hits, and hits with ITS value rather than the other's.
    const again = await get(app, '/search?q=one');
    expect(again.headers.get('x-cache-api')).toBe('HIT');
    expect(await again.json()).toEqual({ q: 'one' });

    await app.stop();
  });

  it('does not cache a response the handler marked with Set-Cookie', async () => {
    const cache = new FakeCacheApi();
    const app = createApplication({ plugins: [RuntimePlugin(), CloudflarePlugin({ env: {} })] });

    app.router.get('/session', {
      handler: (ctx) => {
        ctx.response.appendHeader('set-cookie', 'sid=abc; Path=/');
        return ctx.response.json({ ok: true });
      },
      middleware: [cacheApiMiddleware({ cache })],
    });

    await app.start();

    const first = await get(app, '/session');
    const second = await get(app, '/session');

    expect(first.headers.get('x-cache-api')).toBe('MISS');
    // Still a miss the second time: nothing was ever stored.
    expect(second.headers.get('x-cache-api')).toBe('MISS');
    expect(cache.puts).toEqual([]);

    await first.body?.cancel();
    await second.body?.cancel();
    await app.stop();
  });

  it('serves normally with BYPASS when the plugin is absent and no handle resolves', async () => {
    // No CloudflarePlugin and no caches.default on Deno: the route still works.
    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.router.get('/plain', {
      handler: (ctx) => ctx.response.json({ ok: true }),
      middleware: [cacheApiMiddleware()],
    });

    await app.start();
    const response = await get(app, '/plain');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-cache-api')).toBe('BYPASS');
    expect(await response.json()).toEqual({ ok: true });

    await app.stop();
  });

  it('writes inline when the bindings capability is absent, so nothing is dropped', async () => {
    const cache = new FakeCacheApi();
    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.router.get('/x', {
      handler: (ctx) => ctx.response.json({ ok: true }),
      middleware: [cacheApiMiddleware({ cache })],
    });

    await app.start();
    const miss = await get(app, '/x');
    await miss.body?.cancel();

    // No waitUntil host to hand it to, so the write completed before the
    // response was returned.
    expect(cache.puts).toHaveLength(1);

    const hit = await get(app, '/x');
    expect(hit.headers.get('x-cache-api')).toBe('HIT');
    expect(await hit.json()).toEqual({ ok: true });

    await app.stop();
  });
});
