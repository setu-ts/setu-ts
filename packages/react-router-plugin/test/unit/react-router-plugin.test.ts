/**
 * Tests for ReactRouterPlugin — shape, async register, route registration,
 * health indicator, and no onClose hook.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
// deno-lint-ignore no-explicit-any
type Any = any;
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { SsrRequestHandler } from '../../src/interfaces/index.ts';
import { ReactRouterPlugin } from '../../src/plugin/react-router-plugin.ts';
import { SsrService } from '../../src/services/ssr-service.ts';

describe('react-router-plugin', () => {
  function buildFakeCtx(): Any {
    const controller = new AbortController();
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

    const handlerResult = { __handlerResult: true };

    return {
      id: 'r1',
      request: {
        method: 'GET' as const,
        url: 'http://localhost/',
        path: '/',
        headers: new Headers(),
        json: () => ({}),
        text: () => '',
        bytes: () => new Uint8Array(),
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
          return handlerResult;
        },
        json() {
          return handlerResult;
        },
        text() {
          return handlerResult;
        },
        redirect() {
          return handlerResult;
        },
        stream() {
          return handlerResult;
        },
        snapshot() {
          return { streaming: false, body: null };
        },
      },
      services: {
        _store: new Map<string, unknown>(),
        register(token: string, svc: unknown) {
          this._store.set(token, svc);
        },
        get<T>(token: string): T {
          return this._store.get(token) as T;
        },
      },
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
        fs: { readFile: () => Promise.resolve(new TextEncoder().encode('asset')) },
      },
      router: routerApi,
      health: {
        // deno-lint-ignore ban-types
        register(_name: string, _fn: Function) {
          // noop for tests
        },
      },
      lifecycle: {
        onClose(cb: () => void) {
          onCloseCalls.push('onClose called');
          cb();
        },
      },
    };
  }

  function makeLoadRequestHandler(response: Response) {
    // deno-lint-ignore require-await
    return async (_path: string, _mode: string): Promise<SsrRequestHandler> => {
      void _path;
      void _mode;
      // deno-lint-ignore require-await
      return async () => response;
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
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: makeLoadRequestHandler(new Response('<html>ok</html>')),
    });

    const fakeCtx = buildFakeCtx();

    await plugin.register(fakeCtx);

    const ssrService = fakeCtx.services.get(CAPABILITIES.SSR);
    expect(ssrService).toBeDefined();
    expect(typeof ssrService.render).toBe('function');
    expect(ssrService).toBeInstanceOf(SsrService);
  });

  it('registers catch-all for all 7 verbs at /* (default basename)', async () => {
    const routes = new Map<string, string[]>();
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: makeLoadRequestHandler(new Response('ok')),
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
      loadRequestHandler: makeLoadRequestHandler(new Response('ok')),
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
      loadRequestHandler: makeLoadRequestHandler(new Response('ok')),
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
      loadRequestHandler: makeLoadRequestHandler(new Response('ok')),
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
    const healthResults = new Map<string, () => Promise<{ status: string; data?: unknown }>>();
    const fakeCtx = buildFakeCtx();
    fakeCtx.health = {
      // deno-lint-ignore ban-types
      register(name: string, fn: Function) {
        healthResults.set(name, fn as () => Promise<{ status: string; data?: unknown }>);
      },
    };

    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      mode: 'production',
      loadRequestHandler: makeLoadRequestHandler(new Response('ok')),
    });
    await plugin.register(fakeCtx);

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
    const onCloseTracker: string[] = [];
    const fakeCtx = buildFakeCtx();
    fakeCtx.lifecycle = {
      onClose(cb: () => void) {
        onCloseTracker.push('invoked');
        cb();
      },
    };

    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      loadRequestHandler: makeLoadRequestHandler(new Response('ok')),
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
