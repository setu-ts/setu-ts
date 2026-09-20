import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { RouteDefinition } from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

describe('diagnostics registration projection', () => {
  it('projects plugins, declared edges, and observed registrations with owners', async () => {
    let constructed = 0;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'store',
          version: '1.0.0',
          provides: ['store'],
          dependencies: ['runtime'],
          consumes: ['clock'],
          register(ctx) {
            ctx.services.register('store', { kind: 'instance' });
            ctx.services.registerFactory('lazy', () => {
              constructed++;
              return { kind: 'lazy' };
            });
          },
        },
      ],
      diagnostics: {
        labels: { plugins: ['store'], capabilities: ['store', 'lazy', 'runtime'] },
      },
    });
    await app.start();
    const snapshot = app.diagnostics!.snapshot();

    const store = snapshot.nodes.find((node) => node.label === 'store' && node.kind === 'plugin');
    expect(store?.id).toMatch(/^p\d+$/);
    // Declared edges are declared — provides/requires/consumes — and the
    // OBSERVED registration adds `owns` plus the registered flag.
    const provides = snapshot.edges.filter((edge) => edge.kind === 'provides');
    expect(provides.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.edges.some((edge) => edge.kind === 'requires')).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === 'consumes')).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === 'owns')).toBe(true);
    const storeCapability = snapshot.nodes.find((node) =>
      node.label === 'store' && node.kind === 'capability'
    );
    expect(storeCapability?.registered).toBe(true);
    // An unsatisfied `consumes` still projects its declared edge.
    expect(snapshot.nodes.some((node) => node.label === 'clock')).toBe(false);
    expect(snapshot.edges.some((edge) => edge.kind === 'consumes')).toBe(true);

    // Reading the snapshot never resolved the lazy factory.
    expect(constructed).toBe(0);
    await app.stop();
  });

  it('routes and their middleware stages carry owners, methods, and positions', async () => {
    const middleware = (
      _ctx: import('@setu-ts/common').IRequestContext,
      next: () => Promise<void>,
    ): Promise<void> => next();
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'routes',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/users', {
              handler: (c) => c.response.json({ users: [] }),
              middleware: [middleware],
            });
            ctx.router.get('/users/:id', (c) => c.response.json({ id: 1 }));
          },
        },
      ],
      diagnostics: { labels: { plugins: ['routes'], routes: ['/users'] } },
    });
    await app.start();
    const snapshot = app.diagnostics!.snapshot();
    const route = snapshot.nodes.find((node) => node.label === '/users');
    expect(route?.method).toBe('GET');
    // Route middleware stages carry only id and position — no function names.
    const stages = snapshot.nodes.filter((node) =>
      node.kind === 'middleware' && node.position !== undefined
    );
    expect(stages.length).toBe(1);
    expect(stages[0]!.label).toBeUndefined();
    expect(stages[0]!.position).toBe(1);
    await app.stop();
  });

  it('the direct-match fast path and the ranked fallback name the same route node', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/things', (c) => c.response.json({ all: true }));
            ctx.router.get('/things/:id', (c) => c.response.json({ id: '7' }));
            ctx.router.get('/*', (c) => c.response.json({ catchall: true }));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    // Overlapping patterns exercise the ranked fallback; the unique pattern
    // exercises the single-candidate fast path.
    await app.inject({ method: 'GET', url: '/things/7' });
    await app.inject({ method: 'GET', url: '/other' });
    const handlerEvents = app.diagnostics!.read(0, 128).events.filter(
      (event) => event.kind === 'handler' && event.stage === 'handler' && event.nodeId !== null,
    );
    expect(handlerEvents.length).toBe(2);
    // Each request named the route node its match actually selected.
    expect(handlerEvents[0]!.nodeId).not.toBe(handlerEvents[1]!.nodeId);
    await app.stop();
  });

  it('a registration outside any plugin register() attributes no owner', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'initializer',
          version: '1.0.0',
          register(ctx) {
            // Runs during onInit — AFTER the registration loop, when no
            // plugin owns the moment. The registration is observed, but the
            // collector must not attribute it to an unrelated plugin.
            ctx.lifecycle.onInit(() => {
              ctx.services.register('app-owned', {});
            });
          },
        },
      ],
      diagnostics: { labels: { capabilities: ['app-owned'] } },
    });
    await app.start();
    const snapshot = app.diagnostics!.snapshot();
    const capability = snapshot.nodes.find((node) => node.label === 'app-owned');
    expect(capability?.registered).toBe(true);
    const ownsToCapability = snapshot.edges.filter(
      (edge) => edge.kind === 'owns' && edge.to === capability?.id,
    );
    expect(ownsToCapability).toEqual([]);
    await app.stop();
  });

  it('declared middleware names drive the compiled pipeline projection', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'mw',
          version: '1.0.0',
          register(ctx) {
            ctx.middleware.add((_ctx, next) => next(), { name: 'outer', priority: 10 });
            ctx.middleware.add((_ctx, next) => next(), { name: 'inner', priority: 900 });
          },
        },
      ],
      diagnostics: { labels: { middleware: ['outer'] } },
    });
    await app.start();
    const snapshot = app.diagnostics!.snapshot();
    const outer = snapshot.nodes.find((node) => node.label === 'outer');
    expect(outer?.priority).toBe(10);
    expect(outer?.position).toBe(1);
    const anonymous = snapshot.nodes.find(
      (node) => node.kind === 'middleware' && node.label === undefined && node.priority === 900,
    );
    expect(anonymous?.position).toBe(2);
    await app.stop();
  });

  it('route definitions keep working unchanged for listRoutes consumers', async () => {
    const definition: RouteDefinition = { handler: (c) => c.response.json({}) };
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'r',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/x', definition);
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    expect(app.router.listRoutes()[0]!.definition).toBe(definition);
    await app.stop();
  });
});

describe('diagnostics registration — composition time', () => {
  it('projects routes and capabilities registered BEFORE start(), without an owner', async () => {
    // The shape a CLI-scaffolded project emits inside `createApp()`: a setup
    // call that registers generated routes, plus the hello-world route, both
    // BEFORE `start()`. The sinks used to be installed in `#runStartup()`, so
    // the default template's routes were served by the application and absent
    // from the snapshot entirely.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'controllers',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/from-plugin', (c) => c.response.json({ ok: 1 }));
          },
        },
      ],
      diagnostics: {
        labels: {
          routes: ['/', '/generated', '/from-plugin'],
          capabilities: ['app-registered', 'runtime'],
        },
      },
    });
    app.router.get('/generated', (c) => c.response.json({ gen: 1 }));
    app.router.get('/', (c) => c.response.json({ hello: 1 }));
    app.services.register('app-registered', { v: 1 });
    await app.start();

    const snapshot = app.diagnostics!.snapshot();
    const routes = snapshot.nodes
      .filter((node) => node.kind === 'route')
      .map((node) => node.label)
      .sort();
    expect(routes).toEqual(['/', '/from-plugin', '/generated']);
    expect(
      snapshot.nodes.some((node) => node.kind === 'capability' && node.label === 'app-registered'),
    ).toBe(true);

    // Owner attribution stays honest: no plugin's `register()` was running for
    // the composition-time ones, so only the plugin-registered route is owned.
    const routeIds = new Set(
      snapshot.nodes.filter((node) => node.kind === 'route').map((node) => node.id),
    );
    const ownedRoutes = snapshot.edges.filter((edge) =>
      edge.kind === 'owns' && routeIds.has(edge.to)
    );
    expect(ownedRoutes.length).toEqual(1);
    const owned = snapshot.nodes.find((node) => node.id === ownedRoutes[0].to);
    expect(owned?.label).toEqual('/from-plugin');

    // And every one of them still serves.
    for (const [path, body] of [['/', '{"hello":1}'], ['/generated', '{"gen":1}']] as const) {
      const response = await app.inject({ method: 'GET', url: `http://localhost${path}` });
      expect(response.statusCode).toEqual(200);
      expect(response.body).toEqual(body);
    }
    await app.stop();
  });
});
