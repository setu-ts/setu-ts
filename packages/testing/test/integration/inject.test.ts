import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { inject } from '../../src/inject.ts';
import { createMockPlugin } from '../../src/mock-plugin.ts';
import { createTestApp } from '../../src/test-app.ts';
import { CAPABILITIES } from '@hono-enterprise/common';

describe('inject — integration through real started app', () => {
  function fakeRuntime(): ReturnType<typeof createMockPlugin> {
    return createMockPlugin({
      name: 'runtime',
      service: {
        platform: () => 'deno' as const,
        version: () => '1.0',
        hostname: () => 'localhost',
        uuid: () => 'test-uuid',
        randomBytes: () => new Uint8Array(0),
        subtle: null as unknown as SubtleCrypto,
        now: () => Date.now(),
        hrtime: () => 0,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: clearTimeout.bind(globalThis),
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: clearInterval.bind(globalThis),
        env: {} as Record<string, string>,
        exit: () => {
          throw new Error('exit');
        },
      },
      provides: CAPABILITIES.RUNTIME,
    });
  }

  it('string URL arm and Request arm return equal status and body for GET', async () => {
    const app = await createTestApp({ plugins: [fakeRuntime()] });

    app.router.get('/users', (ctx) => ctx.response.json({ path: 'users' }));

    const stringRes = await inject(app, '/users');
    expect(stringRes.statusCode).toBe(200);

    const requestRes = await inject(
      app,
      new Request('http://localhost/users'),
    );
    expect(requestRes.statusCode).toBe(200);
    expect(stringRes.json()).toEqual(requestRes.json());

    await app.stop();
  });

  it('POST with JSON body round-trips through response.json()', async () => {
    const app = await createTestApp({ plugins: [fakeRuntime()] });

    app.router.post('/echo', async (ctx) => {
      const body = await ctx.request.json();
      return ctx.response.json(body);
    });

    const res = await inject(app, {
      method: 'POST',
      url: '/echo',
      body: { message: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ message: string }>()).toEqual({ message: 'hello' });

    await app.stop();
  });

  it('byte-body via inject() yields body: null (Uint8Array limitation)', async () => {
    const app = await createTestApp({ plugins: [fakeRuntime()] });

    app.router.get('/bytes', (ctx) => {
      return ctx.response.send(new Uint8Array([1, 2, 3]));
    });

    const injectRes = await inject(app, '/bytes');
    // inject() maps non-string bodies to null (KERNEL BEHAVIOR)
    expect(injectRes.body).toBeNull();

    await app.stop();
  });
});
