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
  const calls = { page: 0, form: 0, plain: 0, write: 0 };
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
