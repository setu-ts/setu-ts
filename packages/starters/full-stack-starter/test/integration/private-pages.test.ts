/**
 * Pages through the React Router bridge are marked by the session plugin: a signed-in document and
 * its `.data` request answer `private, no-store`; an anonymous page that reads no token is not
 * marked; a route's own `Cache-Control` replaces the plugin's value instead of merging with it.
 */
import { describe, expect, it } from 'vitest';
import type { RouterContextKey, RouterLoadContext } from '@setu-ts/react-router-plugin';
import { getSession } from '@setu-ts/session-plugin';
import { createFullStackApp } from '../../src/index.ts';

const SESSION_SECRET = 'full-stack-private-pages-secret-at-least-32-chars';

class TestRouterContextProvider implements RouterLoadContext {
  readonly #values = new Map<RouterContextKey<unknown>, unknown>();

  get<T>(key: RouterContextKey<T>): T {
    if (this.#values.has(key)) return this.#values.get(key) as T;
    if (key.defaultValue !== undefined) return key.defaultValue;
    throw new Error('No value found for context');
  }

  set<T>(key: RouterContextKey<T>, value: T): void {
    this.#values.set(key, value);
  }
}

async function buildApp() {
  const app = createFullStackApp({
    session: { secret: SESSION_SECRET },
    reactRouter: {
      serverBuildPath: new URL('./stub-server-build.js', import.meta.url).href,
      loadRequestHandler: () =>
        Promise.resolve({
          createLoadContext: () => new TestRouterContextProvider(),
          handler: (request) => {
            const path = new URL(request.url).pathname;
            if (path === '/catalogue') {
              return Promise.resolve(
                new Response('<html>catalogue</html>', {
                  headers: { 'cache-control': 'public, s-maxage=60', 'content-type': 'text/html' },
                }),
              );
            }
            return Promise.resolve(
              new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } }),
            );
          },
        }),
    },
  });
  app.router.post('/login', (ctx) => {
    getSession(ctx).set('subject', 'starter-user');
    return ctx.response.json({ ok: true });
  });
  await app.start();
  return app;
}

describe('full-stack starter private pages', () => {
  it('a signed-in document and its .data request answer private, no-store', async () => {
    const app = await buildApp();
    try {
      const login = await app.fetch(new Request('http://localhost/login', { method: 'POST' }));
      const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
      for (const url of ['http://localhost/dashboard', 'http://localhost/dashboard.data']) {
        const page = await app.fetch(new Request(url, { headers: { cookie } }));
        expect(page.status).toBe(200);
        expect(page.headers.get('cache-control')).toBe('private, no-store');
        expect(page.headers.get('vary')).toContain('Cookie');
      }
    } finally {
      await app.stop();
    }
  });

  it('an anonymous page that reads no token is not marked', async () => {
    const app = await buildApp();
    try {
      const page = await app.fetch(new Request('http://localhost/dashboard'));
      expect(page.headers.get('cache-control')).toBeNull();
      expect(page.headers.getSetCookie()).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it("a route's Cache-Control replaces the plugin's value", async () => {
    const app = await buildApp();
    try {
      const login = await app.fetch(new Request('http://localhost/login', { method: 'POST' }));
      const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
      const page = await app.fetch(
        new Request('http://localhost/catalogue', { headers: { cookie } }),
      );
      // One value, not `private, no-store, public, s-maxage=60`.
      expect(page.headers.get('cache-control')).toBe('public, s-maxage=60');
    } finally {
      await app.stop();
    }
  });
});
