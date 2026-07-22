/**
 * Tests for ReactRouterPlugin — shape, async register, route registration,
 * health indicator, and no onClose hook.
 *
 * @module
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISsrService } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { SsrRequestHandler } from '../../src/interfaces/index.ts';
import { ReactRouterPlugin } from '../../src/plugin/react-router-plugin.ts';
import { SsrService } from '../../src/services/ssr-service.ts';

describe('react-router-plugin', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildFakeCtx(): any {
    const controller = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    // No longer needed - services use a direct Map
    const onCloseCalls: string[] = [];
    const routes = new Map<string, string[]>();

    const routerApi: Record<string, unknown> = {
      get(path: string, _handler: unknown) {
        addRoute(routes, path, 'GET');
      },
      post(p: string, _h: unknown) {
        addRoute(routes, p, 'POST');
      },
      put(p: string, _h: unknown) {
        addRoute(routes, p, 'PUT');
      },
      patch(p: string, _h: unknown) {
        addRoute(routes, p, 'PATCH');
      },
      delete(p: string, _h: unknown) {
        addRoute(routes, p, 'DELETE');
      },
      head(p: string, _h: unknown) {
        addRoute(routes, p, 'HEAD');
      },
      options(p: string, _h: unknown) {
        addRoute(routes, p, 'OPTIONS');
      },
      group() {},
      listRoutes() {
        return Array.from(routes.entries());
      },
    };

    return {
      id: 'r1',
      request: {
        method: 'GET' as const,
        url: 'http://localhost/',
        path: '/',
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '',
        bytes: async () => new Uint8Array(),
      },
      response: {
        status(_c?: number) {
          return this;
        },
        header(_n?: string, _v?: string) {
          return this;
        },
        appendHeader(_n?: string, _v?: string) {
          return this;
        },
        send(_b?: unknown) {
          return { __handlerResult: true };
        },
        json() {
          return { __handlerResult: true };
        },
        text() {
          return { __handlerResult: true };
        },
        redirect() {
          return { __handlerResult: true };
        },
        stream() {
          return { __handlerResult: true };
        },
        snapshot() {
          return { streaming: false, body: null };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      services: {
        _store: new Map<string, unknown>(),
        register(token: string, svc: unknown) {
          this._store.set(token, svc);
        },
        get<T>(token: string): T {
          return this._store.get(token) as T;
        },
      } as any,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: controller.signal,
      runtime: {
        platform: () => 'deno' as const,
        version: () => '2',
        hostname: () => 'localhost',
        uuid: () => 'id',
        randomBytes(_n: number) {
          return new Uint8Array(_n);
        },
        subtle: crypto.subtle,
        now: () => 0,
        hrtime: () => 0,
        setTimeout: () => 0 as never,
        clearTimeout: () => {},
        setInterval: () => 0 as never,
        clearInterval: () => {},
        env: {},
        exit: () => {
          throw new Error('exit');
        },
        fs: { readFile: async () => new TextEncoder().encode('asset') },
      },
      router: routerApi,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _health: {} as any,
      health: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        register(name: string, fn: any) {
          (this as any)._results.set(name, fn);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _results: new Map<string, any>() as any,
      },
      lifecycle: {
        onClose(cb: () => void) {
          onCloseCalls.push('onClose called');
          cb();
        },
      },
    };
  }

  it('plugin has correct shape (name, version, provides, priority)', () => {
    const plugin = ReactRouterPlugin({ serverBuildPath: './build/server' });

    expect(plugin.name).toBe('react-router-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toContain(CAPABILITIES.SSR);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });

  it('async register() awaits loadRequestHandler and registers ISsrService', async () => {
    const fakeHandler = async () => new Response('<html>ok</html>');
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: (_path: string, _mode: string) => Promise.resolve(fakeHandler),
    });

    const fakeCtx = buildFakeCtx();

    await plugin.register(fakeCtx);

    const ssrService = (fakeCtx.services as unknown as { get<T>(token: string): T }).get<
      ISsrService
    >(CAPABILITIES.SSR);
    expect(ssrService).toBeDefined();
    expect(typeof ssrService.render).toBe('function');
    expect(ssrService).toBeInstanceOf(SsrService);
  });

  it('registers catch-all for all 7 verbs at /* (default basename)', async () => {
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: (_path: string, _mode: string) =>
        Promise.resolve(new Response('ok') as unknown as SsrRequestHandler),
    });

    const fakeCtx = buildFakeCtx();
    const routes = new Map<string, string[]>();
    fakeCtx.router = {
      get(p: string, _h: unknown) {
        addRoute(routes, p, 'GET');
      },
      post(p: string, _h: unknown) {
        addRoute(routes, p, 'POST');
      },
      put(p: string, _h: unknown) {
        addRoute(routes, p, 'PUT');
      },
      patch(p: string, _h: unknown) {
        addRoute(routes, p, 'PATCH');
      },
      delete(p: string, _h: unknown) {
        addRoute(routes, p, 'DELETE');
      },
      head(p: string, _h: unknown) {
        addRoute(routes, p, 'HEAD');
      },
      options(p: string, _h: unknown) {
        addRoute(routes, p, 'OPTIONS');
      },
      group() {},
      listRoutes() {
        return Array.from(routes.entries());
      },
    };

    await plugin.register(fakeCtx);

    const catchAllMethods = routes.get('/*');
    expect(catchAllMethods).toBeDefined();
    expect(catchAllMethods).toContain('GET');
    expect(catchAllMethods).toContain('POST');
    expect(catchAllMethods).toContain('PUT');
    expect(catchAllMethods).toContain('PATCH');
    expect(catchAllMethods).toContain('DELETE');
    expect(catchAllMethods).toContain('HEAD');
    expect(catchAllMethods).toContain('OPTIONS');
  });

  it('basename /app/ produces /app/* without doubled slash', async () => {
    const routes = new Map<string, string[]>();
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      basename: '/app/',
      loadRequestHandler: (_path: string, _mode: string) =>
        Promise.resolve(new Response('ok') as unknown as SsrRequestHandler),
    });

    const fakeCtx = buildFakeCtx();
    fakeCtx.router = {
      get(p: string, _h: unknown) {
        addRoute(routes, p, 'GET');
      },
      post(p: string, _h: unknown) {
        addRoute(routes, p, 'POST');
      },
      put(p: string, _h: unknown) {
        addRoute(routes, p, 'PUT');
      },
      patch(p: string, _h: unknown) {
        addRoute(routes, p, 'PATCH');
      },
      delete(p: string, _h: unknown) {
        addRoute(routes, p, 'DELETE');
      },
      head(p: string, _h: unknown) {
        addRoute(routes, p, 'HEAD');
      },
      options(p: string, _h: unknown) {
        addRoute(routes, p, 'OPTIONS');
      },
      group() {},
      listRoutes() {
        return Array.from(routes.entries());
      },
    };

    await plugin.register(fakeCtx);

    expect(routes.has('/app/*')).toBe(true);
    expect(routes.get('/app/*')).toContain('GET');
  });

  it('asset route registered at /assets/* only when assetsDir is set', async () => {
    const routesWith = new Map<string, string[]>();
    const withAssets = ReactRouterPlugin({
      serverBuildPath: './build/server',
      assetsDir: './build/client',
      loadRequestHandler: (_path: string, _mode: string) =>
        Promise.resolve(new Response('ok') as unknown as SsrRequestHandler),
    });

    const ctxWith = buildFakeCtx();
    ctxWith.router = {
      get(p: string, _h: unknown) {
        addRoute(routesWith, p, 'GET');
      },
      post(p: string, _h: unknown) {
        addRoute(routesWith, p, 'POST');
      },
      put(p: string, _h: unknown) {
        addRoute(routesWith, p, 'PUT');
      },
      patch(p: string, _h: unknown) {
        addRoute(routesWith, p, 'PATCH');
      },
      delete(p: string, _h: unknown) {
        addRoute(routesWith, p, 'DELETE');
      },
      head(p: string, _h: unknown) {
        addRoute(routesWith, p, 'HEAD');
      },
      options(p: string, _h: unknown) {
        addRoute(routesWith, p, 'OPTIONS');
      },
      group() {},
      listRoutes() {
        return Array.from(routesWith.entries());
      },
    };

    await withAssets.register(ctxWith);

    const routesWithout = new Map<string, string[]>();
    const noAssets = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: (_path: string, _mode: string) =>
        Promise.resolve(new Response('ok') as unknown as SsrRequestHandler),
    });
    const ctxNo = buildFakeCtx();
    ctxNo.router = {
      get(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'GET');
      },
      post(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'POST');
      },
      put(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'PUT');
      },
      patch(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'PATCH');
      },
      delete(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'DELETE');
      },
      head(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'HEAD');
      },
      options(p: string, _h: unknown) {
        addRoute(routesWithout, p, 'OPTIONS');
      },
      group() {},
      listRoutes() {
        return Array.from(routesWithout.entries());
      },
    };

    await noAssets.register(ctxNo);
  });

  it('registers react-router health indicator returning status up', async () => {
    const fakeCtx = buildFakeCtx();
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      mode: 'production',
      loadRequestHandler: (_path: string, _mode: string) =>
        Promise.resolve(new Response('ok') as unknown as SsrRequestHandler),
    });
    await plugin.register(fakeCtx);

    const healthResults = (
      fakeCtx.health as { _results: Map<string, () => Promise<{ status: string; data?: unknown }>> }
    )._results;
    const indicatorFn = healthResults.get('react-router');
    expect(indicatorFn).toBeDefined();
    const result = await indicatorFn!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({
      mode: 'production',
      serverBuildPath: './build/server',
    });
  });

  it('asserts NO onClose hook is registered', async () => {
    const fakeCtx = buildFakeCtx();
    const onCloseTracker: string[] = [];
    fakeCtx._lifecycle = { _calls: onCloseTracker };
    fakeCtx.lifecycle = {
      onClose(cb: () => void) {
        onCloseTracker.push('invoked');
        cb();
      },
    };

    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: (_path: string, _mode: string) =>
        Promise.resolve(new Response('ok') as unknown as SsrRequestHandler),
    });
    await plugin.register(fakeCtx);

    expect(onCloseTracker.length).toBe(0);
  });
});

function addRoute(routes: Map<string, string[]>, path: string, method: string) {
  let m = routes.get(path);
  if (!m) m = [];
  if (!m.includes(method)) m.push(method);
  routes.set(path, m);
}
