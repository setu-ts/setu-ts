/**
 * Concurrent cache-miss behaviour through the real kernel request path.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { cacheMiddleware, CachePlugin } from '../../src/index.ts';

describe('cache middleware stampede protection', () => {
  it('keeps the existing sequential MISS then HIT contract', async () => {
    let calls = 0;
    const app = createCacheApp(() => ++calls);
    await app.start();

    const miss = await app.inject({ method: 'GET', url: 'http://localhost/expensive' });
    const hit = await app.inject({ method: 'GET', url: 'http://localhost/expensive' });

    expect(miss.headers.get('x-cache')).toBe('MISS');
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(hit.body).toBe(miss.body);
    expect(calls).toBe(1);
    await app.stop();
  });

  it('runs one delayed origin request for one hundred concurrent misses', async () => {
    let calls = 0;
    const app = createCacheApp(async () => {
      calls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return calls;
    });
    await app.start();

    const responses = await Promise.all(
      Array.from(
        { length: 100 },
        () => app.inject({ method: 'GET', url: 'http://localhost/expensive' }),
      ),
    );

    expect(calls).toBe(1);
    expect(responses.filter((response) => response.headers.get('x-cache') === 'MISS')).toHaveLength(
      1,
    );
    expect(responses.filter((response) => response.headers.get('x-cache') === 'COALESCED'))
      .toHaveLength(99);
    expect(new Set(responses.map((response) => response.body))).toEqual(new Set(['{"calls":1}']));
    await app.stop();
  });
});

function createCacheApp(origin: () => number | Promise<number>) {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      CachePlugin({ store: 'memory' }),
      {
        name: 'cache-stampede-route',
        version: '1.0.0',
        register(ctx: IPluginContext): void {
          ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
          ctx.router.get(
            '/expensive',
            async (request: IRequestContext) => request.response.json({ calls: await origin() }),
          );
        },
      },
    ],
  });
}
