/**
 * Session-only AuthPlugin composition with no JWT service or strategy.
 */

import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import { AuthPlugin, requireAuth } from '../../src/index.ts';

const SESSION_SECRET = 'jwt-optional-session-secret-at-least-32-chars';
const BASE = 'http://localhost';

function buildApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SESSION_SECRET }),
      AuthPlugin({
        session: {
          toPrincipal: (view) => {
            const sub = view.data.sub;
            return typeof sub === 'string' ? { id: sub } : null;
          },
        },
      }),
    ],
  });

  app.router.post('/login', (ctx) => {
    getSession(ctx).set('sub', 'session-user');
    return ctx.response.json({ ok: true });
  });
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ id: ctx.request.user!.id }),
  });
  return app;
}

describe('JWT-optional AuthPlugin', () => {
  let app: IKernelApplication;

  beforeAll(async () => {
    app = buildApp();
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  it('boots a session-only app without registering the JWT capability', () => {
    expect(app.services.has(CAPABILITIES.JWT)).toBe(false);
    expect(app.services.has(CAPABILITIES.AUTH)).toBe(true);
  });

  it('recognizes a session login on the next request with no hand-added middleware', async () => {
    const login = await app.fetch(new Request(`${BASE}/login`, { method: 'POST' }));
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
    expect(cookie).toBeDefined();

    const response = await app.fetch(
      new Request(`${BASE}/me`, { headers: { cookie: cookie! } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'session-user' });
  });

  it('does not accept a bearer token when no JWT strategy is configured', async () => {
    const response = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { authorization: 'Bearer forged.header.signature' },
      }),
    );
    expect(response.status).toBe(401);
  });
});
