/**
 * @module full-stack-starter integration tests — load-bearing for plugin collisions
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFullStackApp } from '../../src/index.ts';
import type { IRequestContext } from '@hono-enterprise/common';
import { CachePlugin } from '@hono-enterprise/cache-plugin';
import { CAPABILITIES, createCapabilityToken } from '@hono-enterprise/common';

describe('full-stack-starter / integration (load-bearing)', () => {
  it('boots all ~22 plugins in one kernel and inject() returns 200', async () => {
    // This is the only test that can catch duplicate name/provider throws among
    // the five plugins that register imperatively with provides: [] (invisible to buildProviderIndex)
    const app = createFullStackApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    await app.start();

    // Verify a route works through the entire composition
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ok');
  });

  // C7: errorHandler must be outermost — route handler throw yields RFC 7807
  it('errorHandler catches route handler throws and formats RFC 7807 body', async () => {
    const app = createFullStackApp();
    app.router.get('/throw-route', () => {
      throw new Error('route error');
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/throw-route' });

    expect(response.statusCode).toBe(500);
    // Current rfc7807Formatter produces type like "https://hono-enterprise.dev/errors/500"
    expect(response.body).toContain('"type":"https://hono-enterprise.dev/errors/500"');
    expect(response.body).toContain('"status":500');
    expect(response.body).toContain('"detail":"route error"');
    expect(response.body).not.toContain('"message":');
  });

  // C7: middleware at priority 100 must also be caught by errorHandler (the real regression guard)
  it('errorHandler catches middleware-level throws (priority 100 middleware)', async () => {
    const app = createFullStackApp();
    app.middleware.add(
      (_ctx: IRequestContext, _next) => {
        throw new Error('middleware error');
      },
      { priority: 100, name: 'test-middleware' },
    );
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(500);
    // Current rfc7807Formatter produces type like "https://hono-enterprise.dev/errors/500"
    expect(response.body).toContain('"type":"https://hono-enterprise.dev/errors/500"');
    expect(response.body).toContain('"status":500');
    expect(response.body).toContain('"detail":"middleware error"');
    expect(response.body).not.toContain('"message":');
  });

  // §3.2.1: escape hatch — caller can register named CachePlugin after app creation
  it('allows registering CachePlugin with name after app creation without duplicate throw', async () => {
    const app = createFullStackApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    // Before start: register a named cache plugin as documented escape hatch
    app.register(CachePlugin({ name: 'session' }));

    await app.start();

    // The bare CAPABILITIES.CACHE may be present from default plugins; the important
    // thing is that the named plugin was registered without throwing a duplicate.
    // Verify the named cache token exists instead.
    const sessionToken = createCapabilityToken('cache.session');
    expect(app.services.has(sessionToken)).toBe(true);

    // The app should still work normally
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
  // The full set plus every gated arm in ONE kernel — the only check that catches a
  // duplicate name or provider among the plugins that register imperatively.
  it('boots with every gated arm supplied and inject() returns 200', async () => {
    const app = createFullStackApp({
      di: {},
      realtime: { websocket: {}, sse: {}, backplane: { transport: 'messaging' } },
    });
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    await app.start();

    expect(app.services.has(CAPABILITIES.DI_CONTAINER)).toBe(true);
    expect(app.services.has(CAPABILITIES.WEBSOCKET)).toBe(true);
    expect(app.services.has(CAPABILITIES.SSE)).toBe(true);
    expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(true);

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ok');
  });
});
