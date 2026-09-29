/**
 * Full-stack authentication-to-SSR context composition.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RouterContextKey, RouterLoadContext } from '@setu-ts/react-router-plugin';
import { userContext } from '@setu-ts/react-router-plugin';
import { getSession } from '@setu-ts/session-plugin';
import { createFullStackApp } from '../../src/index.ts';

const SESSION_SECRET = 'full-stack-auth-context-secret-at-least-32-chars';

/** Test stand-in produced by the same loader seam the request handler consumes. */
class TestRouterContextProvider implements RouterLoadContext {
  readonly #values = new Map<RouterContextKey<unknown>, unknown>();

  get<T>(key: RouterContextKey<T>): T {
    if (this.#values.has(key)) {
      return this.#values.get(key) as T;
    }
    if (key.defaultValue !== undefined) {
      return key.defaultValue;
    }
    throw new Error('No value found for context');
  }

  set<T>(key: RouterContextKey<T>, value: T): void {
    this.#values.set(key, value);
  }
}

describe('full-stack starter auth → userContext', () => {
  it('exposes a session principal to SSR with no hand-added auth middleware', async () => {
    const app = createFullStackApp({
      session: { secret: SESSION_SECRET },
      auth: {
        session: {
          toPrincipal: (view) => {
            const subject = view.data.subject;
            return typeof subject === 'string' ? { id: subject } : null;
          },
        },
      },
      reactRouter: {
        serverBuildPath: new URL('./stub-server-build.js', import.meta.url).href,
        loadRequestHandler: () =>
          Promise.resolve({
            createLoadContext: () => new TestRouterContextProvider(),
            handler: (_request, loadContext) => {
              if (!(loadContext instanceof TestRouterContextProvider)) {
                return Promise.reject(new Error('unexpected load context'));
              }
              const principal = loadContext.get(userContext);
              return Promise.resolve(
                Response.json({ id: principal?.id ?? null }),
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
    try {
      const login = await app.fetch(new Request('http://localhost/login', { method: 'POST' }));
      expect(login.status).toBe(200);
      const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
      expect(cookie).toBeDefined();

      const page = await app.fetch(
        new Request('http://localhost/dashboard', { headers: { cookie: cookie! } }),
      );
      expect(page.status).toBe(200);
      expect(await page.json()).toEqual({ id: 'starter-user' });
    } finally {
      await app.stop();
    }
  });
});
