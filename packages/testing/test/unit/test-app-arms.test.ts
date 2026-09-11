import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { createTestApp } from '../../src/test-app.ts';
import type { TestAppFromApp, TestAppFromPlugins, TestAppOptions } from '../../src/test-app.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const runtime = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

function root(extra: IPlugin[] = []) {
  return createApplication({ plugins: [runtimePlugin(), ...extra] });
}

describe('createTestApp — the plugins arm is unchanged', () => {
  it('builds and starts from a plugin list', async () => {
    const app = await createTestApp({ plugins: [runtimePlugin()] });
    app.router.get('/x', (ctx) => ctx.response.json({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the pre-union options shape through an annotated variable', async () => {
    // The union must not break an existing `TestAppOptions` annotation: the
    // plugins arm carries exactly the fields it always did.
    const options: TestAppOptions = { plugins: [runtimePlugin()], autoStart: false };
    const app = await createTestApp(options);

    expect(app.services.has(CAPABILITIES.RUNTIME)).toBe(false); // not started
    await app.start();
    expect(app.services.has(CAPABILITIES.RUNTIME)).toBe(true);
  });
});

describe('createTestApp — the composition-root arm', () => {
  it('starts the supplied application rather than building a second one', async () => {
    const built = root();
    built.router.get('/from-root', (ctx) => ctx.response.json({ ok: true }));

    const app = await createTestApp({ app: built });

    expect(app).toBe(built);
    const res = await app.inject({ method: 'GET', url: '/from-root' });
    expect(res.statusCode).toBe(200);
  });

  it('honours autoStart: false, leaving the window for middleware', async () => {
    const built = root();
    const app = await createTestApp({ app: built, autoStart: false });

    // `middleware.add` throws once start() has compiled the pipeline, so this
    // succeeding IS the proof that start() was not called.
    app.middleware.add(async (ctx, next) => {
      await next();
      ctx.response.header('x-mw', '1');
    }, { priority: 10, name: 'probe' });
    await app.start();

    app.router.get('/y', (ctx) => ctx.response.json({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/y' });
    expect(res.headers.get('x-mw')).toBe('1');
  });

  it('drops each `without` plugin before its register() runs', async () => {
    const ran: string[] = [];
    const eager: IPlugin = {
      name: 'database',
      version: '1.0.0',
      provides: [CAPABILITIES.DATABASE],
      register(ctx: IPluginContext) {
        ran.push('database');
        ctx.services.register(CAPABILITIES.DATABASE, {});
      },
    };

    const app = await createTestApp({ app: root([eager]), without: ['database'] });

    expect(ran).toEqual([]);
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(false);
  });

  it('throws naming an unknown `without` entry', async () => {
    // A silently ignored exclusion runs the whole test against the real
    // plugin while reporting success.
    await expect(
      createTestApp({ app: root(), without: ['databse'] }),
    ).rejects.toThrow(/cannot exclude plugin 'databse'/);
  });

  it('de-duplicates `without`, so a repeated name is not reported as unknown', async () => {
    const ran: string[] = [];
    const eager: IPlugin = {
      name: 'database',
      version: '1.0.0',
      register() {
        ran.push('database');
      },
    };
    // `unregister` removes every match, so the second pass over a repeated name
    // would find nothing and throw "holds no plugin with that name" — blaming
    // the caller's spelling for a plugin the application had in fact held.
    const app = await createTestApp({
      app: root([eager]),
      without: ['database', 'database'],
    });

    expect(ran).toEqual([]);
    expect(app.services.has('database')).toBe(false);
  });

  it('applies `without` before `overrides`', async () => {
    const order: string[] = [];
    const marker: IPlugin = {
      name: 'marker',
      version: '1.0.0',
      register() {
        order.push('marker');
      },
    };
    const dropped: IPlugin = {
      name: 'dropped',
      version: '1.0.0',
      register() {
        order.push('dropped');
      },
    };

    await createTestApp({
      app: root([dropped]),
      without: ['dropped'],
      overrides: [marker],
    });

    expect(order).toEqual(['marker']);
  });

  it('appends `overrides` to an app the caller never gets a window on', async () => {
    // With the default autoStart there is no point between construction and
    // start() at which a caller could register these, which is why the option
    // exists rather than being sugar for app.register().
    const app = await createTestApp({
      app: root(),
      overrides: [{
        name: 'late',
        version: '1.0.0',
        provides: ['late'],
        register(ctx: IPluginContext) {
          ctx.services.register('late', { ok: true });
        },
      }],
    });

    expect(app.services.get<{ ok: boolean }>('late').ok).toBe(true);
  });
});

describe('createTestApp — the arms are mutually exclusive at compile time', () => {
  it('refuses both arms in one options object', () => {
    // @ts-expect-error - `plugins` and `app` cannot be supplied together.
    const both: TestAppOptions = { app: root(), plugins: [runtimePlugin()] };
    expect(both).toBeDefined();
  });

  it('names each arm independently', () => {
    const fromPlugins: TestAppFromPlugins = { plugins: [], autoStart: false };
    const fromApp: TestAppFromApp = { app: root(), without: ['a'], overrides: [] };

    expect(fromPlugins.plugins).toEqual([]);
    expect(fromApp.without).toEqual(['a']);
  });
});
