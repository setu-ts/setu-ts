import { unusedPort as nodeUnusedPort } from '../../../../test/node-helpers.ts';
/**
 * `getService` through the real bridge (M130 §3.2): a real kernel application
 * with `RuntimePlugin` and `ReactRouterPlugin`, served over a real socket, with
 * REAL React Router (`createRequestHandler` + `RouterContextProvider`) running
 * a synthetic server build whose loaders call `getService`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createRequestHandler, RouterContextProvider } from 'react-router';
import type { ServerBuild } from 'react-router';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IRequestContext } from '@setu-ts/common';
import { requestService, resolveRequestService, requestServiceToken } from '@setu-ts/common';
import { ReactRouterPlugin } from '../../src/plugin/react-router-plugin.ts';
import { getService } from '../../src/handler/get-service.ts';
import type { RouterLoadContext, SsrRequestHandler } from '../../src/interfaces/index.ts';

interface Session {
  readonly id: number;
  readonly user: string;
}
const SESSION = requestServiceToken<Session>('module.session-probe');
const MISSING = requestServiceToken<Session>('module.not-registered');
type Loader = (args: { request: Request; context: RouterLoadContext }) => unknown;

function serverBuild(loaders: Record<string, Loader>, errors: unknown[]): unknown {
  const routes: Record<string, unknown> = {
    root: { id: 'root', path: '', module: { default: () => null } },
  };
  for (const [path, loader] of Object.entries(loaders)) {
    routes[`routes/${path}`] = {
      id: `routes/${path}`,
      parentId: 'root',
      path,
      module: { default: () => null, loader },
    };
  }
  return {
    mode: 'production',
    entry: {
      module: {
        default: (
          _request: Request,
          status: number,
          headers: Headers,
          routerContext: {
            loaderData?: Record<string, unknown>;
            staticHandlerContext?: { loaderData: Record<string, unknown> };
          },
        ) => {
          headers.set('content-type', 'application/json');
          const loaderData =
            routerContext.staticHandlerContext?.loaderData ?? routerContext.loaderData;
          return new Response(JSON.stringify(loaderData), { status, headers });
        },
        handleError: (error: unknown, { context }: { context: RouterLoadContext }) => {
          errors.push({ error, hasContext: typeof context.get === 'function' });
        },
      },
    },
    routes,
    assets: { entry: { module: '/e.js', imports: [] }, routes: {}, url: '/m.js', version: '1' },
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'initial' },
  };
}

async function startApp(
  loaders: Record<string, Loader>,
  errors: unknown[] = [],
  onKernelSide: (instance: unknown) => void = () => {},
) {
  let built = 0;
  const handler = createRequestHandler(
    serverBuild(loaders, errors) as unknown as ServerBuild,
    'production',
  ) as unknown as SsrRequestHandler;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ReactRouterPlugin({
        serverBuildPath: './build/server',
        loadRequestHandler: () =>
          Promise.resolve({
            handler,
            createLoadContext: () => new RouterContextProvider() as unknown as RouterLoadContext,
          }),
      }),
    ],
  });
  app.services.register(
    SESSION,
    requestService<Session>((ctx: IRequestContext) => ({
      id: ++built,
      user: ctx.request.headers.get('x-user') ?? 'anonymous',
    })),
  );
  // The kernel entry point: a middleware resolving the same token for the
  // same request, ahead of the page loader.
  app.middleware.add(
    async (ctx, next) => {
      if (ctx.request.path.startsWith('/same')) {
        onKernelSide(resolveRequestService(ctx, SESSION));
      }
      await next();
    },
    { name: 'kernel-side', priority: 500 },
  );
  app.router.get('/api/session', (ctx) => ctx.response.json(resolveRequestService(ctx, SESSION)));
  const port = await nodeUnusedPort();
  await app.start({ port });
  return { app, base: `http://127.0.0.1:${port}`, builds: () => built };
}

describe('getService through the real bridge', () => {
  it('a page loader and kernel code resolve the SAME instance within one request', async () => {
    let kernelSide: unknown;
    let pageSide: unknown;
    const { app, base, builds } = await startApp(
      {
        same: ({ context }) => {
          pageSide = getService(context, SESSION);
          return { session: pageSide };
        },
      },
      [],
      (instance) => {
        kernelSide = instance;
      },
    );
    try {
      const response = await fetch(`${base}/same`, { headers: { 'x-user': 'alice' } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, { session: Session }>;
      expect(body['routes/same']?.session.user).toBe('alice');
      expect(pageSide).toBeDefined();
      expect(pageSide).toBe(kernelSide);
      expect(builds()).toBe(1);

      const api = (await (await fetch(`${base}/api/session`)).json()) as Session;
      expect(api.user).toBe('anonymous');
      expect(api.id).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('gives concurrent requests with different principals different instances', async () => {
    const { app, base } = await startApp({
      who: ({ context }) => ({ session: getService(context, SESSION) }),
    });
    try {
      const users = Array.from({ length: 50 }, (_, i) => `user-${i}`);
      const sessions = await Promise.all(
        users.map(async (user) => {
          const response = await fetch(`${base}/who`, { headers: { 'x-user': user } });
          const text = await response.text();
          if (response.status !== 200) throw new Error(`${response.status}: ${text}`);
          const body = JSON.parse(text) as Record<string, { session: Session }>;
          return body['routes/who']!.session;
        }),
      );
      expect(sessions.map((s) => s.user)).toEqual(users);
      expect(new Set(sessions.map((s) => s.id)).size).toBe(50);
    } finally {
      await app.stop();
    }
  });

  it('a missing token answers 500 through the route boundary and reaches handleError once', async () => {
    const errors: { error: unknown; hasContext: boolean }[] = [];
    const { app, base } = await startApp(
      { missing: ({ context }) => ({ session: getService(context, MISSING) }) },
      errors,
    );
    try {
      const response = await fetch(`${base}/missing`);
      expect(response.status).toBe(500);
      await response.text();
      expect(errors).toHaveLength(1);
      expect((errors[0]!.error as Error).name).toBe('RequestServiceUnavailableError');
      expect(String((errors[0]!.error as Error).message)).toContain('module.not-registered');
      expect(errors[0]!.hasContext).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
