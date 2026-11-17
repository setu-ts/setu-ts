import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import { Controller, DecoratorPlugin, Get, Roles } from '../../../decorator-plugin/src/index.ts';
import {
  AuthPlugin,
  requireAuth,
  requireRole,
  requireScopes,
  requireScopedPermission,
} from '../../src/index.ts';

@Controller('/decorated-m139a')
class AdminController {
  @Get('/')
  @Roles('admin')
  index(): { ok: boolean } {
    return { ok: true };
  }
}

describe('M139a scoped token confinement through public entry points', () => {
  it.each([undefined, true, false])('confines a narrow admin token with cap %j', async (cap) => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({
          secret: 'm139a-session-secret-at-least-32-characters',
          cookie: { secure: false },
        }),
        AuthPlugin({
          jwt: { secret: 'm139a-secret-at-least-32-characters' },
          ...(cap === undefined ? {} : { confineScopedTokens: cap }),
          rbac: { roles: { admin: { permissions: ['*'] } } },
          scopedRbac: {
            sources: [
              { kind: 'static', grants: [{ subject: 'admin', role: 'admin', scope: null }] },
            ],
            permissions: ['envelopes:read'],
          },
          session: {
            toPrincipal: (session) =>
              session.data.admin ? { id: 'admin', roles: ['admin'] } : null,
          },
        }),
        DecoratorPlugin({ controllers: [AdminController] }),
      ],
    });
    const ok = (ctx: IRequestContext) => ctx.response.json({ ok: true });
    app.router.get('/role', { middleware: [requireRole('admin')], handler: ok });
    app.router.get('/scoped', {
      middleware: [requireScopedPermission('envelopes:read', { scope: null })],
      handler: ok,
    });
    app.router.get('/scope', { middleware: [requireScopes('envelopes:read')], handler: ok });
    app.router.get('/cookie', {
      middleware: [requireAuth({ credentials: 'cookie' })],
      handler: ok,
    });
    app.router.get('/sign-in', (ctx) => {
      getSession(ctx).set('admin', true);
      return ok(ctx);
    });
    await app.start();
    try {
      const token = await app.services
        .get<IJwtService>(CAPABILITIES.JWT)
        .sign({ sub: 'admin', roles: ['admin'], scope: 'envelopes:read' });
      const headers = { authorization: `Bearer ${token}` };
      for (const url of ['/role', '/scoped', '/decorated-m139a']) {
        expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(
          cap === false ? 200 : 403,
        );
      }
      expect((await app.inject({ method: 'GET', url: '/scope', headers })).statusCode).toBe(200);
      const login = await app.fetch(new Request('http://localhost/sign-in'));
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      await login.text();
      expect(cookie).not.toBe('');
      for (const url of ['/role', '/scoped', '/decorated-m139a', '/cookie']) {
        expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(
          200,
        );
      }
      // Header strategies win when both credentials are sent; input cannot forge the source.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/cookie',
            headers: { cookie, ...headers, 'x-credential-source': 'cookie' },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.stop();
    }
  });
});

describe('audit F1 malformed scopes remain confined', () => {
  it.each([{ scope: ['envelopes:read'] }, { scope: 42 }, { scp: ['envelopes:read', 1] }])(
    'authenticates but refuses role and scope access for %j',
    async (claims) => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          AuthPlugin({
            jwt: { secret: 'audit-f1-secret-at-least-32-characters' },
            rbac: { roles: { admin: { permissions: ['*'] } } },
          }),
        ],
      });
      app.router.get('/authenticated', {
        middleware: [requireAuth()],
        handler: (ctx) => ctx.response.json({ id: ctx.request.user?.id }),
      });
      app.router.get('/role', {
        middleware: [requireRole('admin')],
        handler: (ctx) => ctx.response.json({ reached: true }),
      });
      app.router.get('/scope', {
        middleware: [requireScopes('envelopes:read')],
        handler: (ctx) => ctx.response.json({ reached: true }),
      });
      await app.start();
      try {
        const token = await app.services
          .get<IJwtService>(CAPABILITIES.JWT)
          .sign({ sub: 'admin', roles: ['admin'], ...claims });
        const headers = { authorization: `Bearer ${token}` };
        const authenticated = await app.inject({ method: 'GET', url: '/authenticated', headers });
        expect(authenticated.statusCode).toBe(200);
        expect(authenticated.json()).toEqual({ id: 'admin' });
        expect((await app.inject({ method: 'GET', url: '/scope', headers })).statusCode).toBe(403);
        expect((await app.inject({ method: 'GET', url: '/role', headers })).statusCode).toBe(403);
      } finally {
        await app.stop();
      }
    },
  );
});
