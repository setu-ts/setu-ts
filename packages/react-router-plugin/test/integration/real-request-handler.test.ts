/**
 * Regression test for the loadContext contract, driven through the REAL
 * `createRequestHandler` from `npm:react-router@8`.
 *
 * React Router 8 rejects any `context` that is not an instance of its
 * `RouterContextProvider` class — `createRequestHandler` answers
 * `500 Unexpected Server Error` rather than degrading — and the static handler
 * repeats the check nominally whenever route middleware runs. Every other test
 * in this package drives a fake handler, so this file is the only place where a
 * regression in what the plugin passes as `context` can be caught.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IServiceRegistry } from '@hono-enterprise/common';
import type { IRequestContext, SsrRequestHandler } from '../../src/interfaces/index.ts';
import { assembleHandler, createLoadContextFactory } from '../../src/handler/server-build.ts';
import { bridgeRequestToRR } from '../../src/handler/request-bridge.ts';
import { servicesContext, userContext } from '../../src/handler/context-keys.ts';

/**
 * Minimal-but-real `ServerBuild`: enough shape for `createRequestHandler` to
 * route a GET `/` to a single root route whose loader reads the context.
 */
// deno-lint-ignore no-explicit-any
function buildServerBuild(onLoaderContext: (context: any) => void): unknown {
  return {
    ssr: true,
    basename: '/',
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    prerender: [],
    routeDiscovery: { mode: 'initial' },
    isSpaMode: false,
    entry: {
      module: {
        default: () =>
          new Response('<html>ssr-ok</html>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
    },
    routes: {
      root: {
        id: 'root',
        parentId: undefined,
        path: '',
        module: {
          default: () => null,
          // deno-lint-ignore no-explicit-any
          loader: ({ context }: any) => {
            onLoaderContext(context);
            return { ok: true };
          },
        },
      },
    },
    assets: {
      entry: { module: '/entry.client.js', imports: [] },
      routes: {
        root: {
          id: 'root',
          path: '',
          hasAction: false,
          hasLoader: true,
          hasClientAction: false,
          hasClientLoader: false,
          hasClientMiddleware: false,
          hasErrorBoundary: false,
          module: '/root.js',
          imports: [],
        },
      },
      url: '/manifest.js',
      version: '1',
    },
  };
}

/** Minimal kernel request context; only the fields the bridge reads. */
function buildCtx(registry: IServiceRegistry): {
  ctx: IRequestContext;
  state: { status: number; body: string };
} {
  const state = { status: 0, body: '' };
  const decoder = new TextDecoder();

  return {
    ctx: {
      id: 'req-1',
      request: {
        method: 'GET' as const,
        url: 'http://localhost/',
        path: '/',
        headers: new Headers(),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        bytes: () => Promise.resolve(new Uint8Array()),
      },
      response: {
        status(code: number) {
          state.status = code;
          return this;
        },
        header() {
          return this;
        },
        appendHeader() {
          return this;
        },
        send(bytes?: Uint8Array) {
          state.body = bytes ? decoder.decode(bytes) : '';
          return {} as never;
        },
        async stream(s: ReadableStream<Uint8Array>) {
          state.body = decoder.decode(new Uint8Array(await new Response(s).arrayBuffer()));
          return {} as never;
        },
        json() {
          return {} as never;
        },
        text() {
          return {} as never;
        },
        redirect() {
          return {} as never;
        },
        snapshot() {
          return { streaming: false, body: null };
        },
      },
      services: registry,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: new AbortController().signal,
    } as never,
    state,
  };
}

describe('real createRequestHandler — loadContext contract', () => {
  it('renders 200 and exposes servicesContext to a real loader', async () => {
    const rr = await import('npm:react-router@8') as unknown as Record<string, unknown>;
    const registry = { get: () => undefined } as unknown as IServiceRegistry;

    // deno-lint-ignore no-explicit-any
    let loaderContext: any = null;
    const createRequestHandler = rr.createRequestHandler as (
      build: unknown,
      mode: string,
    ) => unknown;

    const handler = assembleHandler(
      buildServerBuild((context) => {
        loaderContext = context;
      }),
      createRequestHandler,
      'production',
    );
    const createLoadContext = createLoadContextFactory(rr);

    const { ctx, state } = buildCtx(registry);
    await bridgeRequestToRR(ctx, handler, createLoadContext);

    // Before the fix this was 500 "Unexpected Server Error".
    expect(state.status).toBe(200);
    expect(state.body).toContain('ssr-ok');

    // The loader saw a working provider carrying the plugin's defaults.
    expect(loaderContext).not.toBe(null);
    expect(loaderContext.get(servicesContext)).toBe(registry);
    expect(loaderContext.get(userContext)).toBe(null);
  });

  it('a plain-object context is rejected by the real handler (the original defect)', async () => {
    const rr = await import('npm:react-router@8') as unknown as Record<string, unknown>;
    const createRequestHandler = rr.createRequestHandler as (
      build: unknown,
      mode: string,
    ) => unknown;

    const handler: SsrRequestHandler = assembleHandler(
      buildServerBuild(() => {}),
      createRequestHandler,
      'production',
    );

    // This is what the plugin passed before the fix: `{ services, user }`.
    const response = await handler(
      new Request('http://localhost/'),
      { services: {} } as unknown,
    );

    expect(response.status).toBe(500);
  });

  it('createLoadContextFactory produces an instance of the real provider class', async () => {
    const rr = await import('npm:react-router@8') as unknown as Record<string, unknown>;
    const Provider = rr.RouterContextProvider as new () => unknown;

    const context = createLoadContextFactory(rr)();

    // The nominal check RR performs is what makes this assertion the point.
    expect(context).toBeInstanceOf(Provider);
  });
});
