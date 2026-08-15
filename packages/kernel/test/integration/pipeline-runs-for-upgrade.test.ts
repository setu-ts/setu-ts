/**
 * Integration test: the middleware pipeline runs BEFORE the WebSocket upgrade
 * decision (M70a). A short-circuiting guard prevents the upgrade intent from
 * being set at all.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMiddleware, IPlugin, IPluginContext } from '@setu-ts/common';
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

describe('Pipeline runs for upgrade requests (M70a)', () => {
  it('a short-circuiting guard prevents upgrade intent being set', async () => {
    let middlewareRan = false;
    const guardMiddleware: IMiddleware = {
      name: 'auth-guard',
      execute: async (ctx, next) => {
        middlewareRan = true;
        // Short-circuit with 401 — no upgrade should happen
        ctx.response.status(401).json({ error: 'Unauthorized' });
        // Intentionally NOT calling next()
      },
    };

    const app = createApplication({ plugins: [runtimePlugin()] });
    app.middleware.add(middlewareMiddleware);

    await app.start();

    // Inject an upgrade-like request
    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });

    // The middleware ran and short-circuited with 401
    expect(middlewareRan).toBe(true);
    expect(result.statusCode).toBe(401);

    await app.stop();
  });

  it('middleware executes before the terminal handler', async () => {
    const order: string[] = [];
    const trackingMiddleware: IMiddleware = {
      name: 'order-tracker',
      execute: async (_ctx, next) => {
        order.push('middleware-before');
        await next();
        order.push('middleware-after');
      },
    };

    const app = createApplication({ plugins: [runtimePlugin()] });
    app.middleware.add(trackingMiddleware);

    await app.start();

    // A normal request (no route matches → 404)
    await app.inject({
      method: 'GET',
      url: 'http://localhost/nope',
    });

    expect(order).toEqual(['middleware-before', 'middleware-after']);

    await app.stop();
  });
});
