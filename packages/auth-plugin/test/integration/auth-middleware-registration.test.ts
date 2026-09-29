/**
 * AuthPlugin middleware composition through a real kernel application.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IPlugin, IPluginContext, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { AuthPlugin } from '../../src/plugin/auth-plugin.ts';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const runtime = createFakeRuntime(1_000_000);
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

function principalRoute(ctx: IRequestContext): HandlerResult {
  return ctx.response.json({ id: ctx.request.user?.id ?? null });
}

describe('AuthPlugin middleware registration', () => {
  it('authenticates with no hand-added middleware and no JWT capability', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        AuthPlugin({
          apiKey: {
            validate: (key) => Promise.resolve(key === 'valid' ? { id: 'api-user' } : null),
          },
        }),
      ],
    });
    app.router.get('/me', principalRoute);

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/me',
      headers: { 'x-api-key': 'valid' },
    });

    expect(response.json<{ id: string | null }>()).toEqual({ id: 'api-user' });
    expect(app.services.has(CAPABILITIES.JWT)).toBe(false);
    await app.stop();
  });

  it('does not register globally when middleware is false', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        AuthPlugin({
          apiKey: { validate: () => Promise.resolve({ id: 'api-user' }) },
          middleware: false,
        }),
      ],
    });
    app.router.get('/me', principalRoute);

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/me',
      headers: { 'x-api-key': 'valid' },
    });

    expect(response.json<{ id: string | null }>()).toEqual({ id: null });
    await app.stop();
  });

  it('skips excluded paths and excludes nothing by default', async () => {
    let excludedCalls = 0;
    const excluded = createApplication({
      plugins: [
        runtimePlugin(),
        AuthPlugin({
          apiKey: {
            validate: () => {
              excludedCalls += 1;
              return Promise.resolve({ id: 'api-user' });
            },
          },
          middleware: { exclude: ['/metrics'] },
        }),
      ],
    });
    excluded.router.get('/metrics', principalRoute);
    await excluded.start();
    const skipped = await excluded.inject({
      method: 'GET',
      url: 'http://localhost/metrics',
      headers: { 'x-api-key': 'valid' },
    });
    expect(skipped.json<{ id: string | null }>()).toEqual({ id: null });
    expect(excludedCalls).toBe(0);
    await excluded.stop();

    let defaultCalls = 0;
    const defaultApp = createApplication({
      plugins: [
        runtimePlugin(),
        AuthPlugin({
          apiKey: {
            validate: () => {
              defaultCalls += 1;
              return Promise.resolve({ id: 'api-user' });
            },
          },
        }),
      ],
    });
    defaultApp.router.get('/metrics', principalRoute);
    await defaultApp.start();
    const authenticated = await defaultApp.inject({
      method: 'GET',
      url: 'http://localhost/metrics',
      headers: { 'x-api-key': 'valid' },
    });
    expect(authenticated.json<{ id: string | null }>()).toEqual({ id: 'api-user' });
    expect(defaultCalls).toBe(1);
    await defaultApp.stop();
  });

  it('remains correct when an application still adds a second copy', async () => {
    let calls = 0;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        AuthPlugin({
          apiKey: {
            validate: () => {
              calls += 1;
              return Promise.resolve({ id: 'api-user' });
            },
          },
        }),
      ],
    });
    app.middleware.add(authMiddleware(), { name: 'legacy-auth', priority: 300 });
    app.router.get('/me', principalRoute);

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/me',
      headers: { 'x-api-key': 'valid' },
    });

    expect(response.json<{ id: string | null }>()).toEqual({ id: 'api-user' });
    expect(calls).toBe(2);
    await app.stop();
  });
});
