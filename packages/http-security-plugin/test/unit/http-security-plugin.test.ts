import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IMiddlewareApi, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { HttpSecurityPlugin } from '../../src/plugin/http-security-plugin.ts';

describe('HttpSecurityPlugin', () => {
  function createFakePluginContext(): {
    ctx: IPluginContext;
    middlewareAdded: Array<{ fn: unknown; options: { priority?: number; name?: string } }>;
  } {
    const middlewareAdded: Array<{ fn: unknown; options: { priority?: number; name?: string } }> =
      [];

    const middlewareApi: IMiddlewareApi = {
      add: (fn: unknown, options?: { priority?: number; name?: string }) => {
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
        router: {} as IPluginContext['router'],
        middleware: middlewareApi,
        services: {} as IPluginContext['services'],
      },
    };

    return { ctx, middlewareAdded };
  }

  describe('plugin identity', () => {
    it('has correct name and version', () => {
      const plugin = HttpSecurityPlugin();
      expect(plugin.name).toBe('http-security-plugin');
      expect(plugin.version).toBe('0.1.0');
    });

    it('does not provide capability tokens', () => {
      const plugin = HttpSecurityPlugin();
      expect(plugin.provides).toBeUndefined();
    });

    it('register() does not throw with empty options', () => {
      const { ctx } = createFakePluginContext();
      const plugin = HttpSecurityPlugin();
      expect(() => plugin.register(ctx)).not.toThrow();
    });
  });

  describe('default options (no config)', () => {
    it('registers only security-headers middleware', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin();
      plugin.register(ctx);

      expect(middlewareAdded).toHaveLength(1);
      expect(middlewareAdded[0].options.name).toBe('SecurityHeadersMiddleware');
      expect(middlewareAdded[0].options.priority).toBe(250);
    });
  });

  describe('opt-in concerns', () => {
    it('registers CORS when cors option present', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({ cors: { origin: 'https://example.com' } });
      plugin.register(ctx);

      const corsEntry = middlewareAdded.find((m) => m.options.name === 'CorsMiddleware');
      expect(corsEntry).toBeDefined();
      expect(corsEntry!.options.priority).toBe(200);
    });

    it('registers CSRF when csrf option present', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({ csrf: {} });
      plugin.register(ctx);

      const csrfEntry = middlewareAdded.find((m) => m.options.name === 'CsrfMiddleware');
      expect(csrfEntry).toBeDefined();
      expect(csrfEntry!.options.priority).toBe(270);
    });

    it('registers request-size when requestSize option present', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({ requestSize: { maxBodySize: 500_000 } });
      plugin.register(ctx);

      const sizeEntry = middlewareAdded.find((m) => m.options.name === 'RequestSizeMiddleware');
      expect(sizeEntry).toBeDefined();
      expect(sizeEntry!.options.priority).toBe(180);
    });

    it('registers IP security when ipSecurity option present', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({ ipSecurity: { trustProxy: true } });
      plugin.register(ctx);

      const ipEntry = middlewareAdded.find((m) => m.options.name === 'IpSecurityMiddleware');
      expect(ipEntry).toBeDefined();
      expect(ipEntry!.options.priority).toBe(120);
    });
  });

  describe('enabled: false on present blocks', () => {
    it('CORS enabled: false still registers but middleware is pass-through', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({ cors: { enabled: false } });
      plugin.register(ctx);

      const corsEntry = middlewareAdded.find((m) => m.options.name === 'CorsMiddleware');
      expect(corsEntry).toBeDefined();
    });
  });

  describe('all concerns enabled', () => {
    it('registers all five middleware', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({
        cors: { origin: 'https://example.com' },
        csrf: {},
        requestSize: {},
        ipSecurity: {},
      });
      plugin.register(ctx);

      expect(middlewareAdded).toHaveLength(5);

      const names = middlewareAdded.map((m) => m.options.name);
      expect(names).toContain('SecurityHeadersMiddleware');
      expect(names).toContain('CorsMiddleware');
      expect(names).toContain('CsrfMiddleware');
      expect(names).toContain('RequestSizeMiddleware');
      expect(names).toContain('IpSecurityMiddleware');
    });

    it('priorities are correct', () => {
      const { ctx, middlewareAdded } = createFakePluginContext();
      const plugin = HttpSecurityPlugin({
        cors: {},
        csrf: {},
        requestSize: {},
        ipSecurity: {},
      });
      plugin.register(ctx);

      const byName = new Map(middlewareAdded.map((m) => [m.options.name, m.options.priority]));
      expect(byName.get('IpSecurityMiddleware')).toBe(120);
      expect(byName.get('RequestSizeMiddleware')).toBe(180);
      expect(byName.get('CorsMiddleware')).toBe(200);
      expect(byName.get('SecurityHeadersMiddleware')).toBe(250);
      expect(byName.get('CsrfMiddleware')).toBe(270);
    });
  });
});
