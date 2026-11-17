import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import type { PagePolicy, PageRouteSource } from '../../src/index.ts';
import { ReactRouterPlugin } from '../../src/index.ts';
import { pagePolicyBuild } from '../fixtures/page-policy-build.ts';
import type { PageProbe } from '../fixtures/page-policy-build.ts';

let rr: typeof import('react-router') | undefined;
try {
  rr = await import('react-router');
} catch {
  rr = undefined;
}

// Each row is a URL shape in the source probe; include the manifest's early return.
const paths = [
  '/login',
  '/login.data',
  '/login/',
  '/login/_.data',
  '/',
  '/_.data',
  '/_.data?index',
  '/app',
  '/app?index',
  '/app.data?index',
  '/app.data',
  '/app.data?_routes=routes/app',
  '/app.data?_routes=',
  '/app/settings',
  '/app/settings.data',
  '/app/settings?index',
  '/app/settings.data?index',
  '/login.data?_routes=routes/login',
  '/app/123',
  '/app/a%2Fb',
  '/LOGIN.data',
  '/unmatched/deep',
  '/__manifest',
  '/login.data.data',
  '//login.data',
  '/login%2Edata',
  '/?index',
  '/files/a/b',
] as const;
const bypasses = [
  { path: '/login', id: 'routes/login' },
  { path: '/login.data', id: 'routes/login' },
  { path: '/login/_.data', id: 'routes/login' },
  { path: '/app?index', id: 'routes/app-index' },
  { path: '/app/settings', id: 'routes/app.settings._index' },
  { path: '/app/settings.data', id: 'routes/app.settings._index' },
  { path: '/app/settings?index', id: 'routes/app.settings._index' },
  { path: '/app/settings.data?index', id: 'routes/app.settings._index' },
] as const;

describe.skipIf(rr === undefined)('page policies against real React Router', () => {
  for (const basename of ['/', '/shop/']) {
    it.each(paths)(`matches React Router middleware on ${basename} + %s`, async (path) => {
      const probe: PageProbe = { middleware: [], actions: [], errors: [] };
      const build = pagePolicyBuild(basename, probe);
      const policies: Record<string, PagePolicy> = Object.fromEntries(
        Object.keys(build.routes).map((id) => [
          id,
          {
            middleware: [(_ctx: unknown, next: () => Promise<void>) => next()],
          },
        ]),
      );
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          ReactRouterPlugin({
            serverBuild: build,
            basename,
            pagePolicies: policies,
          }),
        ],
      });
      await app.start();
      try {
        const groups = app.router.listRoutes().find((route) => route.method === 'POST')!.definition
          .middlewareGroups!;
        // Concatenate rather than URL-resolve: //login.data remains a double-slash pathname.
        const url = `http://local${basename.replace(/\/$/, '')}${path}`;
        const selected = await groups.select({
          request: { method: 'POST', url },
        } as IRequestContext);
        const response = await rr!.createRequestHandler(build, 'production')(
          new Request(url, { method: 'POST' }),
          new rr!.RouterContextProvider(),
        );
        await response.body?.cancel();
        expect(response.status).not.toBe(500);
        expect(selected).toEqual(probe.middleware);
      } finally {
        await app.stop();
      }
    });
  }

  for (const basename of ['/', '/shop/']) {
    it.each(bypasses)(
      `refuses ${basename} + $path before its real action side effect, and allows it with the policy removed`,
      async ({ path, id }) => {
        const probe: PageProbe = { middleware: [], actions: [], errors: [], emptyDocument: true };
        const build = pagePolicyBuild(basename, probe);
        const url = `http://local${basename.replace(/\/$/, '')}${path}`;
        for (const guarded of [true, false]) {
          probe.actions.length = 0;
          const refuse: MiddlewareFunction = (ctx) => ctx.response.status(429).text('limited');
          const app = createApplication({
            plugins: [
              RuntimePlugin(),
              ReactRouterPlugin({
                serverBuild: build,
                basename,
                ...(guarded ? { pagePolicies: { [id]: { middleware: [refuse] } } } : {}),
              }),
            ],
          });
          await app.start();
          try {
            if (guarded) {
              const response = await app.inject({ method: 'POST', url });
              expect(response.statusCode).toBe(429);
              expect(response.body).toBe('limited');
              expect(probe.actions).toEqual([]);
            } else {
              if (new URL(url).pathname.endsWith('.data')) {
                // inject cancels streaming data responses after the real action has run.
                await expect(app.inject({ method: 'POST', url })).rejects.toThrow(
                  'inject() cannot read a streaming response body',
                );
              } else {
                expect((await app.inject({ method: 'POST', url })).statusCode).toBe(200);
              }
              expect(probe.actions).toEqual([id]);
            }
          } finally {
            await app.stop();
          }
        }
      },
    );
  }

  it('uses the public matcher from the installed module', () => {
    const source: PageRouteSource = {
      build: () => ({}),
      matchRoutes: rr!.matchRoutes,
    };
    expect(source.matchRoutes).toBe(rr!.matchRoutes);
  });
});
