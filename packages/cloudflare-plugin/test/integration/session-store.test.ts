/**
 * `KvSessionStore` driven by the real `SessionPlugin`.
 *
 * The store is constructed by the application and handed to the plugin, which
 * is the only wiring that can work — `SessionPluginOptions.store` is read when
 * the plugin is constructed, before any application exists — so this is the
 * path a Worker actually takes, exercised end to end over two requests.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { getSession, SessionPlugin } from '@hono-enterprise/session-plugin';

import { KvSessionStore } from '../../src/index.ts';
import { FakeClock, FakeKv } from '../fakes.ts';

const SECRET = 'a-secret-of-at-least-thirty-two-characters-long';

/** Pulls the cookie a response set, so the next request can present it. */
function cookieFrom(headers: Headers): string {
  const setCookie = headers.get('set-cookie');
  if (setCookie === null) throw new Error('no Set-Cookie on the response');
  return setCookie.split(';')[0] ?? '';
}

describe('KvSessionStore behind SessionPlugin', () => {
  it('persists a session in KV across two requests', async () => {
    const kv = new FakeKv();
    const clock = new FakeClock();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({
          secret: SECRET,
          // 'sign' pairs with a server-side store: the cookie holds only an
          // opaque id, and the payload never leaves KV.
          mode: 'sign',
          store: new KvSessionStore(kv, clock),
        }),
      ],
    });

    app.router.post('/login', (ctx) => {
      getSession(ctx).set('userId', 'u-42');
      return ctx.response.json({ ok: true });
    });

    app.router.get('/me', (ctx) => {
      return ctx.response.json({ userId: getSession(ctx).get('userId') ?? null });
    });

    await app.start();

    const login = await app.inject({ method: 'POST', url: '/login' });
    expect(login.statusCode).toBe(200);

    // The payload is in KV, under the store's own prefix — not in the cookie.
    const stored = [...kv.entries.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.startsWith('session:')).toBe(true);
    expect(kv.entries.get(stored[0] ?? '')).toContain('u-42');

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: cookieFrom(login.headers) },
    });

    expect(JSON.parse(me.body ?? '')).toEqual({ userId: 'u-42' });
    await app.stop();
  });

  it('stops honoring the cookie once the stored row expires', async () => {
    const kv = new FakeKv();
    const clock = new FakeClock();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({
          secret: SECRET,
          mode: 'sign',
          // 10s absolute lifetime: below KV's 60s floor, so the logical
          // deadline in the envelope is what has to enforce it.
          maxAge: 10,
          store: new KvSessionStore(kv, clock),
        }),
      ],
    });

    app.router.post('/login', (ctx) => {
      getSession(ctx).set('userId', 'u-42');
      return ctx.response.json({ ok: true });
    });
    app.router.get('/me', (ctx) => {
      return ctx.response.json({ userId: getSession(ctx).get('userId') ?? null });
    });

    await app.start();
    const login = await app.inject({ method: 'POST', url: '/login' });
    const cookie = cookieFrom(login.headers);

    clock.advance(11_000);

    const me = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(JSON.parse(me.body ?? '')).toEqual({ userId: null });

    await app.stop();
  });

  it('revokes immediately when the session is destroyed', async () => {
    const kv = new FakeKv();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({
          secret: SECRET,
          mode: 'sign',
          store: new KvSessionStore(kv, new FakeClock()),
        }),
      ],
    });

    app.router.post('/login', (ctx) => {
      getSession(ctx).set('userId', 'u-42');
      return ctx.response.json({ ok: true });
    });
    app.router.post('/logout', (ctx) => {
      getSession(ctx).destroy();
      return ctx.response.json({ ok: true });
    });
    app.router.get('/me', (ctx) => {
      return ctx.response.json({ userId: getSession(ctx).get('userId') ?? null });
    });

    await app.start();
    const login = await app.inject({ method: 'POST', url: '/login' });
    const cookie = cookieFrom(login.headers);

    await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });

    // The row is gone from KV, so the still-valid cookie authenticates nothing —
    // the whole reason to run a server-side store.
    expect([...kv.entries.keys()]).toEqual([]);
    const me = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(JSON.parse(me.body ?? '')).toEqual({ userId: null });

    await app.stop();
  });
});
