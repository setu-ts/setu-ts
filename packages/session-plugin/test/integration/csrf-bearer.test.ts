/**
 * V9-27 through a REAL kernel application (M113e plan §3.2): an application
 * serving both browser forms and a bearer-authenticated JSON API, with form
 * CSRF on. A JWT request reaches its handler with no form token; a forged
 * form post, a Basic request and — with `exemptBearer: false` — a bearer
 * request are each refused `403` before the handler runs, through BOTH entry
 * points (the middleware and `verifyCsrfToken`).
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

import { SessionPlugin, verifyCsrfToken } from '../../src/index.ts';
import type { CsrfFormOptions } from '../../src/index.ts';

const SECRET = 'csrf-bearer-integration-secret-at-least-32-chars';
const JWT_SECRET = 'j'.repeat(48);

async function start(csrf: CsrfFormOptions = {}) {
  const ran: string[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SECRET, cookie: { secure: false }, csrf }),
      AuthPlugin({ jwt: { secret: JWT_SECRET } }),
    ],
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
});

describe('verifyCsrfToken applies the same bearer rule', () => {
  async function inline(csrf: CsrfFormOptions) {
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, cookie: { secure: false } })],
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

  it('skips a bearer request by default and verifies it with exemptBearer: false', async () => {
    const lenient = await inline({});
    const strict = await inline({ exemptBearer: false });
    try {
      expect(await post(lenient, '/action', { authorization: 'Bearer abc' })).toBe(200);
      expect(await post(strict, '/action', { authorization: 'Bearer abc' })).toBe(403);
      expect(await post(lenient, '/action', { authorization: 'Basic abc' })).toBe(403);
    } finally {
      await lenient.stop();
      await strict.stop();
    }
  });
});
