/**
 * Integration tests for HttpSecurityPlugin.
 *
 * Exercises the full plugin → middleware lifecycle with a fake plugin context
 * and request context, proving short-circuit behavior and cross-concern
 * observable side effects through the public surface.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  HandlerResult,
  IMiddlewareApi,
  IPluginContext,
  IRequestContext,
  IRuntimeServices,
} from '@hono-enterprise/common';

import { HttpSecurityPlugin } from '../../src/plugin/http-security-plugin.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

// ---------------------------------------------------------------------------
// Helpers — build a chain that simulates app.inject() through registered middleware
// ---------------------------------------------------------------------------

function createPluginContext(): {
  ctx: IPluginContext;
  middlewareAdded: Array<{
    fn: (
      ctx: IRequestContext,
      next: () => Promise<void>,
    ) => void | HandlerResult | Promise<void | HandlerResult>;
    options: { priority?: number; name?: string };
  }>;
} {
  const middlewareAdded: Array<{
    fn: (
      ctx: IRequestContext,
      next: () => Promise<void>,
    ) => void | HandlerResult | Promise<void | HandlerResult>;
    options: { priority?: number; name?: string };
  }> = [];

  const middlewareApi: IMiddlewareApi = {
    add: (fn, options) => {
      middlewareAdded.push({ fn, options: options ?? {} });
    },
  };

  const runtime: IRuntimeServices = {
    platform: () => 'deno' as const,
    version: () => 'test',
    hostname: () => 'localhost',
    now: () => 0,
    hrtime: () => 0,
    setTimeout: () => ({ id: 0 }),
    clearTimeout: () => {},
    setInterval: () => ({ id: 0 }),
    clearInterval: () => {},
    uuid: () => 'test-uuid',
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: globalThis.crypto?.subtle,
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
  };

  const ctx: IPluginContext = {
    services: {
      register: () => {},
      registerFactory: () => {},
      get: <T>(): T => runtime as T,
      getAll: () => [],
      has: () => true,
      unregister: () => false,
    },
    middleware: middlewareApi,
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    environment: { validate: () => {} },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    lifecycle: {
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    runtime,
    options: {},
    app: {
      register: () => ctx.app,
      start: async () => {},
      stop: async () => {},
      fetch: () => Promise.resolve(new Response('mock')),
      router: {} as IPluginContext['router'],
      middleware: middlewareApi,
      services: {} as IPluginContext['services'],
    },
  };

  return { ctx, middlewareAdded };
}

/**
 * Run the middleware chain in priority order against a fake context,
 * simulating what the kernel does during request processing.
 */
async function runMiddlewareChain(
  middlewareList: Array<{
    fn: (
      ctx: IRequestContext,
      next: () => Promise<void>,
    ) => void | HandlerResult | Promise<void | HandlerResult>;
    options: { priority?: number; name?: string };
  }>,
  reqOpts: Parameters<typeof createFakeContext>[0],
): Promise<{
  ctx: IRequestContext;
  response: ReturnType<typeof createFakeContext>['response'];
  handlerRan: boolean;
  nextCalled: boolean[];
}> {
  const { ctx, response, nextCalled } = createFakeContext(reqOpts);
  const handlerRan = [false];

  // Sort by priority (lower first)
  const sorted = [...middlewareList].sort((a, b) =>
    (a.options.priority ?? 500) - (b.options.priority ?? 500)
  );

  let index = 0;
  async function chain(): Promise<void> {
    if (index < sorted.length) {
      const { fn } = sorted[index];
      index++;
      await fn(ctx, chain);
    } else {
      // Handler
      handlerRan[0] = true;
      ctx.response.json({ ok: true });
    }
  }

  await chain();

  return { ctx, response, handlerRan: handlerRan[0], nextCalled };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpSecurityPlugin — integration', () => {
  describe('short-circuit behavior stops downstream stages', () => {
    it('oversized POST → 413, handler not run', async () => {
      const { ctx: pluginCtx, middlewareAdded } = createPluginContext();
      const plugin = HttpSecurityPlugin({
        requestSize: { maxBodySize: 1000 },
        ipSecurity: {},
      });
      plugin.register(pluginCtx);

      const result = await runMiddlewareChain(middlewareAdded, {
        request: {
          method: 'POST',
          url: 'https://api.example.com/data',
          headers: { 'Content-Length': '5000' },
        },
      });

      expect(result.handlerRan).toBe(false);
      expect(result.response.statuses).toContain(413);
      const body = result.response.body as { error: string; message: string };
      expect(body.error).toBe('Payload Too Large');
    });

    it('CSRF bad-origin POST → 403, handler not run', async () => {
      const { ctx: pluginCtx, middlewareAdded } = createPluginContext();
      const plugin = HttpSecurityPlugin({
        csrf: {},
        requestSize: {},
      });
      plugin.register(pluginCtx);

      const result = await runMiddlewareChain(middlewareAdded, {
        request: {
          method: 'POST',
          url: 'https://api.example.com/data',
          headers: { Origin: 'https://evil.com' },
        },
      });

      expect(result.handlerRan).toBe(false);
      expect(result.response.statuses).toContain(403);
      const body = result.response.body as { error: string; message: string };
      expect(body.error).toBe('Forbidden');
    });

    it('CORS preflight → 204, handler not run', async () => {
      const { ctx: pluginCtx, middlewareAdded } = createPluginContext();
      const plugin = HttpSecurityPlugin({
        cors: { origin: 'https://app.example.com' },
      });
      plugin.register(pluginCtx);

      const result = await runMiddlewareChain(middlewareAdded, {
        request: {
          method: 'OPTIONS',
          url: 'https://api.example.com/data',
          headers: {
            Origin: 'https://app.example.com',
            'Access-Control-Request-Method': 'POST',
          },
        },
      });

      expect(result.handlerRan).toBe(false);
      expect(result.response.statuses).toContain(204);
      expect(result.response.headers.get('access-control-allow-origin'))
        .toBe('https://app.example.com');
    });
  });

  describe('valid same-origin GET — full chain passes', () => {
    it('handler runs with security headers and clientIp populated', async () => {
      const { ctx: pluginCtx, middlewareAdded } = createPluginContext();
      const plugin = HttpSecurityPlugin({
        cors: { origin: 'https://app.example.com' },
        csrf: { trustedOrigins: [] },
        requestSize: { maxBodySize: 1_048_576 },
        ipSecurity: { trustProxy: true },
      });
      plugin.register(pluginCtx);

      const result = await runMiddlewareChain(middlewareAdded, {
        request: {
          method: 'GET',
          url: 'https://api.example.com/health',
          headers: {
            Origin: 'https://app.example.com',
            'X-Forwarded-For': '203.0.113.50, 10.0.0.1',
          },
        },
      });

      expect(result.handlerRan).toBe(true);

      // Security headers present
      expect(result.response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(result.response.headers.get('x-frame-options')).toBe('DENY');
      expect(result.response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(result.response.headers.get('strict-transport-security')).toBe(
        'max-age=31536000; includeSubDomains',
      );

      // CORS headers present
      expect(result.response.headers.get('access-control-allow-origin'))
        .toBe('https://app.example.com');

      // IP resolved
      expect(result.ctx.state.get('clientIp')).toBe('203.0.113.50');
    });
  });

  describe('execution order via observable side effects', () => {
    it('clientIp in state before handler runs (IP priority 120)', async () => {
      const { ctx: pluginCtx, middlewareAdded } = createPluginContext();
      const plugin = HttpSecurityPlugin({
        ipSecurity: { trustProxy: true },
        csrf: {},
      });
      plugin.register(pluginCtx);

      // Capture state at handler time by monkey-patching the response json
      const { ctx } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: {
            Origin: 'https://app.example.com',
            'X-Forwarded-For': '192.0.2.1',
          },
        },
      });

      const capturedState: Map<string, unknown> = new Map();
      const origJson = ctx.response.json.bind(ctx.response);
      ctx.response.json = <T>(b: T): HandlerResult => {
        capturedState.set('clientIp', ctx.state.get('clientIp'));
        return origJson(b);
      };

      // Run the middleware chain manually on this context
      const sorted = [...middlewareAdded].sort(
        (a, b) => (a.options.priority ?? 500) - (b.options.priority ?? 500),
      );
      let idx = 0;
      async function chain(): Promise<void> {
        if (idx < sorted.length) {
          const { fn } = sorted[idx];
          idx++;
          await fn(ctx, chain);
        } else {
          ctx.response.json({ ok: true });
        }
      }
      await chain();

      // IP was resolved before the handler ran
      expect(capturedState.get('clientIp')).toBe('192.0.2.1');
    });
  });

  describe('headers: { enabled: false } disables headers', () => {
    it('no security headers when disabled', async () => {
      const { ctx: pluginCtx, middlewareAdded } = createPluginContext();
      const plugin = HttpSecurityPlugin({
        headers: { enabled: false },
      });
      plugin.register(pluginCtx);

      const result = await runMiddlewareChain(middlewareAdded, {
        request: { method: 'GET' },
      });

      expect(result.handlerRan).toBe(true);
      expect(result.response.headers.get('x-content-type-options')).toBeUndefined();
      expect(result.response.headers.get('x-frame-options')).toBeUndefined();
    });
  });
});
