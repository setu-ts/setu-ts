/**
 * End-to-end parity test: real kernel application through the Hono-backed
 * router, middleware pipeline, and inject().
 *
 * Verifies that M22's Hono delegation is transparent — the pipeline,
 * middleware priorities, short-circuit semantics, and inject() all behave
 * identically to pre-M22.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IPlugin, IPluginContext, MiddlewareFunction } from '@hono-enterprise/common';

import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

describe('Hono dispatch parity — inject() round-trip', () => {
  it('inject() round-trips a GET request through Hono-backed router', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();

    const handler = () => ({ __handlerResult: true } as never);
    app.router.get('/hello', handler);

    const result = await app.inject({ method: 'GET', url: 'http://localhost/hello' });
    expect(result.statusCode).toBe(200);
    await app.stop();
  });

  it('inject() round-trips a POST request with JSON body', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();

    app.router.post('/echo', {
      handler: async (ctx) => {
        const body = await ctx.request.json<Record<string, unknown>>();
        return ctx.response.json(body).__handlerResult as never;
      },
    });

    const result = await app.inject({
      method: 'POST',
      url: 'http://localhost/echo',
      body: { greeting: 'world' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ greeting: 'world' });
    await app.stop();
  });
});

describe('Hono dispatch parity — middleware priority', () => {
  it('global middleware at priority 20 wraps priority 300', async () => {
    const order: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'mw20',
          version: '1.0.0',
          priority: 20,
          register(ctx: IPluginContext) {
            ctx.middleware.add(
              async (_ctx, nextFn) => {
                order.push('20-in');
                await nextFn();
                order.push('20-out');
              },
              { priority: 20 },
            );
          },
        },
        {
          name: 'mw300',
          version: '1.0.0',
          priority: 300,
          register(ctx: IPluginContext) {
            ctx.middleware.add(
              async (_ctx, nextFn) => {
                order.push('300-in');
                await nextFn();
                order.push('300-out');
              },
              { priority: 300 },
            );
          },
        },
      ],
    });
    await app.start();

    app.router.get('/test', () => ({ __handlerResult: true } as never));

    await app.inject({ method: 'GET', url: 'http://localhost/test' });
    // Outermost-first inbound, outermost-last outbound
    expect(order).toEqual(['20-in', '300-in', '300-out', '20-out']);
    await app.stop();
  });
});

describe('Hono dispatch parity — short-circuit route middleware', () => {
  it('short-circuiting route middleware stops the handler', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();

    let handlerCalled = false;
    const abortMw: MiddlewareFunction = (ctx) => {
      ctx.response.status(401).json({ error: 'unauthorized' });
      // Does NOT call next() — short-circuits.
    };

    app.router.get('/protected', {
      handler: () => {
        handlerCalled = true;
        return { __handlerResult: true } as never;
      },
      middleware: [abortMw],
    });

    const result = await app.inject({ method: 'GET', url: 'http://localhost/protected' });
    expect(result.statusCode).toBe(401);
    expect(handlerCalled).toBe(false);
    await app.stop();
  });
});

describe('Hono dispatch parity — %zz → 400 (not 404/500)', () => {
  it('malformed percent-escape returns 400', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();

    app.router.get('/users/:id', () => ({ __handlerResult: true } as never));

    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/users/%zz',
    });
    expect(result.statusCode).toBe(400);
    await app.stop();
  });
});

describe('Hono dispatch parity — snapshot() fidelity', () => {
  it('inject() returns exact snapshot()-derived InjectResponse', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();

    app.router.get('/data', {
      handler: (ctx) => {
        return ctx.response
          .status(201)
          .header('x-custom', 'value')
          .json({ ok: true }).__handlerResult as never;
      },
    });

    const result = await app.inject({ method: 'GET', url: 'http://localhost/data' });
    expect(result.statusCode).toBe(201);
    expect(result.headers.get('x-custom')).toBe('value');
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(result.json()).toEqual({ ok: true });
    await app.stop();
  });
});
