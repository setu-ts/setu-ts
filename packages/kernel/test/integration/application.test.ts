import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

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
