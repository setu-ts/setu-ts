/**
 * Integration test: the kernel's PRE-PIPELINE error sites answer in the
 * application's configured format (M70f re-review, findings 1 & 2).
 *
 * Two kernel sites run BEFORE the middleware pipeline, where `errorHandler`'s
 * `ctx.state` publication cannot reach them:
 *
 * - the shutdown-drain `503` (a request arriving while `stop()` is draining);
 * - the request-lifecycle hooks (`onRequest`), which run before the pipeline.
 *
 * Before the fix, both sites handed a fresh/empty state to `respondWithError`,
 * so they ALWAYS took the no-handler fallback — `{ error: … }` as
 * `application/json` — even when `errorHandler({ format: 'rfc9457' })` was
 * registered. The kernel now seeds the application's resolved responder (read
 * from the pipeline's `errorHandler` brand at startup) into those sites' state,
 * so they answer in the configured format exactly like every in-pipeline site.
 *
 * These tests fail without the fix (they assert the configured format, which
 * the pre-fix code did not produce) and pass with it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import type { ErrorHandlerFormatter } from '@setu-ts/exceptions';

/** A fake-runtime plugin that also lets the test register lifecycle hooks. */
function runtimePluginWith(fake: ReturnType<typeof createFakeRuntime>): IPlugin {
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** Builds a started app with `errorHandler` at `format` (or none) and a `/ok` route. */
function appWith(
  format: 'default' | 'rfc9457' | ErrorHandlerFormatter | null,
): {
  app: Awaited<ReturnType<typeof createApplication>>;
  fake: ReturnType<typeof createFakeRuntime>;
} {
  const fake = createFakeRuntime();
  const app = createApplication({ plugins: [runtimePluginWith(fake)] });
  if (format !== null) {
    app.middleware.add(errorHandler({ format, logErrors: false }), {
      priority: 0,
      name: 'error-handler',
    });
  }
  app.router.get('/ok', (ctx) => ctx.response.json({ ok: true }));
  return { app, fake };
}

/** Registers a throwing `onRequest` hook (runs before the pipeline). */
function addThrowingRequestHook(app: Awaited<ReturnType<typeof createApplication>>): void {
  app.register({
    name: 'throwing-hook',
    version: '1.0.0',
    provides: [],
    register(ctx: IPluginContext) {
      ctx.lifecycle.onRequest(() => {
        throw new Error('hook failed');
      });
    },
  });
}

describe('kernel pre-pipeline sites answer in the configured format', () => {
  describe('finding 1 — the shutdown-drain 503', () => {
    it('uses the configured rfc9457 format during a real drain', async () => {
      const { app, fake } = appWith('rfc9457');
      await app.start();

      // Begin a real drain. With no stopping hooks, #stopping flips
      // synchronously, so a request arriving now is in the drain window.
      const stopping = app.stop();
      const res = await app.inject({ method: 'GET', url: 'http://localhost/drain-test' });
      fake.tick(20_000);
      await stopping;

      // Before the fix this was { error: 'Service Unavailable' } as
      // application/json. Now it is the configured RFC 9457 body.
      expect(res.statusCode).toBe(503);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body.type).toBe('about:blank');
      expect(body.title).toBe('Service Unavailable');
      expect(body.status).toBe(503);
      expect(body.detail).toBe('Service Unavailable');
      expect(body.instance).toBe('/drain-test');
    });

    it('uses the configured default format during a drain', async () => {
      const { app, fake } = appWith('default');
      await app.start();

      const stopping = app.stop();
      const res = await app.inject({ method: 'GET', url: 'http://localhost/drain-test' });
      fake.tick(20_000);
      await stopping;

      expect(res.statusCode).toBe(503);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body).toEqual({ statusCode: 503, message: 'Service Unavailable' });
    });

    it('uses a custom formatter during a drain', async () => {
      const custom: ErrorHandlerFormatter = (error) => ({
        marker: 'custom-drain',
        code: 'DRAIN',
        detail: error.message,
      });
      const { app, fake } = appWith(custom);
      await app.start();

      const stopping = app.stop();
      const res = await app.inject({ method: 'GET', url: 'http://localhost/drain-test' });
      fake.tick(20_000);
      await stopping;

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body.marker).toBe('custom-drain');
      expect(body.code).toBe('DRAIN');
      expect(body.detail).toBe('Service Unavailable');
    });

    it('keeps the no-handler fallback when no errorHandler is registered', async () => {
      // The byte-identical fallback is the contract for an application without
      // errorHandler — the fix must not change it.
      const { app, fake } = appWith(null);
      await app.start();

      const stopping = app.stop();
      const res = await app.inject({ method: 'GET', url: 'http://localhost/drain-test' });
      fake.tick(20_000);
      await stopping;

      expect(res.statusCode).toBe(503);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body).toEqual({ error: 'Service Unavailable' });
    });
  });

  describe('finding 2 — a throwing onRequest lifecycle hook', () => {
    it('answers in the configured rfc9457 format', async () => {
      const { app } = appWith('rfc9457');
      addThrowingRequestHook(app);
      await app.start();

      // The hook runs BEFORE the pipeline, so before the fix the kernel catch
      // used the no-handler fallback even with errorHandler registered.
      const res = await app.inject({ method: 'GET', url: 'http://localhost/ok' });
      expect(res.statusCode).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body.type).toBe('about:blank');
      expect(body.title).toBe('Internal Server Error');
      expect(body.status).toBe(500);
      expect(body.instance).toBe('/ok');
      await app.stop();
    });

    it('answers in the configured default format', async () => {
      const { app } = appWith('default');
      addThrowingRequestHook(app);
      await app.start();

      const res = await app.inject({ method: 'GET', url: 'http://localhost/ok' });
      expect(res.statusCode).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body).toEqual({ statusCode: 500, message: 'Internal Server Error' });
      await app.stop();
    });

    it('answers in a custom formatter', async () => {
      const custom: ErrorHandlerFormatter = (error) => ({
        marker: 'custom-hook',
        detail: error.message,
      });
      const { app } = appWith(custom);
      addThrowingRequestHook(app);
      await app.start();

      const res = await app.inject({ method: 'GET', url: 'http://localhost/ok' });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body.marker).toBe('custom-hook');
      expect(body.detail).toBe('Internal Server Error');
      await app.stop();
    });

    it('keeps the no-handler fallback when no errorHandler is registered', async () => {
      const { app } = appWith(null);
      addThrowingRequestHook(app);
      await app.start();

      const res = await app.inject({ method: 'GET', url: 'http://localhost/ok' });
      expect(res.statusCode).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(body).toEqual({ error: 'Internal Server Error' });
      await app.stop();
    });
  });
});
