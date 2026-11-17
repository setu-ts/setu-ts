import { beforeAll, describe, expect, it } from 'vitest';
import type { ServerBuild } from 'react-router';
import { unstable_preloadRoutePattern } from 'react-router/route-pattern';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import type { PagePolicy, PageRouteSource } from '../../src/index.ts';
import { ReactRouterPlugin } from '../../src/index.ts';
import { pagePolicyBuild } from '../fixtures/page-policy-build.ts';
import type { PageProbe } from '../fixtures/page-policy-build.ts';
import { assembleHandler, createLoadContextFactory } from '../../src/handler/server-build.ts';

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
  '/files/readme',
  '/files/readme.data',
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
        expect(selected).toEqual(expect.arrayContaining(probe.middleware));
        if (response.status === 404 && probe.middleware.length === 0) {
          expect(selected).toEqual(['root']);
        } else {
          expect(selected).toEqual(probe.middleware);
        }
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

interface ReferenceRequest {
  readonly ids: readonly string[];
  readonly actions: readonly string[];
  readonly loaders: readonly string[];
  readonly status: number;
}
const verbs = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const basenames = ['/', '/shop/'] as const;
const routeIds = [
  'root',
  'routes/login',
  'routes/app',
  'routes/app-index',
  'routes/app.settings._index',
  'routes/param',
  'routes/index',
  'routes/splat',
  'routes/readme',
];
const profiles = [
  { name: 'every route', ids: routeIds },
  ...routeIds.map((id) => ({
    name:
      id === 'root'
        ? 'root only'
        : id === 'routes/app'
          ? 'layout only'
          : id === 'routes/splat'
            ? 'splat beside static'
            : `only ${id}`,
    ids: [id],
  })),
  { name: 'child before layout', ids: ['routes/param', 'routes/app'] },
];
function requestUrl(basename: string, path: string): string {
  return `http://local${basename.replace(/\/$/, '')}${path}`;
}
function referenceKey(basename: string, verb: string, path: string): string {
  return JSON.stringify([basename, verb, path]);
}
function resetProbe(probe: PageProbe): void {
  probe.middleware.length = 0;
  probe.actions.length = 0;
  probe.loaders!.length = 0;
  probe.errors.length = 0;
}

describe.skipIf(rr === undefined)(
  'policy subsets and request classes against real React Router',
  () => {
    const references = new Map<string, ReferenceRequest>();
    const fixtures = new Map<string, { build: ServerBuild; probe: PageProbe }>();
    beforeAll(async () => {
      for (const basename of basenames) {
        const probe: PageProbe = {
          middleware: [],
          actions: [],
          loaders: [],
          errors: [],
          emptyDocument: true,
        };
        const build = pagePolicyBuild(basename, probe);
        fixtures.set(basename, { build, probe });
        // These are the same requests with every policy removed: side effects are
        // read from actual route modules through the plugin's real SSR handler.
        const app = createApplication({
          plugins: [RuntimePlugin(), ReactRouterPlugin({ serverBuild: build, basename })],
        });
        await app.start();
        try {
          for (const verb of verbs)
            for (const path of paths) {
              resetProbe(probe);
              const response = await app.fetch(
                new Request(requestUrl(basename, path), { method: verb }),
              );
              await response.arrayBuffer();
              references.set(referenceKey(basename, verb, path), {
                ids: [...probe.middleware],
                actions: [...probe.actions],
                loaders: [...probe.loaders!],
                status: response.status,
              });
            }
        } finally {
          await app.stop();
        }
      }
    });

    for (const basename of basenames)
      for (const on of ['action', 'all'] as const)
        for (const verb of verbs) {
          it.each(profiles)(`$name / ${on} / ${verb} / ${basename}`, async ({ ids }) => {
            const { build, probe } = fixtures.get(basename)!;
            const calls: string[] = [];
            const policies: Record<string, PagePolicy> = Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  on,
                  middleware: [
                    (ctx) => {
                      calls.push(id);
                      return ctx.response.status(429).text('limited');
                    },
                  ],
                } satisfies PagePolicy,
              ]),
            );
            const app = createApplication({
              plugins: [
                RuntimePlugin(),
                ReactRouterPlugin({ serverBuild: build, basename, pagePolicies: policies }),
              ],
            });
            await app.start();
            try {
              const groups = app.router.listRoutes().find((route) => route.method === 'POST')!
                .definition.middlewareGroups!;
              for (const path of paths) {
                const reference = references.get(referenceKey(basename, verb, path))!;
                const applies = on === 'all' || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb);
                const expected = reference.ids.filter(
                  (id) => applies && Object.hasOwn(policies, id),
                );
                const url = requestUrl(basename, path);
                const selected = await groups.select({
                  request: { method: verb, url },
                } as IRequestContext);
                expect
                  .soft(selected, `${verb} ${url} required policy superset`)
                  .toEqual(expect.arrayContaining(expected));
                const rootShortcut = applies && ids.includes('root');
                let overApplied: readonly string[] | undefined;
                if (verb === 'OPTIONS' && on === 'all' && reference.status !== 204) {
                  // (a) React Router rejects OPTIONS before running route middleware.
                  expect.soft(reference.status, `${url} OPTIONS/all baseline status`).toBe(405);
                  expect.soft(reference.ids, `${url} OPTIONS/all baseline middleware`).toEqual([]);
                  const view = references.get(referenceKey(basename, 'GET', path))!;
                  overApplied = [
                    ...(rootShortcut ? ['root'] : []),
                    ...view.ids.filter((id) => id !== 'root' && Object.hasOwn(policies, id)),
                  ];
                  expect
                    .soft(selected, `${url} OPTIONS/all exact over-applied ids`)
                    .toEqual(overApplied);
                } else if (rootShortcut && reference.ids.length === 0 && reference.status !== 204) {
                  // (b) The root shortcut also guards unmatched paths, deliberately.
                  expect
                    .soft(reference.status, `${verb} ${url} unmatched-root baseline status`)
                    .toBe(404);
                  expect
                    .soft(reference.ids, `${verb} ${url} unmatched-root baseline middleware`)
                    .toEqual([]);
                  overApplied = ['root'];
                  expect
                    .soft(selected, `${verb} ${url} unmatched-root exact over-applied ids`)
                    .toEqual(overApplied);
                } else {
                  expect.soft(selected, `${verb} ${url} exact selected ids`).toEqual(expected);
                }
                resetProbe(probe);
                calls.length = 0;
                const response = await app.fetch(new Request(url, { method: verb }));
                await response.arrayBuffer();
                if (expected.length > 0) {
                  expect.soft(response.status, `${verb} ${url} refusal`).toBe(429);
                  expect.soft(calls, `${verb} ${url} first guard`).toEqual([expected[0]]);
                  expect.soft(probe.actions, `${verb} ${url} action side effects`).toEqual([]);
                  expect.soft(probe.loaders, `${verb} ${url} loader side effects`).toEqual([]);
                  expect
                    .soft(
                      reference.actions.length + reference.loaders.length,
                      `${verb} ${url} policy-removed control`,
                    )
                    .toBeGreaterThan(0);
                } else if (overApplied !== undefined && overApplied.length > 0) {
                  expect.soft(response.status, `${verb} ${url} conservative refusal`).toBe(429);
                  expect
                    .soft(calls, `${verb} ${url} conservative first guard`)
                    .toEqual([overApplied[0]]);
                  expect
                    .soft(probe.actions, `${verb} ${url} conservative action side effects`)
                    .toEqual([]);
                  expect
                    .soft(probe.loaders, `${verb} ${url} conservative loader side effects`)
                    .toEqual([]);
                  expect
                    .soft(reference.actions, `${verb} ${url} unguarded baseline actions`)
                    .toEqual([]);
                  expect
                    .soft(reference.loaders, `${verb} ${url} unguarded baseline loaders`)
                    .toEqual([]);
                } else {
                  expect
                    .soft(response.status, `${verb} ${url} unguarded status`)
                    .toBe(reference.status);
                  expect.soft(calls, `${verb} ${url} unguarded calls`).toEqual([]);
                  expect
                    .soft(probe.actions, `${verb} ${url} unguarded actions`)
                    .toEqual(reference.actions);
                  expect
                    .soft(probe.loaders, `${verb} ${url} unguarded loaders`)
                    .toEqual(reference.loaders);
                }
              }
            } finally {
              await app.stop();
            }
          });
        }

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'GET'] as const)(
      'F1 action policy covers %s at the login page',
      async (method) => {
        const probe: PageProbe = {
          middleware: [],
          actions: [],
          loaders: [],
          errors: [],
          emptyDocument: true,
        };
        const build = pagePolicyBuild('/', probe);
        for (const guarded of [true, false]) {
          resetProbe(probe);
          const app = createApplication({
            plugins: [
              RuntimePlugin(),
              ReactRouterPlugin({
                serverBuild: build,
                ...(guarded
                  ? {
                      pagePolicies: {
                        'routes/login': {
                          on: 'action',
                          middleware: [(ctx) => ctx.response.status(429).text('limited')],
                        },
                      },
                    }
                  : {}),
              }),
            ],
          });
          await app.start();
          try {
            const response = await app.fetch(new Request('http://local/login', { method }));
            await response.arrayBuffer();
            expect(response.status).toBe(guarded && method !== 'GET' ? 429 : 200);
            expect(probe.actions).toEqual(method === 'GET' || guarded ? [] : ['routes/login']);
            if (method === 'GET') expect(probe.loaders).toEqual(['root', 'routes/login']);
            else if (guarded) expect(probe.loaders).toEqual([]);
          } finally {
            await app.stop();
          }
        }
      },
    );

    it('A1 refuses the unsupported route-pattern build at registration', async () => {
      const probe: PageProbe = {
        middleware: [],
        actions: [],
        loaders: [],
        errors: [],
        emptyDocument: true,
      };
      const build = pagePolicyBuild('/', probe, [
        { id: 'root', path: '' },
        { id: 'routes/public', parentId: 'root', path: 'a/:x/b/c' },
        { id: 'routes/admin', parentId: 'root', path: 'a/b/:y/:z' },
      ]);
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          ReactRouterPlugin({
            serverBuild: {
              ...build,
              future: { ...build.future, unstable_routePatternMatching: true },
            },
            pagePolicies: {
              'routes/admin': { middleware: [(ctx) => ctx.response.status(429).text('limited')] },
            },
          }),
        ],
      });
      await expect(app.start()).rejects.toThrow('future.unstable_routePatternMatching');
      expect(probe.actions).toEqual([]);
    });

    it('A1 a build swap to route-pattern ranking answers 500 before the admin action, which runs without policies', async () => {
      unstable_preloadRoutePattern();
      const probe: PageProbe = {
        middleware: [],
        actions: [],
        loaders: [],
        errors: [],
        emptyDocument: true,
      };
      const initial = pagePolicyBuild('/', probe, [
        { id: 'root', path: '' },
        { id: 'routes/public', parentId: 'root', path: 'a/:x/b/c' },
        { id: 'routes/admin', parentId: 'root', path: 'a/b/:y/:z' },
      ]);
      const url = 'http://local/a/b/b/c';
      expect(
        rr!
          .matchRoutes(
            [
              {
                id: 'root',
                path: '',
                children: [
                  { id: 'routes/public', path: 'a/:x/b/c' },
                  { id: 'routes/admin', path: 'a/b/:y/:z' },
                ],
              },
            ],
            new URL(url).pathname,
          )
          ?.map((match) => match.route.id),
      ).toEqual(['root', 'routes/public']);
      for (const guarded of [true, false]) {
        resetProbe(probe);
        let current = initial;
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            ReactRouterPlugin({
              serverBuild: initial,
              ...(guarded
                ? {
                    pagePolicies: {
                      'routes/admin': {
                        middleware: [
                          (ctx: IRequestContext) => ctx.response.status(429).text('limited'),
                        ],
                      },
                    },
                  }
                : {}),
              loadRequestHandler: () =>
                Promise.resolve({
                  handler: assembleHandler(
                    () => Promise.resolve(current),
                    rr!.createRequestHandler as Parameters<typeof assembleHandler>[1],
                    'development',
                  ),
                  createLoadContext: createLoadContextFactory(rr!),
                  pageRoutes: { build: () => current, matchRoutes: rr!.matchRoutes },
                }),
            }),
          ],
        });
        await app.start();
        const flagged = {
          ...initial,
          future: { ...initial.future, unstable_routePatternMatching: true },
        };
        current = flagged;
        try {
          const response = await app.fetch(new Request(url, { method: 'POST' }));
          await response.arrayBuffer();
          expect(response.status).toBe(guarded ? 500 : 200);
          expect(probe.actions).toEqual(guarded ? [] : ['routes/admin']);
          expect(probe.middleware).toEqual(guarded ? [] : ['root', 'routes/admin']);
        } finally {
          await app.stop();
        }
      }
    });

    it('F3 refuses /manifest with a slash-less manifest path and no build basename', async () => {
      const probe: PageProbe = {
        middleware: [],
        actions: [],
        loaders: [],
        errors: [],
        emptyDocument: true,
      };
      const { basename, ...withoutBasename } = pagePolicyBuild('/', probe);
      expect(basename).toBe('/');
      const build = {
        ...withoutBasename,
        routes: { root: { ...withoutBasename.routes['root']!, path: '*' } },
        routeDiscovery: { mode: 'lazy', manifestPath: 'manifest' },
      };
      for (const guarded of [true, false]) {
        resetProbe(probe);
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            ReactRouterPlugin({
              serverBuild: build,
              ...(guarded
                ? {
                    pagePolicies: {
                      root: { middleware: [(ctx) => ctx.response.status(429).text('limited')] },
                    },
                  }
                : {}),
            }),
          ],
        });
        await app.start();
        try {
          const response = await app.fetch(
            new Request('http://local/manifest', { method: 'POST' }),
          );
          await response.arrayBuffer();
          expect(response.status).toBe(guarded ? 429 : 200);
          expect(probe.actions).toEqual(guarded ? [] : ['root']);
        } finally {
          await app.stop();
        }
      }
    });
  },
);
