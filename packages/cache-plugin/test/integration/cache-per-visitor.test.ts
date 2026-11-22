/**
 * `cacheMiddleware` never replays one visitor's page to another, with the session plugin in the
 * same application, whether the cache runs outside the session middleware (priority 250) or inside
 * it (priority 400).
 */
import { describe, expect, it } from 'vitest';
import type { IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, getSession, SessionPlugin } from '@setu-ts/session-plugin';

import { cacheMiddleware, CachePlugin } from '../../src/index.ts';

const SECRET = 'test-session-secret-at-least-32-chars';

const get = (url: string, headers: Record<string, string> = {}) =>
  ({ method: 'GET', url: `http://localhost${url}`, headers }) as const;

function cookieOf(headers: Headers): string {
  return headers.getSetCookie()[0]!.split(';')[0]!;
}

async function buildApp(priority: number) {
  const calls = { page: 0, form: 0, plain: 0, write: 0, profile: 0, cart: 0 };
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      CachePlugin({ store: 'memory' }),
      SessionPlugin({ secret: SECRET, store: 'memory', csrf: {} }),
      {
        name: 'cached-routes',
        version: '1.0.0',
        register(ctx: IPluginContext): void {
          ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }), { priority, name: 'cache' });
          // An application-wide default, set outside the session middleware, on /profile only.
          ctx.middleware.add(
            async (c, next) => {
              if (c.request.path === '/profile') {
                c.response.header('cache-control', 'public, max-age=60');
              }
              await next();
            },
            { priority: 100, name: 'public-default' },
          );
          // Personalised without the session API, as a page rendering ctx.request.user is.
          ctx.router.get('/profile', (c) => {
            calls.profile += 1;
            return c.response.text(`profile ${c.request.headers.get('x-user') ?? 'guest'}`);
          });
          ctx.router.get('/signin', (c) => {
            getSession(c).set('userId', `user-${c.request.headers.get('x-user') ?? 'a'}`);
            return c.response.text('ok');
          });
          ctx.router.get('/page', (c) => {
            calls.page += 1;
            return c.response.text(`hello ${String(getSession(c).get('userId') ?? 'guest')}`);
          });
          ctx.router.get('/form', (c) => {
            calls.form += 1;
            return c.response.text(`token ${getCsrfToken(c)}`);
          });
          // A new visitor's session write, then an explicit `public` (as a route's headers export
          // may set): the commit adds Set-Cookie only after a cache inside it has captured.
          ctx.router.get('/cart', (c) => {
            calls.cart += 1;
            getSession(c).set('cart', `cart-${calls.cart}`);
            c.response.header('cache-control', 'public, max-age=60');
            return c.response.text(`cart-${calls.cart}`);
          });
          ctx.router.get('/write', (c) => {
            calls.write += 1;
            getSession(c).set('visited', true);
            return c.response.text('written');
          });
          ctx.router.get('/plain', (c) => {
            calls.plain += 1;
            return c.response.text('plain');
          });
        },
      },
    ],
  });
  await app.start();
  return { app, calls };
}

describe.each([
  ['outside', 250],
  ['inside', 400],
])('cacheMiddleware %s the session middleware', (_where, priority) => {
  it("never replays a signed-in visitor's page to another visitor or to an anonymous one", async () => {
    const { app, calls } = await buildApp(priority);
    try {
      const alice = cookieOf((await app.inject(get('/signin', { 'x-user': 'alice' }))).headers);
      const bob = cookieOf((await app.inject(get('/signin', { 'x-user': 'bob' }))).headers);
      expect((await app.inject(get('/page', { cookie: alice }))).body).toBe('hello user-alice');
      expect((await app.inject(get('/page', { cookie: bob }))).body).toBe('hello user-bob');
      expect((await app.inject(get('/page'))).body).toBe('hello guest');
      // The anonymous page read the session, so it varies on Cookie: it is stored for cookie-less
      // visitors only, and never served to a request carrying a cookie.
      const guest = await app.inject(get('/page'));
      expect([guest.body, guest.headers.get('x-cache')]).toEqual(['hello guest', 'HIT']);
      const again = await app.inject(get('/page', { cookie: alice }));
      expect([again.body, again.headers.get('x-cache')]).toEqual(['hello user-alice', 'MISS']);
      expect(calls.page).toBe(4);
    } finally {
      await app.stop();
    }
  });

  it("an outer public default never lets a signed-in visitor's page be stored", async () => {
    const { app, calls } = await buildApp(priority);
    try {
      const alice = cookieOf((await app.inject(get('/signin', { 'x-user': 'alice' }))).headers);
      const own = await app.inject(get('/profile', { cookie: alice, 'x-user': 'alice' }));
      expect(own.headers.get('cache-control')).toBe('private, no-store');
      expect((await app.inject(get('/profile'))).body).toBe('profile guest');
      expect(calls.profile).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it("never replays a new visitor's session write marked public to another visitor", async () => {
    const { app, calls } = await buildApp(priority);
    try {
      const first = await app.inject(get('/cart'));
      expect(first.headers.get('cache-control')).toBe('private, no-store');
      expect(first.headers.getSetCookie()).toHaveLength(1);
      const second = await app.inject(get('/cart'));
      expect([second.body, second.headers.get('x-cache')]).toEqual(['cart-2', 'MISS']);
      expect(calls.cart).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('does not store an anonymous token-minting page or an anonymous write', async () => {
    const { app, calls } = await buildApp(priority);
    try {
      const first = await app.inject(get('/form'));
      const second = await app.inject(get('/form'));
      expect(first.body).not.toBe(second.body);
      expect(second.headers.get('x-cache')).toBe('MISS');
      await app.inject(get('/write'));
      await app.inject(get('/write'));
      expect([calls.form, calls.write]).toEqual([2, 2]);
    } finally {
      await app.stop();
    }
  });

  it('still stores and replays an anonymous page that does not touch the session', async () => {
    const { app, calls } = await buildApp(priority);
    try {
      await app.inject(get('/plain'));
      const hit = await app.inject(get('/plain'));
      expect(hit.headers.get('x-cache')).toBe('HIT');
      expect(hit.headers.getSetCookie()).toEqual([]);
      expect(calls.plain).toBe(1);
    } finally {
      await app.stop();
    }
  });
});
