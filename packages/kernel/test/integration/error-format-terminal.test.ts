/**
 * Integration test: the kernel's own 404 terminal answers in the application's
 * configured format, and a thrown `notFound()` and an unmatched route agree on
 * `type`/`title`/`status`/`content-type` (plan §3.3, X9-6).
 *
 * This is the assertion the register says no gate makes: with `errorHandler`
 * registered, the responder seam governs the kernel's terminal too, so the two
 * 404 sources cannot drift onto different shapes.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { errorHandler, notFound } from '@setu-ts/exceptions';
import type { ErrorHandlerFormatter } from '@setu-ts/exceptions';

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

/** Builds a started app with `errorHandler` at `format` and a throwing `/boom` route. */
function appWith(
  format: 'default' | 'rfc9457' | ErrorHandlerFormatter,
): Awaited<ReturnType<typeof createApplication>> {
  const app = createApplication({ plugins: [runtimePlugin()] });
  app.middleware.add(errorHandler({ format, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.router.get('/boom', () => {
    throw notFound('User 42 does not exist');
  });
  return app;
}

describe('kernel 404 terminal answers in the configured format (X9-6)', () => {
  it('thrown notFound() and an unmatched route agree under rfc9457', async () => {
    const app = appWith('rfc9457');
    await app.start();
    try {
      const terminal = await app.inject({ method: 'GET', url: 'http://localhost/no-such-route' });
      const thrown = await app.inject({ method: 'GET', url: 'http://localhost/boom' });

      const t = JSON.parse(terminal.body as string) as Record<string, unknown>;
      const th = JSON.parse(thrown.body as string) as Record<string, unknown>;

      // Identical type/title/status/content-type — the register's missing assertion.
      expect(terminal.headers.get('content-type')).toBe('application/problem+json');
      expect(thrown.headers.get('content-type')).toBe('application/problem+json');
      expect(t.type).toBe('about:blank');
      expect(th.type).toBe('about:blank');
      expect(t.title).toBe('Not Found');
      expect(th.title).toBe('Not Found');
      expect(t.status).toBe(404);
      expect(th.status).toBe(404);
      expect(terminal.statusCode).toBe(404);
      expect(thrown.statusCode).toBe(404);
      // The thrown error's message is its disclosure; the terminal has none.
      expect(t.detail).toBe('Not Found');
      expect(th.detail).toBe('User 42 does not exist');
      expect(t.instance).toBe('/no-such-route');
      expect(th.instance).toBe('/boom');
    } finally {
      await app.stop();
    }
  });

  it('thrown notFound() and an unmatched route agree under default', async () => {
    const app = appWith('default');
    await app.start();
    try {
      const terminal = await app.inject({ method: 'GET', url: 'http://localhost/no-such-route' });
      const thrown = await app.inject({ method: 'GET', url: 'http://localhost/boom' });

      const t = JSON.parse(terminal.body as string) as Record<string, unknown>;
      const th = JSON.parse(thrown.body as string) as Record<string, unknown>;

      expect(terminal.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(thrown.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(t).toEqual({ statusCode: 404, message: 'Not Found' });
      expect(th).toEqual({ statusCode: 404, message: 'User 42 does not exist' });
    } finally {
      await app.stop();
    }
  });

  it('the kernel terminal runs a custom formatter function', async () => {
    const custom: ErrorHandlerFormatter = (error, ctx) => ({
      marker: 'custom',
      title: 'Custom',
      detail: error.message,
      ...(ctx !== undefined && { instance: ctx.request.path }),
    });
    const app = appWith(custom);
    await app.start();
    try {
      const terminal = await app.inject({ method: 'GET', url: 'http://localhost/no-such-route' });
      const thrown = await app.inject({ method: 'GET', url: 'http://localhost/boom' });

      const t = JSON.parse(terminal.body as string) as Record<string, unknown>;
      const th = JSON.parse(thrown.body as string) as Record<string, unknown>;

      expect(t.marker).toBe('custom');
      expect(th.marker).toBe('custom');
      expect(t.detail).toBe('Not Found');
      expect(th.detail).toBe('User 42 does not exist');
      expect(t.instance).toBe('/no-such-route');
      expect(th.instance).toBe('/boom');
    } finally {
      await app.stop();
    }
  });

  it('with no errorHandler registered the terminal falls back to { error }', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/boom', () => {
      throw new Error('kaboom');
    });
    await app.start();
    try {
      const terminal = await app.inject({ method: 'GET', url: 'http://localhost/no-such-route' });
      const boom = await app.inject({ method: 'GET', url: 'http://localhost/boom' });

      expect(terminal.statusCode).toBe(404);
      expect(JSON.parse(terminal.body as string)).toEqual({ error: 'Not Found' });
      expect(terminal.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(boom.statusCode).toBe(500);
      expect(JSON.parse(boom.body as string)).toEqual({ error: 'Internal Server Error' });
    } finally {
      await app.stop();
    }
  });
});
