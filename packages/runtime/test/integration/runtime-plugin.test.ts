import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';

import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';

describe('RuntimePlugin integration', () => {
  it('bootstraps with the real Deno adapter and serves a route using runtime.uuid()', async () => {
    const envPerm = await Deno.permissions.query({ name: 'env' });
    if (envPerm.state !== 'granted') {
      return; // skip — permission-less CI
    }

    const app = createApplication({
      plugins: [RuntimePlugin()],
    });

    app.router.get('/uuid', (ctx) => {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      return ctx.response.json({ uuid: runtime.uuid() });
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/uuid' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ uuid: string }>();
    expect(body.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await app.stop();
  });

  it('exposes the real Deno platform via the registered services', async () => {
    const envPerm = await Deno.permissions.query({ name: 'env' });
    if (envPerm.state !== 'granted') {
      return; // skip — permission-less CI
    }

    const app = createApplication({
      plugins: [RuntimePlugin()],
    });

    app.router.get('/platform', (ctx) => {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      return ctx.response.json({
        platform: runtime.platform(),
        version: runtime.version(),
      });
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/platform' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ platform: string; version: string }>();
    expect(body.platform).toBe('deno');
    expect(body.version).toBeTruthy();

    await app.stop();
  });

  it('runtime.now() returns a positive epoch timestamp', async () => {
    const envPerm = await Deno.permissions.query({ name: 'env' });
    if (envPerm.state !== 'granted') {
      return; // skip — permission-less CI
    }

    const app = createApplication({
      plugins: [RuntimePlugin()],
    });

    app.router.get('/now', (ctx) => {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      return ctx.response.json({ now: runtime.now() });
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/now' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ now: number }>();
    expect(body.now).toBeGreaterThan(0);

    await app.stop();
  });
});
