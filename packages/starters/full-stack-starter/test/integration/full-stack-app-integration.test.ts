/**
 * @module full-stack-starter integration tests — load-bearing for plugin collisions
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFullStackApp } from '../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import { CachePlugin } from '@hono-enterprise/cache-plugin';

describe('full-stack-starter / integration (load-bearing)', () => {
  it('boots all ~22 plugins in one kernel and inject() returns 200', async () => {
    // This is the only test that can catch duplicate name/provider throws among
    // the five plugins that register imperatively with provides: [] (invisible to buildProviderIndex)
    const app = createFullStackApp();
    app.get('/test', () => 'ok');

    await app.start();

    // Verify a route works through the entire composition
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ok');
  });

  // C7: errorHandler must be outermost — route handler throw yields RFC 7807
  it('errorHandler catches route handler throws and formats RFC 7807 body', async () => {
    const app = createFullStackApp();
    app.get('/throw-route', () => {
      throw new Error('route error');
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/throw-route' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('"type":"http://example.com/errors/internal-server-error"');
    expect(response.body).toContain('"status":500');
    expect(response.body).toContain('"detail":"route error"');
    expect(response.body).not.toContain('"message":');
  });

  // C7: middleware at priority 100 must also be caught by errorHandler (the real regression guard)
  it('errorHandler catches middleware-level throws (priority 100 middleware)', async () => {
    const app = createFullStackApp();
    app.middleware.add(
      (_ctx, _next) => {
        throw new Error('middleware error');
      },
      { priority: 100, name: 'test-middleware' },
    );
    app.get('/test', () => 'ok');

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('"type":"http://example.com/errors/internal-server-error"');
    expect(response.body).toContain('"status":500');
    expect(response.body).toContain('"detail":"middleware error"');
    expect(response.body).not.toContain('"message":');
  });

  // §3.2.1: escape hatch — caller can register named CachePlugin after app creation
  it('allows registering CachePlugin with name after app creation without duplicate throw', async () => {
    const app = createFullStackApp();
    app.get('/test', () => 'ok');

    // Before start: register a named cache plugin as documented escape hatch
    app.register(CachePlugin({ name: 'session' }));

    await app.start();

    // The bare token should not be present (named instance uses derived token)
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(false);
    // The app should still work normally
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
});
