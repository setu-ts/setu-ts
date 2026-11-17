import { describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tempDir } from '../../../../test/node-helpers.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { MiddlewareFunction } from '@setu-ts/common';
import { ReactRouterPlugin } from '../../src/index.ts';
import type { PageRouteSource, SsrRuntime } from '../../src/index.ts';
import { createFakeLoadContextFactory } from '../fixtures/fake-handler.ts';
import { pagePolicyBuild } from '../fixtures/page-policy-build.ts';
import type { PageProbe } from '../fixtures/page-policy-build.ts';

let rr: typeof import('react-router') | undefined;
try {
  rr = await import('react-router');
} catch {
  rr = undefined;
}

describe('page policies through kernel dispatch', () => {
  const build = {
    routes: {
      root: { id: 'root', path: '' },
      login: { id: 'login', parentId: 'root', path: 'login' },
    },
  };
  const matchRoutes: PageRouteSource['matchRoutes'] = () => [{ route: { id: 'login' } }];

  function fakeApp(middleware: readonly MiddlewareFunction[], source?: PageRouteSource) {
    let rendered = 0;
    const runtime: SsrRuntime = {
      handler: () => {
        rendered++;
        return Promise.resolve(new Response(null, { status: 202 }));
      },
      createLoadContext: createFakeLoadContextFactory(),
      pageRoutes: source ?? { build: () => build, matchRoutes },
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ReactRouterPlugin({
          serverBuild: build,
          pagePolicies: { login: { middleware } },
          loadRequestHandler: () => Promise.resolve(runtime),
        }),
      ],
    });
    return { app, renders: () => rendered };
  }

  async function publicFileApp(policies: 'absent' | 'empty' | 'refuse', publicFiles = true) {
    const directory = await tempDir({ prefix: 'page-public-files-' });
    await mkdir(`${directory}/client/assets`, { recursive: true });
    await writeFile(`${directory}/client/robots.txt`, 'User-agent: *');
    let policyCalls = 0;
    let renders = 0;
    const refuse: MiddlewareFunction = (ctx) => {
      policyCalls++;
      return ctx.response.status(429).text('limited');
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ReactRouterPlugin({
          serverBuild: build,
          assetsDir: `${directory}/client/assets`,
          publicFiles,
          ...(policies === 'absent'
            ? {}
            : {
                pagePolicies: policies === 'empty' ? {} : { root: { middleware: [refuse] } },
              }),
          loadRequestHandler: () =>
            Promise.resolve({
              handler: () => {
                renders++;
                return Promise.resolve(new Response(null, { status: 202 }));
              },
              createLoadContext: createFakeLoadContextFactory(),
              pageRoutes: { build: () => build, matchRoutes: () => [{ route: { id: 'root' } }] },
            }),
        }),
      ],
    });
    return {
      app,
      policyCalls: () => policyCalls,
      renders: () => renders,
      cleanup: () => rm(directory, { recursive: true }),
    };
  }

  it('serves public hits and malformed paths before policies, while a GET miss reaches the root refusal', async () => {
    const fixture = await publicFileApp('refuse');
    const { app } = fixture;
    try {
      await app.start();
      const routes = app.router.listRoutes();
      const get = routes.find((route) => route.method === 'GET' && route.path === '/*')!.definition;
      const post = routes.find((route) => route.method === 'POST')!.definition;
      expect(get.handler).toBe(post.handler);
      expect(get.middleware).toHaveLength(1);
      expect(get.middlewareGroups).toBe(post.middlewareGroups);
      const hit = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(hit.statusCode).toBe(200);
      expect(hit.body).toBe('User-agent: *');
      expect(fixture.policyCalls()).toBe(0);
      expect((await app.inject({ method: 'GET', url: '/%zz.txt' })).statusCode).toBe(400);
      expect(fixture.policyCalls()).toBe(0);
      const miss = await app.inject({ method: 'GET', url: '/missing' });
      expect(miss.statusCode).toBe(429);
      expect(miss.body).toBe('limited');
      expect(fixture.policyCalls()).toBe(1);
      expect(fixture.renders()).toBe(0);
    } finally {
      await app.stop();
      await fixture.cleanup();
    }
  });

  it.each(['absent', 'empty'] as const)(
    'keeps the existing GET handler registration with %s policies',
    async (policies) => {
      const fixture = await publicFileApp(policies);
      const { app } = fixture;
      try {
        await app.start();
        const routes = app.router.listRoutes();
        const get = routes.find(
          (route) => route.method === 'GET' && route.path === '/*',
        )!.definition;
        const post = routes.find((route) => route.method === 'POST')!.definition;
        expect(get.handler).not.toBe(post.handler);
        expect(get.middleware).toBeUndefined();
        expect(get.middlewareGroups).toBeUndefined();
        expect((await app.inject({ method: 'GET', url: '/robots.txt' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/missing' })).statusCode).toBe(202);
        expect(fixture.renders()).toBe(1);
        expect(fixture.policyCalls()).toBe(0);
      } finally {
        await app.stop();
        await fixture.cleanup();
      }
    },
  );

  it('runs the policy on a public filename when public files are disabled', async () => {
    const fixture = await publicFileApp('refuse', false);
    try {
      await fixture.app.start();
      const get = fixture.app.router
        .listRoutes()
        .find((route) => route.method === 'GET' && route.path === '/*')!.definition;
      expect(get.middleware).toBeUndefined();
      expect((await fixture.app.inject({ method: 'GET', url: '/robots.txt' })).statusCode).toBe(
        429,
      );
      expect(fixture.policyCalls()).toBe(1);
      expect(fixture.renders()).toBe(0);
    } finally {
      await fixture.app.stop();
      await fixture.cleanup();
    }
  });

  it('a rate-limit-shaped policy answers 429 without rendering; removing it renders', async () => {
    for (const guarded of [true, false]) {
      const refuse: MiddlewareFunction = (ctx) => ctx.response.status(429).text('rate limited');
      const { app, renders } = fakeApp(guarded ? [refuse] : [(_ctx, next) => next()]);
      await app.start();
      try {
        const response = await app.inject({ method: 'POST', url: '/login' });
        expect(response.statusCode).toBe(guarded ? 429 : 202);
        expect(renders()).toBe(guarded ? 0 : 1);
      } finally {
        await app.stop();
      }
    }
  });

  it('after-next middleware sees the rendered response on the kernel builder', async () => {
    let status = 0;
    const { app } = fakeApp([
      async (ctx, next) => {
        await next();
        status = ctx.response.snapshot().status;
      },
    ]);
    await app.start();
    try {
      expect((await app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(202);
      expect(status).toBe(202);
    } finally {
      await app.stop();
    }
  });

  it('honors new development builds, rebuilding the matched tree', async () => {
    const seen: unknown[] = [];
    let current = {
      routes: {
        root: { id: 'root', path: '' },
        login: { id: 'login', parentId: 'root', path: 'login' },
      },
    };
    const { app, renders } = fakeApp([(ctx) => ctx.response.status(429).text('blocked')], {
      build: () => current,
      matchRoutes: (tree, pathname) => {
        seen.push(tree);
        const root = tree[0] as {
          readonly children: readonly { readonly id: string; readonly path?: string }[];
        };
        const login = root.children.find((route) => route.id === 'login');
        return login !== undefined && login.path === pathname.slice(1)
          ? [{ route: { id: login.id } }]
          : null;
      },
    });
    await app.start();
    try {
      expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(429);
      const first = seen[0];
      expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(429);
      expect(seen).toHaveLength(1);
      current = {
        routes: {
          root: { id: 'root', path: '' },
          login: { id: 'login', parentId: 'root', path: 'moved' },
        },
      };
      expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(202);
      expect(seen).toHaveLength(2);
      expect(seen[1]).not.toBe(first);
      expect(seen[1]).toMatchObject([{ id: 'root', children: [{ id: 'login', path: 'moved' }] }]);
      expect(renders()).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('a development build dropping the policied id answers 500 without rendering', async () => {
    let current: unknown = build;
    const { app, renders } = fakeApp([(_ctx, next) => next()], {
      build: () => current,
      matchRoutes: () => null,
    });
    await app.start();
    try {
      current = {
        routes: {
          root: build.routes.root,
          signin: { id: 'signin', parentId: 'root', path: 'login' },
        },
      };
      expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(500);
      expect(renders()).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it.each([null, 42, {}, { routes: null }, { routes: { bad: { id: 42 } } }])(
    'an invalid development build %j answers 500 without rendering or error details',
    async (invalid) => {
      let registration = true;
      const { app, renders } = fakeApp([(_ctx, next) => next()], {
        build: () => (registration ? build : invalid),
        matchRoutes,
      });
      await app.start();
      registration = false;
      try {
        const response = await app.inject({ method: 'POST', url: '/login' });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('page policies require');
        expect(renders()).toBe(0);
      } finally {
        await app.stop();
      }
    },
  );

  it('a match without a string route id answers 500 without rendering', async () => {
    const { app, renders } = fakeApp([(_ctx, next) => next()], {
      build: () => build,
      matchRoutes: () => [{ route: {} }],
    });
    await app.start();
    try {
      expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(500);
      expect(renders()).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it.each(['build', 'match'])(
    'a per-request %s failure answers 500 without rendering',
    async (failure) => {
      let registration = true;
      const { app, renders } = fakeApp([(_ctx, next) => next()], {
        build: () =>
          registration || failure !== 'build' ? build : Promise.reject(new Error('build failed')),
        matchRoutes: () => {
          throw new Error('match failed');
        },
      });
      await app.start();
      registration = false;
      try {
        expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(500);
        expect(renders()).toBe(0);
      } finally {
        await app.stop();
      }
    },
  );

  it.skipIf(rr === undefined)(
    'reads a multipart field in policy, then the same field and file bytes in the real action',
    async () => {
      let policyField: unknown;
      let actionField: FormDataEntryValue | null = null;
      let actionBytes: number[] = [];
      const probe: PageProbe = {
        middleware: [],
        actions: [],
        errors: [],
        emptyDocument: true,
        onAction: async (request) => {
          const form = await request.formData();
          actionField = form.get('name');
          const file = form.get('upload');
          expect(file).toBeInstanceOf(File);
          actionBytes = Array.from(new Uint8Array(await (file as File).arrayBuffer()));
          return { received: true };
        },
      };
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          ReactRouterPlugin({
            serverBuild: pagePolicyBuild('/', probe),
            pagePolicies: {
              'routes/login': {
                middleware: [
                  async (ctx, next) => {
                    expect(ctx.request.formData).toBeDefined();
                    policyField = (await ctx.request.formData!()).get('name');
                    await next();
                  },
                ],
              },
            },
          }),
        ],
      });
      const form = new FormData();
      form.set('name', 'twice');
      form.set('upload', new File([new Uint8Array([0, 1, 128, 255])], 'bytes.bin'));
      const request = new Request('http://local/login', { method: 'POST', body: form });
      await app.start();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/login',
          headers: request.headers,
          body: new Uint8Array(await request.arrayBuffer()),
        });
        expect(response.statusCode).toBe(200);
        expect(policyField).toBe('twice');
        expect(actionField).toBe('twice');
        expect(actionBytes).toEqual([0, 1, 128, 255]);
        expect(probe.actions).toEqual(['routes/login']);
      } finally {
        await app.stop();
      }
    },
  );
});
