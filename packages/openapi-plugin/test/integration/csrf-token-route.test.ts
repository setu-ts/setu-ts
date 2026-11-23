/**
 * The Swagger UI form-CSRF token route, and the docs routes that start no session, through a real
 * kernel application with the session plugin.
 */
import { describe, expect, it } from 'vitest';
import type { IPlugin, ITenant } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import type { SessionPluginOptions } from '@setu-ts/session-plugin';

import { OpenApiPlugin } from '../../src/index.ts';

const SECRET = 'test-session-secret-at-least-32-chars';

const get = (url: string, headers: Record<string, string> = {}) =>
  ({ method: 'GET', url: `http://localhost${url}`, headers }) as const;

function cookieOf(headers: Headers): string {
  return headers.getSetCookie()[0]!.split(';')[0]!;
}

async function buildApp(
  session: Partial<SessionPluginOptions> = { csrf: {} },
  extra: IPlugin[] = [],
) {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ...extra,
      SessionPlugin({ secret: SECRET, ...session }),
      OpenApiPlugin({ swagger: { assets: 'cdn' } }),
    ],
  });
  app.router.get('/signin', (ctx) => {
    getSession(ctx).set('userId', 'alice');
    return ctx.response.json({ ok: true });
  });
  await app.start();
  return app;
}

describe('Swagger UI CSRF token route', () => {
  it('answers 204 and starts no session for a visitor without one', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject(get('/docs/csrf-token'));
      expect(res.statusCode).toBe(204);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.getSetCookie()).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('mints and commits a token for a restored session that has none', async () => {
    const app = await buildApp();
    try {
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      const res = await app.inject(get('/docs/csrf-token', { cookie }));
      expect(res.statusCode).toBe(200);
      const body = res.json<{ headerName: string; token: string }>();
      expect(body.headerName).toBe('x-csrf-token');
      expect(body.token.length).toBeGreaterThan(20);
      expect(res.headers.getSetCookie()).toHaveLength(1);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      // The same token comes back on the next call, with no new cookie.
      const next = cookieOf(res.headers);
      const again = await app.inject(get('/docs/csrf-token', { cookie: next }));
      expect(again.json<{ token: string }>().token).toBe(body.token);
      expect(again.headers.getSetCookie()).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('serves the configured header name', async () => {
    const app = await buildApp({ csrf: { headerName: 'x-form-token' } });
    try {
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      const res = await app.inject(get('/docs/csrf-token', { cookie }));
      expect(res.json<{ headerName: string }>().headerName).toBe('x-form-token');
    } finally {
      await app.stop();
    }
  });

  it('answers 204 with no-store when form CSRF is not installed', async () => {
    const app = await buildApp({});
    try {
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      const res = await app.inject(get('/docs/csrf-token', { cookie }));
      expect(res.statusCode).toBe(204);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.getSetCookie()).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('the docs page and the spec commit no session, even under a rolling session', async () => {
    const app = await buildApp({ csrf: {}, rolling: true });
    try {
      for (const url of ['/docs', '/openapi.json']) {
        expect((await app.inject(get(url))).headers.getSetCookie()).toEqual([]);
      }
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      for (const url of ['/docs', '/openapi.json']) {
        expect((await app.inject(get(url, { cookie }))).headers.getSetCookie()).toEqual([]);
      }
    } finally {
      await app.stop();
    }
  });

  it('the docs page commits no session for a tenant-sealed first visit', async () => {
    const tenant: IPlugin = {
      name: 'fixed-tenant',
      version: '1.0.0',
      register(ctx) {
        ctx.middleware.add(
          async (c, next) => {
            c.request.tenant = { id: 'acme' } as ITenant;
            await next();
          },
          { priority: 40, name: 'fixed-tenant' },
        );
      },
    };
    const app = await buildApp({ csrf: {} }, [tenant]);
    try {
      expect((await app.inject(get('/docs'))).headers.getSetCookie()).toEqual([]);
      // Without the exemption, the same request on an ordinary route seals and commits.
      expect((await app.inject(get('/signin'))).headers.getSetCookie()).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });
});
