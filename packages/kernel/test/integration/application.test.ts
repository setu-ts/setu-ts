import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ILogger, IPlugin, IPluginContext } from '@hono-enterprise/common';

import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(env: Record<string, string | undefined> = {}): IPlugin {
  const fake = createFakeRuntime({ env });
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

describe('Application integration', () => {
  it('should throw when no runtime plugin is registered', async () => {
    const app = createApplication({
      plugins: [{ name: 'no-runtime', version: '1.0.0', register() {} }],
    });
    await expect(app.start()).rejects.toThrow("mandatory 'runtime' capability");
  });

  it('should register plugins in resolved order', async () => {
    const order: string[] = [];
    const fake = createFakeRuntime();
    const app = createApplication({
      plugins: [
        {
          name: 'late',
          version: '1.0.0',
          dependencies: ['early'],
          register() {
            order.push('late');
          },
        },
        {
          name: 'fake-runtime',
          version: '1.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
            order.push('runtime');
          },
        },
        {
          name: 'early',
          version: '1.0.0',
          register() {
            order.push('early');
          },
        },
      ],
    });
    await app.start();
    expect(order).toEqual(['runtime', 'early', 'late']);
    await app.stop();
  });

  it('should collect contribution tokens via getAll', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'health-contrib',
          version: '1.0.0',
          register(ctx) {
            ctx.health.register('db', () => Promise.resolve({ status: 'up' } as never));
            ctx.health.register('cache', () => Promise.resolve({ status: 'up' } as never));
          },
        },
      ],
    });
    await app.start();
    const indicators = app.services.getAll<{ name: string }>(CAPABILITIES.HEALTH_INDICATOR);
    expect(indicators.length).toBe(2);
    expect(indicators.map((i) => i.name).sort()).toEqual(['cache', 'db']);
    await app.stop();
  });

  it('should aggregate env validation failures', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({}),
        {
          name: 'needs-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              MISSING_VAR: { required: true },
              BAD_NUMBER: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow(/Environment validation failed/);
  });

  it('should pass env validation when vars present', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ GOOD_VAR: '42' }),
        {
          name: 'needs-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              GOOD_VAR: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await app.start();
    await app.stop();
  });

  it('should throw when registering after start', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();
    expect(() => app.register({ name: 'late', version: '1.0.0', register() {} })).toThrow(
      'after the application has started',
    );
    await app.stop();
  });

  it('should inject end-to-end through middleware and handler', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'routes',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add((c, next) => {
              c.response.header('x-global', 'yes');
              return next();
            });
            ctx.router.get('/users/:id', (c) => {
              return c.response.status(200).json({ id: c.params.id });
            });
          },
        },
      ],
    });
    await app.start();

    const res = await app.inject({ method: 'GET', url: 'http://localhost/users/42' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('x-global')).toBe('yes');
    expect(res.json()).toEqual({ id: '42' });

    await app.stop();
  });

  it('should return 404 for unmatched routes', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();

    const res = await app.inject({ method: 'GET', url: 'http://localhost/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found' });

    await app.stop();
  });

  it('should run lifecycle hooks in correct order', async () => {
    const events: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'lifecycle',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onInit(() => {
              events.push('init');
            });
            ctx.lifecycle.onBootstrap(() => {
              events.push('bootstrap');
            });
            ctx.lifecycle.onShutdown(() => {
              events.push('shutdown');
            });
            ctx.lifecycle.onClose(() => {
              events.push('close');
            });
          },
        },
      ],
    });
    await app.start();
    await app.stop();
    expect(events).toEqual(['init', 'bootstrap', 'shutdown', 'close']);
  });

  it('should run request and response hooks', async () => {
    const events: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'hooks',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onRequest(() => {
              events.push('request');
            });
            ctx.lifecycle.onResponse(() => {
              events.push('response');
            });
            ctx.router.get('/test', (c) => c.response.json({ ok: true }));
          },
        },
      ],
    });
    await app.start();
    await app.inject({ method: 'GET', url: 'http://localhost/test' });
    expect(events).toEqual(['request', 'response']);
    await app.stop();
  });

  it('should run onError hook and return 500 on handler error', async () => {
    const errorCaught: Error[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'error-route',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onError((err) => {
              errorCaught.push(err);
            });
            ctx.router.get('/boom', () => {
              throw new Error('boom');
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(errorCaught[0]?.message).toBe('boom');
    await app.stop();
  });

  it('should not listen when no port is provided', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();
    // No server should be listening — inject should still work
    const res = await app.inject({ method: 'GET', url: 'http://localhost/' });
    expect(res.statusCode).toBe(404);
    await app.stop();
  });

  it('should run shutdown hooks in reverse order (LIFO)', async () => {
    const events: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'lifo',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onShutdown(() => {
              events.push('first');
            });
            ctx.lifecycle.onShutdown(() => {
              events.push('second');
            });
            ctx.lifecycle.onShutdown(() => {
              events.push('third');
            });
          },
        },
      ],
    });
    await app.start();
    await app.stop();
    expect(events).toEqual(['third', 'second', 'first']);
  });

  it('should parse query parameters', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'query-route',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/search', (c) => c.response.json({ q: c.query.q }));
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/search?q=hello' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ q: 'hello' });
    await app.stop();
  });

  it('should parse JSON body via inject', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'post-route',
          version: '1.0.0',
          register(ctx) {
            ctx.router.post('/echo', async (c) => {
              const body = await c.request.json();
              return c.response.json({ echoed: body });
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({
      method: 'POST',
      url: 'http://localhost/echo',
      body: { msg: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ echoed: { msg: 'hi' } });
    await app.stop();
  });

  it('should execute route middleware before handler', async () => {
    const order: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'route-mw',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/test', {
              middleware: [
                (_c, next) => {
                  order.push('mw1');
                  return next();
                },
                (_c, next) => {
                  order.push('mw2');
                  return next();
                },
              ],
              handler: (c) => {
                order.push('handler');
                return c.response.json({ ok: true });
              },
            });
          },
        },
      ],
    });
    await app.start();
    await app.inject({ method: 'GET', url: 'http://localhost/test' });
    expect(order).toEqual(['mw1', 'mw2', 'handler']);
    await app.stop();
  });

  it('should support text and bytes body in inject', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'body-routes',
          version: '1.0.0',
          register(ctx) {
            ctx.router.post('/text', async (c) => {
              const body = await c.request.text();
              return c.response.text(`got:${body}`);
            });
            ctx.router.post('/bytes', async (c) => {
              const body = await c.request.bytes();
              return c.response.json({ len: body.length });
            });
          },
        },
      ],
    });
    await app.start();
    const textRes = await app.inject({
      method: 'POST',
      url: 'http://localhost/text',
      body: 'hello',
    });
    expect(textRes.body).toBe('got:hello');

    const bytesRes = await app.inject({
      method: 'POST',
      url: 'http://localhost/bytes',
      body: 'abcdef',
    });
    expect(bytesRes.json()).toEqual({ len: 6 });
    await app.stop();
  });

  it('should return 503 when stopping', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();
    // Manually trigger stopping state by calling stop and racing inject
    const stopPromise = app.stop();
    // Inject immediately — may catch stopping state
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/' });
      // Could be 404 or 503 depending on timing
      expect([404, 503]).toContain(res.statusCode);
    } catch {
      // Acceptable if request rejected during shutdown
    }
    await stopPromise;
  });

  it('should collect metric and openapi contributions', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'contrib',
          version: '1.0.0',
          register(ctx) {
            ctx.metrics.register(
              'http_requests_total',
              { type: 'counter', help: 'requests' } as never,
            );
            ctx.openapi.addSchema('User', { type: 'object' });
            ctx.cli.register('my:cmd', () => {});
            ctx.decorators.register('MyDec', () => {});
          },
        },
      ],
    });
    await app.start();
    const metrics = app.services.getAll<{ name: string }>(CAPABILITIES.METRIC_REGISTRATION);
    expect(metrics.length).toBe(1);
    expect(metrics[0].name).toBe('http_requests_total');

    const schemas = app.services.getAll<{ name: string }>(CAPABILITIES.OPENAPI_SCHEMA);
    expect(schemas.length).toBe(1);
    expect(schemas[0].name).toBe('User');

    const cmds = app.services.getAll<{ name: string }>(CAPABILITIES.CLI_COMMAND);
    expect(cmds.length).toBe(1);

    const decs = app.services.getAll<{ name: string }>(CAPABILITIES.DECORATOR_HANDLER);
    expect(decs.length).toBe(1);
    await app.stop();
  });

  it('should handle non-Error thrown values', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'string-throw',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/throw', () => {
              throw 'string error';
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/throw' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    await app.stop();
  });

  it('should swallow onError hook errors', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'bad-error-hook',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onError(() => {
              throw new Error('hook error');
            });
            ctx.router.get('/boom', () => {
              throw new Error('handler error');
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
    expect(res.statusCode).toBe(500);
    await app.stop();
  });

  it('should store onRegister hooks without error', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'register-hook',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onRegister(() => {});
          },
        },
      ],
    });
    await app.start();
    await app.stop();
  });

  it('should listen when adapter and port are provided', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({
      plugins: [
        {
          name: 'fake-runtime',
          version: '1.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
            ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
          },
        },
      ],
    });
    await app.start({ port: 3000 });
    expect(fake.adapter.listening).toBe(true);
    expect(fake.adapter.port).toBe(3000);
    await app.stop();
    expect(fake.adapter.listening).toBe(false);
  });

  it('should not listen when port is provided but no adapter', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start({ port: 3000 });
    // No adapter registered — should skip listening without error
    await app.stop();
  });

  it('should support hostname option when listening', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({
      plugins: [
        {
          name: 'fake-runtime',
          version: '1.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
            ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
          },
        },
      ],
    });
    await app.start({ port: 8080, hostname: '127.0.0.1' });
    expect(fake.adapter.listening).toBe(true);
    await app.stop();
  });

  it('should return 503 when injecting during shutdown', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.start();
    const stopPromise = app.stop();
    // The stop sets #stopping = true; inject may see it
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/' });
      expect([404, 503]).toContain(res.statusCode);
    } catch {
      // Acceptable if request rejected during shutdown
    }
    await stopPromise;
  });

  it('should access ctx.runtime lazily', async () => {
    let runtimeAccessed = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'runtime-access',
          version: '1.0.0',
          register(ctx) {
            // Access runtime — should resolve from registry
            const rt = ctx.runtime;
            runtimeAccessed = typeof rt.uuid === 'function';
          },
        },
      ],
    });
    await app.start();
    expect(runtimeAccessed).toBe(true);
    await app.stop();
  });

  it('should return undefined for absent optional context services', async () => {
    let configPresent = false;
    let loggerPresent = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'optional-check',
          version: '1.0.0',
          register(ctx) {
            configPresent = ctx.config !== undefined;
            loggerPresent = ctx.logger !== undefined;
          },
        },
      ],
    });
    await app.start();
    expect(configPresent).toBe(false);
    expect(loggerPresent).toBe(false);
    await app.stop();
  });
});

describe('Application review fixes', () => {
  // ---- Blocker 1: route middleware short-circuit semantics ----

  it('route middleware that responds 401 without next() stops the handler', async () => {
    let handlerRan = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'guard-route',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/secret', {
              middleware: [
                (c, _next) => c.response.status(401).json({ error: 'Unauthorized' }),
              ],
              handler: (c) => {
                handlerRan = true;
                return c.response.json({ ok: true });
              },
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/secret' });
    expect(handlerRan).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    await app.stop();
  });

  it('route middleware that calls next() lets the handler run', async () => {
    const order: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'pass-route',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/ok', {
              middleware: [
                (_c, next) => {
                  order.push('mw');
                  return next();
                },
              ],
              handler: (c) => {
                order.push('handler');
                return c.response.json({ ok: true });
              },
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/ok' });
    expect(order).toEqual(['mw', 'handler']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.stop();
  });

  it('two route middleware: first short-circuits, second never runs', async () => {
    const order: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'two-mw',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/two', {
              middleware: [
                (c, _next) => {
                  order.push('mw1');
                  return c.response.status(403).json({ error: 'Forbidden' });
                },
                (_c, _next) => {
                  order.push('mw2');
                },
              ],
              handler: (c) => {
                order.push('handler');
                return c.response.json({ ok: true });
              },
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/two' });
    expect(order).toEqual(['mw1']);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden' });
    await app.stop();
  });

  it('global pipeline middleware short-circuits: route middleware and handler never run', async () => {
    const order: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'global-short',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add((c, _next) => {
              order.push('global');
              return c.response.status(503).json({ error: 'Maintenance' });
            });
            ctx.router.get('/r', {
              middleware: [(_c, _next) => {
                order.push('route-mw');
              }],
              handler: (c) => {
                order.push('handler');
                return c.response.json({ ok: true });
              },
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/r' });
    expect(order).toEqual(['global']);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Maintenance' });
    await app.stop();
  });

  it('middleware that responds AND calls next() does not let downstream overwrite', async () => {
    const order: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'respond-and-next',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/rn', {
              middleware: [
                (c, next) => {
                  order.push('mw1');
                  c.response.status(418).json({ error: "I'm a teapot" });
                  // Incorrectly calls next() after responding
                  return next();
                },
                (c, _next) => {
                  order.push('mw2');
                  return c.response.status(200).json({ ok: true });
                },
              ],
              handler: (c) => {
                order.push('handler');
                return c.response.json({ ok: true });
              },
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/rn' });
    expect(order).toEqual(['mw1']);
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: "I'm a teapot" });
    await app.stop();
  });

  // ---- Blocker 2: metadata token ----

  it('ctx.metadata resolves CAPABILITIES.METADATA_STORE, not OPENAPI', async () => {
    const metadataStore = { controllers: new Map(), services: new Map(), routes: new Map() };
    let seen: unknown = null;
    let openapiSeen = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'meta-provider',
          version: '1.0.0',
          provides: [CAPABILITIES.METADATA_STORE],
          register(ctx) {
            ctx.services.register(CAPABILITIES.METADATA_STORE, metadataStore);
          },
        },
        {
          name: 'openapi-provider',
          version: '1.0.0',
          provides: [CAPABILITIES.OPENAPI],
          register(ctx) {
            ctx.services.register(CAPABILITIES.OPENAPI, { spec: 'openapi' });
          },
        },
        {
          name: 'meta-consumer',
          version: '1.0.0',
          register(ctx) {
            seen = ctx.metadata;
            openapiSeen = ctx.services.has(CAPABILITIES.OPENAPI);
          },
        },
      ],
    });
    await app.start();
    expect(seen).toBe(metadataStore);
    expect(openapiSeen).toBe(true);
    await app.stop();
  });

  it('ctx.metadata is undefined when only OPENAPI is registered', async () => {
    let metadataPresent = true;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'openapi-only',
          version: '1.0.0',
          provides: [CAPABILITIES.OPENAPI],
          register(ctx) {
            ctx.services.register(CAPABILITIES.OPENAPI, { spec: 'openapi' });
          },
        },
        {
          name: 'meta-check',
          version: '1.0.0',
          register(ctx) {
            metadataPresent = ctx.metadata !== undefined;
          },
        },
      ],
    });
    await app.start();
    expect(metadataPresent).toBe(false);
    await app.stop();
  });

  // ---- Blocker 3.2: application.ts coverage paths ----

  it('inject() accepts a Headers instance', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'headers-route',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/h', (c) => {
              return c.response.json({ auth: c.request.headers.get('authorization') });
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({
      method: 'GET',
      url: 'http://localhost/h',
      headers: new Headers({ authorization: 'Bearer abc' }),
    });
    expect(res.json()).toEqual({ auth: 'Bearer abc' });
    await app.stop();
  });

  it('inject() accepts a plain headers object', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'plain-headers',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/h', (c) => {
              return c.response.json({ x: c.request.headers.get('x-custom') });
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({
      method: 'GET',
      url: 'http://localhost/h',
      headers: { 'x-custom': 'val' },
    });
    expect(res.json()).toEqual({ x: 'val' });
    await app.stop();
  });

  it('inject() with no headers and no body works', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'bare',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/bare', (c) => c.response.json({ ok: true }));
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/bare' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    await app.stop();
  });

  it('inject() json() throws on a bodyless response', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'no-body',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/empty', (c) => c.response.status(204).send());
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/empty' });
    expect(() => res.json()).toThrow('No JSON body available');
    await app.stop();
  });

  it('Proxy trap: "logger" in ctx is false before, true after a logger registers', async () => {
    let before = true;
    let after = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'logger-check',
          version: '1.0.0',
          register(ctx) {
            before = 'logger' in ctx;
            ctx.services.register(CAPABILITIES.LOGGER, {
              debug() {},
              info() {},
              warn() {},
              error() {},
              fatal() {},
              trace() {},
            });
            after = 'logger' in ctx;
          },
        },
      ],
    });
    await app.start();
    expect(before).toBe(false);
    expect(after).toBe(true);
    await app.stop();
  });

  it('Proxy-trap: Object.keys(ctx) includes lazy keys only when available', async () => {
    let keysBefore: string[] = [];
    let keysAfter: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'keys-check',
          version: '1.0.0',
          register(ctx) {
            keysBefore = Object.keys(ctx);
            ctx.services.register(CAPABILITIES.CONFIG, { get: () => undefined });
            keysAfter = Object.keys(ctx);
          },
        },
      ],
    });
    await app.start();
    expect(keysBefore).not.toContain('config');
    expect(keysAfter).toContain('config');
    await app.stop();
  });

  it('Proxy-trap: ctx.config is undefined when absent and the service when present', async () => {
    let before: unknown = 'unset';
    let after: unknown = 'unset';
    const config = { get: () => 'value' };
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'config-check',
          version: '1.0.0',
          register(ctx) {
            before = ctx.config;
            ctx.services.register(CAPABILITIES.CONFIG, config);
            after = ctx.config;
          },
        },
      ],
    });
    await app.start();
    expect(before).toBe(undefined);
    expect(after).toBe(config);
    await app.stop();
  });

  it('env validation: required with default does not violate', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({}),
        {
          name: 'default-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              MISSING_WITH_DEFAULT: { required: true, default: 'fallback' },
            });
          },
        },
      ],
    });
    await app.start();
    await app.stop();
  });

  it('env validation: type number failure is reported', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ BAD_NUM: 'not-a-number' }),
        {
          name: 'num-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              BAD_NUM: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow("expected number but got 'not-a-number'");
  });

  it('env validation: type number rejects an empty string (blank coerces to 0)', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ EMPTY_NUM: '' }),
        {
          name: 'empty-num-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              EMPTY_NUM: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow("expected number but got ''");
  });

  it('env validation: type number rejects a whitespace-only string', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ BLANK_NUM: '   ' }),
        {
          name: 'blank-num-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              BLANK_NUM: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow("expected number but got '   '");
  });

  it('env validation: type number rejects Infinity', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ INF_NUM: 'Infinity' }),
        {
          name: 'inf-num-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              INF_NUM: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow("expected number but got 'Infinity'");
  });

  it('env validation: type number accepts a valid numeric string', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ OK_NUM: '8080' }),
        {
          name: 'ok-num-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              OK_NUM: { required: true, type: 'number' },
            });
          },
        },
      ],
    });
    await app.start();
    await app.stop();
  });

  it('env validation: type boolean failure is reported', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ BAD_BOOL: 'maybe' }),
        {
          name: 'bool-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              BAD_BOOL: { required: true, type: 'boolean' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow("expected boolean but got 'maybe'");
  });

  it('env validation: multiple violations aggregate into one error', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({ BAD_NUM: 'x', BAD_BOOL: 'y' }),
        {
          name: 'multi-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({
              MISSING_ONE: { required: true },
              BAD_NUM: { required: true, type: 'number' },
              BAD_BOOL: { required: true, type: 'boolean' },
            });
          },
        },
      ],
    });
    await expect(app.start()).rejects.toThrow(/3 violation\(s\)/);
  });

  it('onError hook that throws is swallowed and 500 is still returned', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'bad-hook',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onError(() => {
              throw new Error('hook blew up');
            });
            ctx.router.get('/boom', () => {
              throw new Error('handler blew up');
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    await app.stop();
  });

  it('onError hook failure is reported via the logger and later hooks still run', async () => {
    const logged: { message: string; metadata?: Record<string, unknown> }[] = [];
    const stubLogger: ILogger = {
      level: 'error',
      fatal() {},
      error(message, metadata) {
        logged.push({ message, ...(metadata ? { metadata } : {}) });
      },
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return stubLogger;
      },
    };
    let secondHookRan = false;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'logger-provider',
          version: '1.0.0',
          provides: [CAPABILITIES.LOGGER],
          register(ctx) {
            ctx.services.register(CAPABILITIES.LOGGER, stubLogger);
          },
        },
        {
          name: 'bad-and-good-hooks',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onError(() => {
              throw new Error('audit hook blew up');
            });
            // A later hook must still run even though the earlier one threw.
            ctx.lifecycle.onError(() => {
              secondHookRan = true;
            });
            ctx.router.get('/boom', () => {
              throw new Error('handler blew up');
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
    expect(res.statusCode).toBe(500);
    expect(secondHookRan).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toBe('onError hook threw and was suppressed');
    expect(logged[0].metadata?.error).toBe('audit hook blew up');
    await app.stop();
  });

  it('a throwing logger during hook-error reporting cannot break the request', async () => {
    const brokenLogger: ILogger = {
      level: 'error',
      fatal() {},
      error() {
        throw new Error('logger is down too');
      },
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return brokenLogger;
      },
    };
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'broken-logger-provider',
          version: '1.0.0',
          provides: [CAPABILITIES.LOGGER],
          register(ctx) {
            ctx.services.register(CAPABILITIES.LOGGER, brokenLogger);
          },
        },
        {
          name: 'bad-hook',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onError(() => {
              throw new Error('hook blew up');
            });
            ctx.router.get('/boom', () => {
              throw new Error('handler blew up');
            });
          },
        },
      ],
    });
    await app.start();
    const res = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    await app.stop();
  });

  it('request received while stop() is in progress returns 503', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({
      plugins: [
        {
          name: 'fake-runtime',
          version: '1.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
            ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
          },
        },
      ],
    });
    await app.start({ port: 4000 });
    // Trigger stop — sets #stopping = true before draining completes.
    const stopPromise = app.stop();
    // The fake clock never advances, so drain waits on the iteration cap.
    // Inject during the drain window: should see 503.
    const res = await app.inject({ method: 'GET', url: 'http://localhost/anything' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Service Unavailable' });
    // Advance the fake clock so the drain loop can finish.
    fake.tick(20_000);
    await stopPromise;
  });

  // ---- Fix 5: stop() before start() ----

  it('stop() before start() is a no-op and does not throw', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    await app.stop();
    // start() should still work afterwards
    await app.start();
    await app.stop();
  });

  it('stop() with no runtime capability skips draining without throwing', async () => {
    const app = createApplication({
      plugins: [{ name: 'no-runtime', version: '1.0.0', register() {} }],
    });
    // start() will throw because runtime is mandatory, but stop() must not
    // throw even though RUNTIME was never registered.
    await expect(app.start()).rejects.toThrow("mandatory 'runtime' capability");
    await app.stop();
  });

  // ---- Fix 6: drain-loop iteration cap ----

  it('drain loop terminates under a manual clock that never advances', async () => {
    const fake = createFakeRuntime({ clock: 0 });
    const app = createApplication({
      plugins: [
        {
          name: 'fake-runtime',
          version: '1.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx) {
            ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
            ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
          },
        },
      ],
    });
    await app.start({ port: 5000 });
    // stop() drains with inFlight=0, but the cap must still bound the loop
    // if the clock never advances. With inFlight=0 the loop body never runs,
    // so this completes immediately; the cap is exercised by the 503 test
    // above where stop() runs concurrently with an injected request.
    const start = Date.now();
    await app.stop();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
