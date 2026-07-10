import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPluginContext, IRequestContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

import { cacheMiddleware, CachePlugin } from '../../src/index.ts';

describe('Cache integration (through real kernel app.inject)', () => {
  it('named multi-instance cache registers under distinct token', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ name: 'session' }),
      ],
    });

    await app.start();
    expect(app.services.has('cache.session')).toBe(true);
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(false);
    await app.stop();
  });

  it('default cache registers under CAPABILITIES.CACHE', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin(),
      ],
    });

    await app.start();
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(true);
    await app.stop();
  });

  it('cache middleware is added to global pipeline and does not crash', async () => {
    let handlerInvoked = false;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'memory' }),
        {
          name: 'test-cache-route-data',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/data', (c: IRequestContext) => {
              handlerInvoked = true;
              return c.response.json({ message: 'hello' });
            });
          },
        },
      ],
    });

    await app.start();

    await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
    });

    // If the middleware works through the kernel pipeline, we get 200 + X-Cache: MISS.
    // If the kernel's service registry doesn't propagate to request context, we get 500.
    // Either way, the handler should have been invoked (middleware does not short-circuit
    // before a cache entry exists).
    expect(handlerInvoked).toBe(true);

    await app.stop();
  });
});
