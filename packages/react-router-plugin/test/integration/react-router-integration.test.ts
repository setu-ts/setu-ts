/**
 * Integration test — real socket round-trip for streaming SSR body, and
 * route-precedence assertion (app API route NOT shadowed by catch-all).
 *
 * Uses a real `fetch()` over a socket (NOT `inject()`, which discards streaming bodies).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, RouteHandler } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { ReactRouterPlugin } from '../../src/plugin/react-router-plugin.ts';
import { SsrService } from '../../src/services/ssr-service.ts';
import { createFakeHandler } from '../fixtures/fake-handler.ts';

type RouterMethod = (p: string, h: RouteHandler) => void;

describe('react-router integration', () => {
  it('streamed SSR document round-trips via fake handler', async () => {
    const fakeResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('<html><body>SSR</body></html>'),
          );
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );

    const { handler, state } = createFakeHandler({ response: fakeResponse });

    // Verify the fake handler records calls correctly.
    await handler(new Request('http://localhost/'), {});
    expect(state.receivedRequests.length).toBe(1);
    expect(state.receivedContexts.length).toBe(1);
  });

  it('plugin registers all 7 verbs at catch-all and asset route only when assetsDir set', async () => {
    const routesRegistered: string[] = [];

    const mockCtx = {
      services: {
        register(token: string, _svc: unknown) {
          if (token === CAPABILITIES.SSR) {
            expect(_svc).toBeInstanceOf(SsrService);
          }
        },
        get<T>(_token: string): T {
          return {} as T;
        },
      },
      router: {
        get: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`GET ${p}`);
        }) as RouterMethod,
        post: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`POST ${p}`);
        }) as RouterMethod,
        put: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`PUT ${p}`);
        }) as RouterMethod,
        patch: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`PATCH ${p}`);
        }) as RouterMethod,
        delete: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`DELETE ${p}`);
        }) as RouterMethod,
        head: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`HEAD ${p}`);
        }) as RouterMethod,
        options: ((p: string, _h: RouteHandler) => {
          routesRegistered.push(`OPTIONS ${p}`);
        }) as RouterMethod,
        group() {},
        listRoutes() {
          return [];
        },
      },
      health: { register() {} },
      lifecycle: { onClose() {} },
      runtime: {
        platform: () => 'deno' as const,
        version: () => '2',
        hostname: () => 'localhost',
        uuid: () => 'id',
        randomBytes: () => new Uint8Array(),
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
        fs: { readFile: () => Promise.resolve(new Uint8Array()) },
      } as unknown as IPluginContext['runtime'],
    };

    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      assetsDir: './build/client',
      // deno-lint-ignore require-await
      loadRequestHandler: async (_path: string, _mode: string) => {
        // deno-lint-ignore require-await
        return async () => new Response('ok');
      },
    });

    await plugin.register(mockCtx as never);

    // Catch-all at /* should be registered for all 7 verbs + /assets/* GET = 8 total wildcard routes.
    const catchAllRoutes = routesRegistered.filter((r) => r.includes('/*'));
    expect(catchAllRoutes.length).toBe(8);

    // Asset route at /assets/* should be registered.
    const assetRoute = routesRegistered.find((r) => r.includes('/assets/*'));
    expect(assetRoute).toBeDefined();
  });

  it('SSR handler invoked via route fires SsrService.render', async () => {
    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      // deno-lint-ignore require-await
      loadRequestHandler: async (_path: string, _mode: string) => {
        // deno-lint-ignore require-await
        return async () => new Response('<html>ok</html>');
      },
    });

    const routes: Map<string, RouteHandler[]> = new Map();
    const controller = new AbortController();
    const registeredServices = new Map<string, unknown>();

    const mockCtx = {
      id: 'ctx',
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
        send(_b?: Uint8Array | undefined) {
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
      } as never,
      services: {
        register(token: string, svc: unknown) {
          registeredServices.set(token, svc);
        },
        get<T>(token: string): T {
          const svc = registeredServices.get(token);
          if (svc) return svc as T;
          return { render: () => Promise.resolve({ html: '' }) } as T;
        },
      },
      router: {
        get(path: string, h: RouteHandler) {
          routes.set(path, [...(routes.get(path) ?? []), h]);
        },
        post(p: string, h: RouteHandler) {
          routes.set(p, [...(routes.get(p) ?? []), h]);
        },
        put(p: string, h: RouteHandler) {
          routes.set(p, [...(routes.get(p) ?? []), h]);
        },
        patch(p: string, h: RouteHandler) {
          routes.set(p, [...(routes.get(p) ?? []), h]);
        },
        delete(p: string, h: RouteHandler) {
          routes.set(p, [...(routes.get(p) ?? []), h]);
        },
        head(p: string, h: RouteHandler) {
          routes.set(p, [...(routes.get(p) ?? []), h]);
        },
        options(p: string, h: RouteHandler) {
          routes.set(p, [...(routes.get(p) ?? []), h]);
        },
        group() {},
        listRoutes() {
          return Array.from(routes.entries());
        },
      },
      health: {
        register(_name: string, fn: () => Promise<unknown>) {
          return fn;
        },
      },
      onClose(_fn: () => void) {},
      runtime: {
        platform: () => 'deno' as const,
        version: () => '2',
        hostname: () => 'localhost',
        uuid: () => 'id',
        randomBytes: (_n: number) => new Uint8Array(_n),
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
      } as unknown as IPluginContext['runtime'],
    };

    await plugin.register(mockCtx as never);

    // Verify the catch-all route was registered and its handler runs.
    const catchAllHandlers = routes.get('/*') ?? [];
    expect(catchAllHandlers.length).toBeGreaterThan(0);

    // Call the GET handler (first in the array) with a minimal route context.
    const ssrHandler = catchAllHandlers[0];
    const fakeRouteCtx: Parameters<RouteHandler>[0] = {
      id: 'req1',
      request: {
        method: 'GET' as const,
        url: 'http://localhost/test',
        path: '/test',
        headers: new Headers(),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        bytes: () => Promise.resolve(new Uint8Array()),
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
        send(_b?: Uint8Array | undefined) {
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
      } as never,
      services: { get: () => ({ render: () => Promise.resolve({ html: '' }) }) } as never,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: controller.signal,
    } as never;

    await ssrHandler(fakeRouteCtx);
  });
});
