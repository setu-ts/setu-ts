/**
 * V9-27 through a REAL kernel application (M113e plan §3.2): an application
 * serving both browser forms and a bearer-authenticated JSON API, with form
 * CSRF on. A JWT request reaches its handler with no form token; a forged
 * form post, a Basic request, a junk bearer header beside the session
 * cookie of a signed-in user — and, with `exemptBearer: false`, a bearer
 * request — are each refused `403` before the handler runs, through BOTH
 * entry points (the middleware and `verifyCsrfToken`).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireAuth } from '@setu-ts/auth-plugin';

import { SessionPlugin, getSession, verifyCsrfToken } from '../../src/index.ts';
import type { CsrfFormOptions } from '../../src/index.ts';

const SECRET = 'csrf-bearer-integration-secret-at-least-32-chars';
const JWT_SECRET = 'j'.repeat(48);

async function start(csrf: CsrfFormOptions = {}) {
  const ran: string[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SECRET, cookie: { secure: false }, csrf }),
      // The session arm is what makes the COOKIE a credential: with it, a
      // request the session cookie authenticates is a 'cookie' source, which
      // the bearer exemption must NOT exempt.
      AuthPlugin({
        jwt: { secret: JWT_SECRET },
        session: {
          toPrincipal: (view) => {
            const sub = view.data.sub;
            return typeof sub === 'string' ? { id: sub } : null;
          },
        },
      }),
    ],
  });
  // Sign-in through the app's own session: the cookie it sets is the
  // signed-in user's credential. A GET, so it mints the cookie without
  // presenting a form token of its own.
  app.router.get('/login', (ctx) => {
    getSession(ctx).set('sub', 'session-user');
    return ctx.response.json({ ok: true });
  });
  app.router.post('/api/orders', {
    middleware: [requireAuth()],
    handler: (ctx) => {
      ran.push('api');
      return ctx.response.json({ ok: true });
    },
  });
  app.router.post('/form', (ctx) => {
    ran.push('form');
    return ctx.response.json({ ok: true });
  });
  await app.start();
  return { app, ran };
}

async function token(app: IKernelApplication): Promise<string> {
  return await app.services.get<IJwtService>(CAPABILITIES.JWT).sign({ sub: 'ann' });
}

async function post(app: IKernelApplication, path: string, headers: Record<string, string>) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    }),
  );
  await response.body?.cancel();
  return response.status;
}

/** Signs in and returns the session cookie it sets. */
async function signInCookie(app: IKernelApplication): Promise<string> {
  const login = await app.fetch(new Request('http://localhost/login'));
  expect(login.status).toBe(200);
  await login.body?.cancel();
  const cookie = login.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  expect(cookie.length).toBeGreaterThan(0);
  return cookie;
}

describe('form CSRF beside a bearer API (V9-27)', () => {
  it('lets a JWT request through with no form token (default)', async () => {
    const { app, ran } = await start();
    try {
      expect(await post(app, '/api/orders', { authorization: `Bearer ${await token(app)}` })).toBe(
        200,
      );
      expect(ran).toEqual(['api']);
    } finally {
      await app.stop();
    }
  });

  it('refuses a form post carrying no token before the handler runs', async () => {
    const { app, ran } = await start();
    try {
      expect(await post(app, '/form', {})).toBe(403);
      expect(ran).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('refuses Basic credentials, which browsers attach by themselves', async () => {
    const { app, ran } = await start();
    try {
      expect(await post(app, '/form', { authorization: 'Basic dXNlcjpwYXNz' })).toBe(403);
      expect(ran).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('refuses a bearer request again with exemptBearer: false', async () => {
    const { app, ran } = await start({ exemptBearer: false });
    try {
      expect(await post(app, '/api/orders', { authorization: `Bearer ${await token(app)}` })).toBe(
        403,
      );
      expect(ran).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  // The attack the old header-presence rule left open: an origin CORS lets
  // send `Authorization` with credentials adds a junk bearer header to a
  // request the SESSION COOKIE authenticates. The exemption is now decided
  // by the credential that authenticated the request, so the junk header
  // changes nothing and the check runs.
  it("refuses a junk bearer header beside the signed-in user's session cookie", async () => {
    const { app, ran } = await start();
    try {
      const cookie = await signInCookie(app);
      const status = await post(app, '/api/orders', {
        cookie,
        authorization: 'Bearer junk',
      });
      expect(status).toBe(403);
      expect(ran).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});

describe('verifyCsrfToken applies the same bearer rule', () => {
  async function inline(csrf: CsrfFormOptions) {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({ secret: SECRET, cookie: { secure: false } }),
        AuthPlugin({ jwt: { secret: JWT_SECRET } }),
      ],
    });
    app.router.post('/action', async (ctx) => {
      try {
        await verifyCsrfToken(ctx, csrf);
        return ctx.response.json({ verified: true });
      } catch {
        return ctx.response.status(403).json({ verified: false });
      }
    });
    await app.start();
    return app;
  }

  it('skips only a bearer request the JWT authenticated, and fails closed otherwise', async () => {
    const lenient = await inline({});
    const strict = await inline({ exemptBearer: false });
    try {
      // The credential-based exemption: a token that authenticates the request.
      expect(
        await post(lenient, '/action', { authorization: `Bearer ${await token(lenient)}` }),
      ).toBe(200);
      // An unauthenticated bearer header authenticates nothing, so it is
      // verified (and refused: the session carries no token).
      expect(await post(lenient, '/action', { authorization: 'Bearer abc' })).toBe(403);
      // `exemptBearer: false` verifies even an authenticated bearer request.
      expect(
        await post(strict, '/action', { authorization: `Bearer ${await token(strict)}` }),
      ).toBe(403);
      // Basic is never exempt.
      expect(await post(lenient, '/action', { authorization: 'Basic abc' })).toBe(403);
    } finally {
      await lenient.stop();
      await strict.stop();
    }
  });
});
