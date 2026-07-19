/**
 * Integration tests for RuntimePlugin — real HTTP round-trip through app.start.
 *
 * These tests bind a real OS socket and issue real fetch requests.
 * They require the `net` permission to be granted.
 *
 * @module
 */

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/**
 * Finds a free TCP port by binding one and releasing it.
 */
function findFreePort(): number {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

describe('runtime-plugin integration', () => {
  it('real HTTP round-trip through app.start({ port })', async () => {
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
      expect(response.headers.get('X-Pipeline')).toBe('middleware');
      const body = await response.json();
      expect(body).toEqual({ greeting: 'hello world' });
      expect(seen).toEqual(['middleware', 'handler']);
    } finally {
      await app.stop();
    }
  });

  it('serves POST /echo and 404 on real socket', async () => {
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
      const echoBody = await created.json();
      expect(echoBody).toEqual({ echoed: 'round-trip' });

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
      await missing.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  it('app.fetch works through adapter', async () => {
    const port = findFreePort();
    const app = createApplication({ plugins: [RuntimePlugin()] });

    app.router.get('/health', (ctx) => {
      return ctx.response.text('healthy');
    });

    await app.start({ port });

    try {
      // Direct socket access
      const response1 = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response1.status).toBe(200);
      expect(await response1.text()).toBe('healthy');

      // Through app.fetch
      const response2 = await app.fetch(
        new Request(`http://127.0.0.1:${port}/health`),
      );
      expect(response2.status).toBe(200);
      expect(await response2.text()).toBe('healthy');
    } finally {
      await app.stop();
    }
  });
});
