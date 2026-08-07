/**
 * E2E: the whole session lifecycle through a real kernel application.
 *
 * Every write is read back on a subsequent request carrying the returned cookie,
 * so a stub that echoed input without persisting anything would fail here rather
 * than pass at high coverage.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ISessionService } from '@setu-ts/common';

import { getCsrfToken, getSession, SessionPlugin } from '../../src/index.ts';
import type { SessionPluginOptions } from '../../src/index.ts';

const SECRET = 'test-session-secret-at-least-32-chars';

/** Builds an app whose routes exercise every session operation. */
function buildApp(options: Partial<SessionPluginOptions> = {}) {
  const state = { handlerRan: false };
  const app = createApplication({
    plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, ...options })],
  });

  app.router.get('/bump', (ctx) => {
    const session = getSession(ctx);
    const count = (session.get<number>('count') ?? 0) + 1;
    session.set('count', count);
    return ctx.response.json({ count, id: session.id, isNew: session.isNew });
  });

  app.router.get('/read', (ctx) => {
    const session = getSession(ctx);
    return ctx.response.json({
      count: session.get<number>('count') ?? null,
      isNew: session.isNew,
      id: session.id,
    });
  });

  app.router.get('/login', (ctx) => {
    const session = getSession(ctx);
    session.set('user', 'alice');
    session.regenerate();
    return ctx.response.json({ id: session.id });
  });

  app.router.get('/logout', (ctx) => {
    getSession(ctx).destroy();
    return ctx.response.json({ ok: true });
  });

  app.router.get('/form', (ctx) => ctx.response.json({ token: getCsrfToken(ctx) }));

  app.router.post('/form', (ctx) => {
    state.handlerRan = true;
    return ctx.response.json({ accepted: true });
  });

  return { app, state };
}

/** The `name=value` part of the first `Set-Cookie`, ready to send back. */
function cookieOf(headers: Headers): string {
  const raw = headers.get('set-cookie');
  expect(raw).not.toBe(null);
  return (raw as string).split(';')[0];
}

const get = (url: string, cookie?: string) => ({
  method: 'GET',
  url: `http://localhost${url}`,
  ...(cookie === undefined ? {} : { headers: { cookie } }),
});

describe('session e2e (real kernel app)', () => {
  describe('cookie strategy', () => {
    it('persists a write across requests and restores it', async () => {
      const { app } = buildApp();
      await app.start();

      const first = await app.inject(get('/bump'));
      const body = first.json<{ count: number; isNew: boolean; id: string }>();
      expect(body.count).toBe(1);
      expect(body.isNew).toBe(true);

      const cookie = cookieOf(first.headers);

      // The load-bearing assertion: the value comes back on a later request.
      const second = await app.inject(get('/read', cookie));
      const read = second.json<{ count: number | null; isNew: boolean; id: string }>();
      expect(read.count).toBe(1);
      expect(read.isNew).toBe(false);
      expect(read.id).toBe(body.id);

      const third = await app.inject(get('/bump', cookie));
      expect(third.json<{ count: number }>().count).toBe(2);

      await app.stop();
    });

    it('emits exactly one Set-Cookie when dirty and none when clean', async () => {
      const { app } = buildApp();
      await app.start();

      const dirty = await app.inject(get('/bump'));
      expect(dirty.headers.getSetCookie().length).toBe(1);

      const cookie = cookieOf(dirty.headers);
      const clean = await app.inject(get('/read', cookie));
      // A pure read must not rewrite the cookie: doing so would defeat
      // downstream caching and extend the session on every request.
      expect(clean.headers.get('set-cookie')).toBe(null);

      await app.stop();
    });

    it('applies secure cookie attributes by default', async () => {
      const { app } = buildApp();
      await app.start();

      const raw = (await app.inject(get('/bump'))).headers.get('set-cookie') ?? '';
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('Secure');
      expect(raw).toContain('SameSite=Lax');
      expect(raw).toContain('Path=/');
      expect(raw).toContain('hono_session=');

      await app.stop();
    });

    it('treats a tampered cookie as no session at all', async () => {
      const { app } = buildApp();
      await app.start();

      const first = await app.inject(get('/bump'));
      const cookie = cookieOf(first.headers);
      // Flip one character of the sealed value.
      const tampered = cookie.replace(/=(.)/, (_m, ch) => `=${ch === 'A' ? 'B' : 'A'}`);

      const res = await app.inject(get('/read', tampered));
      const read = res.json<{ count: number | null; isNew: boolean }>();
      expect(read.count).toBe(null);
      expect(read.isNew).toBe(true);

      await app.stop();
    });

    it('regenerate rotates the id but keeps the data', async () => {
      const { app } = buildApp();
      await app.start();

      const first = await app.inject(get('/bump'));
      const originalId = first.json<{ id: string }>().id;
      const cookie = cookieOf(first.headers);

      const login = await app.inject(get('/login', cookie));
      const newId = login.json<{ id: string }>().id;
      expect(newId).not.toBe(originalId);

      const after = await app.inject(get('/read', cookieOf(login.headers)));
      const read = after.json<{ count: number | null; id: string }>();
      expect(read.count).toBe(1);
      expect(read.id).toBe(newId);

      await app.stop();
    });

    it('destroy clears the cookie with Max-Age=0', async () => {
      const { app } = buildApp();
      await app.start();

      const first = await app.inject(get('/bump'));
      const cookie = cookieOf(first.headers);

      const out = await app.inject(get('/logout', cookie));
      const raw = out.headers.get('set-cookie') ?? '';
      expect(raw).toContain('Max-Age=0');

      await app.stop();
    });

    it("round-trips under the non-default mode: 'sign'", async () => {
      const { app } = buildApp({ mode: 'sign' });
      await app.start();

      const first = await app.inject(get('/bump'));
      const cookie = cookieOf(first.headers);
      const second = await app.inject(get('/read', cookie));
      expect(second.json<{ count: number | null }>().count).toBe(1);

      await app.stop();
    });
  });

  describe('store strategy', () => {
    it('keeps the payload server-side and reads it back', async () => {
      const { app } = buildApp({ store: 'memory' });
      await app.start();

      const first = await app.inject(get('/bump'));
      const cookie = cookieOf(first.headers);

      const second = await app.inject(get('/read', cookie));
      expect(second.json<{ count: number | null }>().count).toBe(1);

      await app.stop();
    });

    it('revokes immediately: the old cookie stops working after destroy', async () => {
      const { app } = buildApp({ store: 'memory' });
      await app.start();

      const first = await app.inject(get('/bump'));
      const cookie = cookieOf(first.headers);

      await app.inject(get('/logout', cookie));

      // This is the property the cookie strategy cannot provide: the cookie is
      // still cryptographically valid, but the session behind it is gone.
      const after = await app.inject(get('/read', cookie));
      const read = after.json<{ count: number | null; isNew: boolean }>();
      expect(read.count).toBe(null);
      expect(read.isNew).toBe(true);

      await app.stop();
    });
  });

  describe('form CSRF', () => {
    it('accepts a matching token and rejects everything else without running the handler', async () => {
      const { app, state } = buildApp({ csrf: {} });
      await app.start();

      const page = await app.inject(get('/form'));
      const token = page.json<{ token: string }>().token;
      const cookie = cookieOf(page.headers);
      expect(token.length).toBeGreaterThan(20);

      const post = (body: string) => ({
        method: 'POST',
        url: 'http://localhost/form',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

      state.handlerRan = false;
      const ok = await app.inject(post(`_csrf=${encodeURIComponent(token)}&name=x`));
      expect(ok.statusCode).toBe(200);
      expect(state.handlerRan).toBe(true);

      // Short-circuit: a rejected post must never reach the handler.
      state.handlerRan = false;
      const wrong = await app.inject(post('_csrf=not-the-token&name=x'));
      expect(wrong.statusCode).toBe(403);
      expect(state.handlerRan).toBe(false);

      state.handlerRan = false;
      const absent = await app.inject(post('name=x'));
      expect(absent.statusCode).toBe(403);
      expect(state.handlerRan).toBe(false);

      await app.stop();
    });

    it('does not leak why verification failed', async () => {
      const { app } = buildApp({ csrf: {} });
      await app.start();

      const page = await app.inject(get('/form'));
      const cookie = cookieOf(page.headers);

      const res = await app.inject({
        method: 'POST',
        url: 'http://localhost/form',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: '_csrf=wrong',
      });

      const body = res.body ?? '';
      expect(body).toContain('CSRF token validation failed');
      // An attacker must not learn whether the session or the token was at fault.
      expect(body).not.toContain('session carries no');
      expect(body).not.toContain('did not match');

      await app.stop();
    });

    it('lets safe methods through untouched', async () => {
      const { app } = buildApp({ csrf: {} });
      await app.start();

      const res = await app.inject(get('/form'));
      expect(res.statusCode).toBe(200);

      await app.stop();
    });

    it('accepts the token from a header when one is configured', async () => {
      const { app, state } = buildApp({ csrf: { headerName: 'x-csrf-token' } });
      await app.start();

      const page = await app.inject(get('/form'));
      const token = page.json<{ token: string }>().token;
      const cookie = cookieOf(page.headers);

      state.handlerRan = false;
      const res = await app.inject({
        method: 'POST',
        url: 'http://localhost/form',
        headers: { cookie, 'x-csrf-token': token },
        body: '',
      });
      expect(res.statusCode).toBe(200);
      expect(state.handlerRan).toBe(true);

      await app.stop();
    });
  });

  describe('plugin wiring', () => {
    it('registers the service under CAPABILITIES.SESSION', async () => {
      const { app } = buildApp();
      await app.start();

      expect(app.services.has(CAPABILITIES.SESSION)).toBe(true);
      const service = app.services.get<ISessionService>(CAPABILITIES.SESSION);
      expect(typeof service.from).toBe('function');

      await app.stop();
    });

    it('reports health, including the configured store', async () => {
      const { app } = buildApp({ store: 'memory' });
      await app.start();

      const indicators = app.services.getAll<
        { name: string; check: () => Promise<{ status: string; data?: unknown }> }
      >(CAPABILITIES.HEALTH_INDICATOR);
      const session = indicators.find((i) => i.name === 'session');
      expect(session).toBeDefined();

      const result = await session!.check();
      expect(result.status).toBe('up');
      expect(result.data).toEqual({ strategy: 'store', mode: 'encrypt', keys: 1, store: true });

      await app.stop();
    });
  });
});
