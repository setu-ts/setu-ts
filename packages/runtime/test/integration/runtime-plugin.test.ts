import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';

import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';

/**
 * Finds a free TCP port by binding one and releasing it.
 *
 * `app.start()` returns `void`, so the kernel does not surface the port the OS
 * assigns for `port: 0` — the test must pick a concrete port up front.
 */
function findFreePort(): number {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

describe('RuntimePlugin — real HTTP round-trip through app.start({ port })', () => {
  // This is Milestone 39's behavioral criterion: a real socket, a real fetch,
  // and a response that traversed the real middleware -> router -> handler
  // pipeline. Every other test in this repo drives the pipeline through
  // app.inject() or a fake adapter; this one is the only proof that IRequest /
  // IResponse actually map onto HTTP. It must never be allowed to skip.
  it('serves a real fetch through middleware, router, and handler, then stops', async () => {
    const port = findFreePort();
    const seen: string[] = [];

    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.middleware.add(async (ctx, next) => {
      seen.push('middleware');
      ctx.response.header('X-Pipeline', 'middleware');
      await next();
    });

    app.router.get('/greet/:name', (ctx) => {
      seen.push('handler');
      return ctx.response.json({ greeting: `hello ${ctx.params.name}` });
    });

    await app.start({ port });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/greet/world`);

      expect(response.status).toBe(200);
      // Header set by middleware survived IResponse.snapshot() -> native Response.
      expect(response.headers.get('X-Pipeline')).toBe('middleware');
      // Body produced by the handler, with the router's path param bound.
      expect(await response.json()).toEqual({ greeting: 'hello world' });
      // Both pipeline stages ran, in order.
      expect(seen).toEqual(['middleware', 'handler']);
    } finally {
      await app.stop();
    }

    // stop() actually closed the socket.
    await expect(fetch(`http://127.0.0.1:${port}/greet/world`)).rejects.toThrow();
  });

  it('propagates a handler 404 and a non-GET method over a real socket', async () => {
    const port = findFreePort();
    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.router.post('/echo', async (ctx) => {
      const body = await ctx.request.json<{ value: string }>();
      return ctx.response.status(201).json({ echoed: body.value });
    });

    await app.start({ port });

    try {
      const created = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'round-trip' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ echoed: 'round-trip' });

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
      await missing.body?.cancel();
    } finally {
      await app.stop();
    }
  });
});

describe('RuntimePlugin integration', () => {
  it('bootstraps with the real Deno adapter and serves a route using runtime.uuid()', async () => {
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
