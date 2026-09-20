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

  it('a SUCCEEDING handler at a route-chain terminal records ok with its status', async () => {
    // The ordinary shape for any route declaring middleware, and the arm the
    // suite never drove: every existing route-chain case either
    // short-circuited or threw, so the terminal's success observation was
    // exercised by nothing.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.router.post('/guarded', {
              handler: (c) => c.response.status(201).json({ created: true }),
              middleware: [(_c, next) => next()],
            });
          },
        },
      ],
      diagnostics: { labels: { routes: ['/guarded'] } },
    });
    await app.start();
    const response = await app.inject({ method: 'POST', url: '/guarded' });
    expect(response.statusCode).toBe(201);
    const events = app.diagnostics!.read(0).events;
    const handler = events.find((event) => event.stage === 'handler');
    expect(handler?.outcome).toBe('ok');
    expect(handler?.statusCode).toBe(201);
    // The handler record names the route node, which carries the allowlisted
    // pattern — so a consumer can tell WHICH route was served.
    const routeNode = app.diagnostics!.snapshot().nodes.find(
      (node) => node.kind === 'route',
    );
    expect(routeNode?.label).toBe('/guarded');
    expect(handler?.nodeId).toBe(routeNode?.id);
    const stage = events.find((event) => event.stage === 'route');
    expect(stage?.outcome).toBe('ok');
    await app.stop();
  });

  it('a handler throwing at a ROUTE CHAIN terminal records error on both stages', async () => {
    // A different code path from the empty-chain bypass: the terminal runs
    // inside `executeChain`, so the handler observation and the stage
    // observation are two separate arms and only the bypass one was driven.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/guarded-boom', {
              handler: () => {
                throw new Error('terminal exploded');
              },
              middleware: [(_c, next) => next()],
            });
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/guarded-boom' });
    expect(response.statusCode).toBe(500);
    const events = app.diagnostics!.read(0).events;
    const handler = events.find((event) => event.stage === 'handler');
    expect(handler?.outcome).toBe('error');
    // The middleware stage that awaited the terminal records the error too —
    // the throw propagated through it rather than being absorbed.
    const stage = events.find((event) => event.stage === 'route');
    expect(stage?.outcome).toBe('error');
    expect(stage?.parentOperationId).toBe(
      events.find((event) => event.stage === 'request')?.operationId,
    );
    await app.stop();
  });

  it('a REJECTING async handler on the empty-chain bypass records an error and still propagates', async () => {
    // The bypass returns the handler's own promise and observes it through a
    // DETACHED `.then`, which is the one place collector code runs outside the
    // request's own promise chain. Nothing exercised that arm, so a rejection
    // there would have been unobserved.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/async-boom', () => Promise.reject(new Error('async exploded')));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/async-boom' });
    // The rejection reached the kernel's own fallback, unchanged by observation.
    expect(response.statusCode).toBe(500);

    const events = app.diagnostics!.read(0).events;
    const handler = events.find((event) => event.stage === 'handler');
    expect(handler?.outcome).toBe('error');
    // An errored handler carries no status: the record describes the boundary,
    // not the response the kernel later wrote.
    expect(handler?.statusCode).toBeUndefined();
    const request = events.find((event) => event.stage === 'request');
    expect(request?.outcome).toBe('error');
    expect(request?.statusCode).toBe(500);
    expect(handler?.parentOperationId).toBe(request?.operationId);
    await app.stop();
  });

  it('a THROWING request hook records an error stage and re-throws unchanged', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onRequest(() => {
              throw new Error('hook exploded');
            });
            ctx.router.get('/hooked', (c) => c.response.json({ ok: true }));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hooked' });
    expect(response.statusCode).toBe(500);

    const events = app.diagnostics!.read(0).events;
    const requestHook = events.find((event) => event.stage === 'request-hook');
    expect(requestHook?.outcome).toBe('error');
    // The handler never ran, so no handler record was invented for it.
    expect(events.some((event) => event.stage === 'handler')).toBe(false);
    await app.stop();
  });
});
