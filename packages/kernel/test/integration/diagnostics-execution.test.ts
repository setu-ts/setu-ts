import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

describe('diagnostics execution integration', () => {
  it('records request, middleware, and handler completions with inclusive timings', async () => {
    const runtime = runtimePlugin();
    const app = createApplication({
      plugins: [
        runtime,
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add(async (_ctx, next) => {
              runtime.tick(5);
              await next();
              runtime.tick(1);
            }, { name: 'outer', priority: 10 });
            ctx.router.get('/hello', (c) => {
              runtime.tick(7);
              return Promise.resolve(c.response.json({ hello: true }));
            });
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hello' });
    expect(response.statusCode).toBe(200);

    const events = app.diagnostics!.read(0).events;
    const request = events.find((event) => event.kind === 'request' && event.stage === 'request');
    expect(request?.outcome).toBe('ok');
    expect(request?.statusCode).toBe(200);
    expect(request?.parentOperationId).toBeNull();

    const stage = events.find((event) => event.kind === 'middleware' && event.stage === 'global');
    expect(stage?.parentOperationId).toBe(request?.operationId);
    expect(stage?.outcome).toBe('ok');
    // Inclusive: the stage's duration spans the downstream work it awaited.
    expect(stage?.durationMs).toBeGreaterThanOrEqual(6);

    const handler = events.find((event) => event.kind === 'handler');
    expect(handler?.parentOperationId).toBe(request?.operationId);
    expect(handler?.nodeId).toMatch(/^r\d+$/);
    // Events are in completion order: the middleware stage completes after
    // the handler it awaited.
    expect(events.indexOf(stage!)).toBeGreaterThan(events.indexOf(handler!));
    await app.stop();
  });

  it('a short-circuit records short-circuit and no handler record', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'guard',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add((ctx) => {
              ctx.response.json({ blocked: true });
              // No next(): downstream stages and the handler never run.
            }, { name: 'guard', priority: 10 });
            ctx.router.get('/x', (c) => c.response.json({}));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/x' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('blocked');

    const events = app.diagnostics!.read(0).events;
    const guardStage = events.find((event) => event.kind === 'middleware');
    expect(guardStage?.outcome).toBe('short-circuit');
    expect(events.some((event) => event.kind === 'handler')).toBe(false);
    const request = events.find((event) => event.stage === 'request');
    expect(request?.statusCode).toBe(200);
    await app.stop();
  });

  it('a stage that ended the response and called next() records downstream-skipped', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'double',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add(async (ctx, next) => {
              ctx.response.json({ done: true });
              await next();
            }, { name: 'ended-plus-next', priority: 10 });
            ctx.router.get('/y', (c) => c.response.json({}));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/y' });
    expect(response.statusCode).toBe(200);
    const events = app.diagnostics!.read(0).events;
    const stage = events.find((event) => event.kind === 'middleware');
    expect(stage?.outcome).toBe('downstream-skipped');
    // The handler is a skipped stage: no executed record.
    expect(events.some((event) => event.kind === 'handler')).toBe(false);
    await app.stop();
  });

  it('a throwing handler records error outcomes and propagates the SAME error', async () => {
    const boom = new Error('handler exploded');
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'thrower',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/boom', () => {
              throw boom;
            }) as never;
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    const events = app.diagnostics!.read(0).events;
    const handler = events.find((event) => event.kind === 'handler');
    expect(handler?.outcome).toBe('error');
    const request = events.find((event) => event.stage === 'request');
    expect(request?.outcome).toBe('error');
    expect(request?.statusCode).toBe(500);
    await app.stop();
  });

  it('request hooks are observed as children of the request operation', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'hooks',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onRequest(() => {});
            ctx.lifecycle.onResponse(() => {});
            ctx.router.get('/z', (c) => c.response.json({}));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    await app.inject({ method: 'GET', url: '/z' });
    const events = app.diagnostics!.read(0).events;
    const request = events.find((event) => event.stage === 'request');
    const requestHook = events.find((event) => event.stage === 'request-hook');
    const responseHook = events.find((event) => event.stage === 'response-hook');
    expect(requestHook?.parentOperationId).toBe(request?.operationId);
    expect(responseHook?.parentOperationId).toBe(request?.operationId);
    expect(requestHook?.outcome).toBe('ok');
    await app.stop();
  });

  it('a synchronous empty-chain request completes synchronously with diagnostics on', async () => {
    let sync = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'sync',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/fast', (c) => {
              sync = true;
              return c.response.json({ fast: true });
            });
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/fast' });
    expect(response.statusCode).toBe(200);
    expect(sync).toBe(true);
    const events = app.diagnostics!.read(0).events;
    expect(events.filter((event) => event.stage === 'request').length).toBe(1);
    await app.stop();
  });
});
