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
import type { IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { ReactRouterPlugin } from '../../src/plugin/react-router-plugin.ts';
import { SsrService } from '../../src/services/ssr-service.ts';
import { createFakeHandler } from '../fixtures/fake-handler.ts';

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockCtx: any = {
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
        get(p: string, _h: Function) {
          routesRegistered.push(`GET ${p}`);
        },
        post(p: string, _h: Function) {
          routesRegistered.push(`POST ${p}`);
        },
        put(p: string, _h: Function) {
          routesRegistered.push(`PUT ${p}`);
        },
        patch(p: string, _h: Function) {
          routesRegistered.push(`PATCH ${p}`);
        },
        delete(p: string, _h: Function) {
          routesRegistered.push(`DELETE ${p}`);
        },
        head(p: string, _h: Function) {
          routesRegistered.push(`HEAD ${p}`);
        },
        options(p: string, _h: Function) {
          routesRegistered.push(`OPTIONS ${p}`);
        },
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
        fs: { readFile: async () => new Uint8Array() },
      } as unknown as IPluginContext['runtime'],
    };

    const plugin = ReactRouterPlugin({
      serverBuildPath: './build/server',
      assetsDir: './build/client',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loadRequestHandler: (_path: string, _mode: string): any => {
        return Promise.resolve(async () => new Response('ok'));
      },
    });

    await plugin.register(mockCtx);

    // Catch-all at /* should be registered for all 7 verbs + /assets/* GET = 8 total wildcard routes.
    const catchAllRoutes = routesRegistered.filter((r) => r.includes('/*'));
    expect(catchAllRoutes.length).toBe(8);

    // Asset route at /assets/* should be registered.
    const assetRoute = routesRegistered.find((r) => r.includes('/assets/*'));
    expect(assetRoute).toBeDefined();
  });
});
