import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { inject } from '../../src/inject.ts';
import { createMockPlugin } from '../../src/mock-plugin.ts';
import { createTestApp } from '../../src/test-app.ts';
import { CAPABILITIES } from '@setu-ts/common';

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

  // KERNEL BEHAVIOR: inject() UTF-8 decodes a byte body rather than reporting
  // `null`, which used to make a non-empty response look empty and made json()
  // throw for a valid JSON payload sent as bytes.
  it('byte-body via inject() is UTF-8 decoded, not dropped', async () => {
    const app = await createTestApp({ plugins: [fakeRuntime()] });

    app.router.get('/bytes', (ctx) => {
      return ctx.response.send(new TextEncoder().encode('{"ok":true}'));
    });

    const injectRes = await inject(app, '/bytes');
    expect(injectRes.body).toBe('{"ok":true}');
    // A JSON payload sent as bytes is parseable through json().
    expect(injectRes.json<{ ok: boolean }>().ok).toBe(true);

    await app.stop();
  });

  // KERNEL BEHAVIOR: a streaming response cannot be rendered as a string body
  // without draining the live stream, so inject() throws with a pointer to
  // fetch() rather than reporting `body: null` (which reads as "empty").
  it('streaming response via inject() throws and points at fetch()', async () => {
    const app = await createTestApp({ plugins: [fakeRuntime()] });

    app.router.get('/stream', (ctx) => {
      return ctx.response.stream(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk'));
            controller.close();
          },
        }),
      );
    });

    let message = '';
    try {
      await inject(app, '/stream');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('inject() cannot read a streaming response body');
    expect(message).toContain('app.fetch()');

    await app.stop();
  });

  it('POST with empty body does NOT silently become {} — returns 500 with error message (P1-3)', async () => {
    const app = await createTestApp({ plugins: [fakeRuntime()] });

    app.router.post('/parse-json', async (ctx) => {
      // The real kernel will call ctx.request.json() which calls JSON.parse('')
      // This throws SyntaxError, caught by #handleRequest → 500 response
      const body = await ctx.request.json();
      return ctx.response.json(body);
    });

    // Before the P1-3 fix, an empty-string body was dropped from InjectRequest
    // entirely, causing the kernel to default to '{}' and return { ok: true }.
    // After the fix, '' flows through, JSON.parse('') throws, and the kernel
    // returns status 500 with the error JSON.
    const res = await inject(
      app,
      new Request('http://localhost/parse-json', { method: 'POST', body: '' }),
    );
    // Should NOT be 200 with a success body
    expect(res.statusCode).not.toBe(200);
    // The kernel catches the SyntaxError and returns 500 with { error: '...' }
    expect(res.statusCode).toBe(500);

    await app.stop();
  });
});
