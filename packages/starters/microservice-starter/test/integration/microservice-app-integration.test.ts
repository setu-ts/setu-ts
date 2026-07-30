/**
 * @module microservice-starter integration tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMicroserviceApp } from '../../src/index.ts';
import type { IRequestContext } from '@hono-enterprise/common';

describe('microservice-starter / integration', () => {
  it('route handler returns expected body via inject()', async () => {
    const app = createMicroserviceApp();
    app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  // C7: errorHandler must be outermost — both throw sites yield RFC 7807 body
  it('errorHandler catches route handler throws and formats RFC 7807 body', async () => {
    const app = createMicroserviceApp();
    app.router.get('/throw-route', () => {
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

  // C7: middleware registered at priority 100 must also be caught by errorHandler
  it('errorHandler catches middleware-level throws (priority 100 middleware)', async () => {
    const app = createMicroserviceApp();
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
    expect(response.body).toContain('"type":"http://example.com/errors/internal-server-error"');
    expect(response.body).toContain('"status":500');
    expect(response.body).toContain('"detail":"middleware error"');
    expect(response.body).not.toContain('"message":');
  });
});
