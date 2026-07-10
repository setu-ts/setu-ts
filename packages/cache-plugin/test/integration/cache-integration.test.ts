import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPluginContext, IRequestContext } from '@hono-enterprise/common';

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
    expect(app.services.has('cache')).toBe(false);
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
    expect(app.services.has('cache')).toBe(true);
    await app.stop();
  });

  it('caches JSON route: MISS then HIT with identical body and handler counter === 1', async () => {
    let handlerCallCount = 0;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'memory' }),
        {
          name: 'test-json-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/data', (_c: IRequestContext) => {
              handlerCallCount++;
              return _c.response.json({ message: 'hello', count: handlerCallCount });
            });
          },
        },
      ],
    });

    await app.start();

    // First request — should be a MISS.
    const res1 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    const body1 = res1.json<{ message: string; count: number }>();
    expect(body1.message).toBe('hello');
    expect(body1.count).toBe(1);

    // Second request — should be a HIT with identical body.
    const res2 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    const body2 = res2.json<{ message: string; count: number }>();
    expect(body2).toEqual(body1);

    // Handler should only have been invoked once.
    expect(handlerCallCount).toBe(1);
    // Content-type should match on both responses.
    expect(res1.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res2.headers.get('content-type')).toBe('application/json; charset=utf-8');

    await app.stop();
  });

  it('caches text/html route: MISS then HIT with identical body and handler counter === 1', async () => {
    let handlerCallCount = 0;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'memory' }),
        {
          name: 'test-html-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/page', (_c: IRequestContext) => {
              handlerCallCount++;
              const html = '<html><body>Hello</body></html>';
              // Set content-type AFTER text() since text() overwrites to text/plain.
              _c.response.text(html);
              _c.response.header('content-type', 'text/html; charset=utf-8');
              return { __handlerResult: true } as import('@hono-enterprise/common').HandlerResult;
            });
          },
        },
      ],
    });

    await app.start();

    // First request — should be a MISS.
    const res1 = await app.inject({
      method: 'GET',
      url: 'http://localhost/page',
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers.get('x-cache')).toBe('MISS');
    expect(res1.body).toBe('<html><body>Hello</body></html>');

    // Second request — should be a HIT with identical body.
    const res2 = await app.inject({
      method: 'GET',
      url: 'http://localhost/page',
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(res2.body).toBe(res1.body);

    // Handler should only have been invoked once.
    expect(handlerCallCount).toBe(1);
    // Content-type should match on both responses.
    expect(res1.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res2.headers.get('content-type')).toBe('text/html; charset=utf-8');

    await app.stop();
  });
});
