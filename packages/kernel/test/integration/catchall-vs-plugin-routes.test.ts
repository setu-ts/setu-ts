/**
 * A catch-all plugin against a later-registering route plugin (M70g — X5-1, F1).
 *
 * The unit tests prove the ranking; this proves the composition the register
 * actually reported. `react-router-plugin` mounts `GET /*` at
 * `PLUGIN_PRIORITY.NORMAL` (500) and `openapi-plugin` registers `/openapi.json`
 * and `/docs` at `PLUGIN_PRIORITY.OPENAPI` (700) — deliberately last, so it can
 * see every route it documents. Plugins are sorted ascending, so the catch-all is
 * always in the router first, and before this milestone that alone decided the
 * match: a full-stack application answered the SSR 404 page on both endpoints.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** Stands in for `react-router-plugin`: one catch-all at the default priority. */
function catchAllPlugin(): IPlugin {
  return {
    name: 'ssr',
    version: '1.0.0',
    priority: PLUGIN_PRIORITY.NORMAL,
    register(ctx: IPluginContext) {
      ctx.router.get('/*', (c) => c.response.status(404).json({ from: 'ssr' }));
    },
  };
}

/** Stands in for `openapi-plugin`: single-segment routes, registered last. */
function documentationPlugin(): IPlugin {
  return {
    name: 'openapi',
    version: '1.0.0',
    priority: PLUGIN_PRIORITY.OPENAPI,
    register(ctx: IPluginContext) {
      ctx.router.get('/openapi.json', (c) => c.response.json({ openapi: '3.1.0' }));
      ctx.router.get('/docs', (c) => c.response.json({ from: 'docs' }));
    },
  };
}

describe('catch-all versus later-registering plugin routes', () => {
  it('serves the documentation endpoints a root catch-all used to shadow', async () => {
    const app = createApplication({
      plugins: [runtimePlugin(), catchAllPlugin(), documentationPlugin()],
    });
    await app.start();

    const spec = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json()).toEqual({ openapi: '3.1.0' });

    const docs = await app.inject({ method: 'GET', url: 'http://localhost/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.json()).toEqual({ from: 'docs' });

    await app.stop();
  });

  it('leaves every unclaimed path to the catch-all', async () => {
    const app = createApplication({
      plugins: [runtimePlugin(), catchAllPlugin(), documentationPlugin()],
    });
    await app.start();

    const ssr = await app.inject({ method: 'GET', url: 'http://localhost/products/42' });
    expect(ssr.statusCode).toBe(404);
    expect(ssr.json()).toEqual({ from: 'ssr' });

    await app.stop();
  });

  it('refuses a second claim on the pattern and names the plugin that owns it', async () => {
    // X5-6: `StaticPlugin({ urlPrefix: '/' })` beside SSR. The refusal is correct;
    // what was missing is the name of the plugin already holding the pattern.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        catchAllPlugin(),
        {
          name: 'static-files',
          version: '1.0.0',
          register(ctx: IPluginContext) {
            ctx.router.get('/*', (c) => c.response.send());
          },
        },
      ],
    });

    await expect(app.start()).rejects.toThrow(
      "Route 'GET /*' is already registered by plugin 'ssr'.",
    );
  });
});
