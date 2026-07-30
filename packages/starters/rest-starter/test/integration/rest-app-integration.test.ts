/**
 * @module rest-starter integration tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createRestApp } from '../../src/index.ts';
import type { IRequestContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { CachePlugin } from '@hono-enterprise/cache-plugin';

describe('rest-starter / integration', () => {
  it('route handler returns expected body via inject()', async () => {
    const app = createRestApp();
    app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

    await app.start(); // Must start to set up runtime and HTTP adapter
    const response = await app.inject({ method: 'GET', url: '/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  // C7: errorHandler must be outermost (priority 0) — both throw sites yield RFC 7807 body
  // with "detail" field and NO "message" field
  it('errorHandler catches route handler throws and formats RFC 7807 body', async () => {
    const app = createRestApp();
    app.router.get('/throw', () => {
      throw new Error('test route error');
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(500);
    // Parse the JSON body to check fields
    const body = JSON.parse(response.body!);
    expect(body.type).toContain('internal-server-error');
    expect(body.detail).toBe('test route error');
    // RFC 7807 Problem Details MUST NOT have a "message" field
    expect(Object.keys(body).includes('message')).toBe(false);
  });

  // C7: middleware registered at priority 100 must also be caught by errorHandler
  // This is the critical test that fails if priority:0 is dropped
  it('errorHandler catches middleware-level throws (priority 100 middleware)', async () => {
    const app = createRestApp();
    // Add a middleware that throws at priority 100 (inside default priority band of 500)
    app.middleware.add(
      (_ctx: IRequestContext, _next) => {
        throw new Error('test middleware error');
      },
      { priority: 100, name: 'test-middleware' },
    );
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body!);
    expect(body.detail).toBe('test middleware error');
    // Must not have a "message" field per RFC 7807
    expect(Object.keys(body).includes('message')).toBe(false);
  });

  // §3.2.1: caller can register additional plugins after createRestApp returns (escape hatch)
  it('allows registering CachePlugin with name after app creation without duplicate throw', async () => {
    const app = createRestApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

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
