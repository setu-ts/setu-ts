/**
 * Regression: a handler that answers with a null-body status and a body must
 * serve that status, not kill the request.
 *
 * `new Response(body, { status })` throws
 * `TypeError: Response with null body status cannot have body` for 204, 205
 * and 304. The throw happened inside the adapter, AFTER the pipeline had
 * finished, so no middleware and no `errorHandler` could catch it — the
 * request died with an unhandled exception.
 *
 * Driven through `app.fetch`, never `inject()`: `inject()` builds no native
 * `Response`, so it cannot observe this at all.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('a null-body status written with a body', () => {
  it('serves the status instead of throwing out of app.fetch', async () => {
    const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
    // The shapes an application actually writes. Only `send()` with no
    // argument worked before this fix.
    app.router.get('/json-204', (ctx) => ctx.response.status(204).json({ a: 1 }));
    app.router.get('/text-204', (ctx) => ctx.response.status(204).text(''));
    app.router.get('/bytes-204', (ctx) => ctx.response.status(204).send(new Uint8Array(0)));
    app.router.get('/bare-204', (ctx) => ctx.response.status(204).send());
    app.router.get('/reset-205', (ctx) => ctx.response.status(205).json({ a: 1 }));
    app.router.get('/not-modified-304', (ctx) => ctx.response.status(304).text(''));
    // An easy mistake rather than a correct idiom: `DELETE` idiomatically
    // answers 204, and attaching a confirmation body to it is invalid — a 204
    // carries no content. The body is discarded; a handler that must return a
    // representation should answer 200.
    app.router.delete('/resource', (ctx) => ctx.response.status(204).json({ deleted: true }));
    await app.start();
    try {
      const cases: ReadonlyArray<readonly [string, string, number]> = [
        ['GET', '/json-204', 204],
        ['GET', '/text-204', 204],
        ['GET', '/bytes-204', 204],
        ['GET', '/bare-204', 204],
        ['GET', '/reset-205', 205],
        ['GET', '/not-modified-304', 304],
        ['DELETE', '/resource', 204],
      ];
      for (const [method, path, expected] of cases) {
        const res = await app.fetch(new Request(`http://test.local${path}`, { method }));
        expect(res.status).toBe(expected);
        expect(await res.text()).toBe('');
      }
    } finally {
      await app.stop();
    }
  });

  it('keeps headers the handler and middleware wrote', async () => {
    const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
    app.middleware.add(async (ctx, next) => {
      await next();
      ctx.response.appendHeader('set-cookie', 'sid=abc');
      ctx.response.header('x-security', 'on');
    }, { priority: 10, name: 'after' });
    app.router.delete('/r', (ctx) => ctx.response.status(204).json({ deleted: true }));
    await app.start();
    try {
      const res = await app.fetch(new Request('http://test.local/r', { method: 'DELETE' }));
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      // Dropping the body must not drop the response's headers.
      expect(res.headers.get('x-security')).toBe('on');
      expect(res.headers.getSetCookie()).toEqual(['sid=abc']);
    } finally {
      await app.stop();
    }
  });

  it('leaves an ordinary status carrying its body', async () => {
    const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
    app.router.get('/ok', (ctx) => ctx.response.status(200).json({ a: 1 }));
    app.router.get('/created', (ctx) => ctx.response.status(201).json({ a: 1 }));
    app.router.get('/partial', (ctx) => ctx.response.status(206).text('chunk'));
    await app.start();
    try {
      expect(await (await app.fetch(new Request('http://test.local/ok'))).text()).toBe('{"a":1}');
      expect(await (await app.fetch(new Request('http://test.local/created'))).text()).toBe(
        '{"a":1}',
      );
      expect(await (await app.fetch(new Request('http://test.local/partial'))).text()).toBe(
        'chunk',
      );
    } finally {
      await app.stop();
    }
  });
});
