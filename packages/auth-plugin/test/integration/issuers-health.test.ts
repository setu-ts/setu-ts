/**
 * Outside-issuer authentication and the `auth` health indicator through a real
 * kernel application with the real HealthPlugin.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { AuthPlugin, requireAuth } from '../../src/index.ts';
import type { IAuthHttp } from '../../src/index.ts';
import { generateTestKey, signToken } from '../fixtures/issuer-tokens.ts';

const ISS = 'https://idp.test';
const JWKS = 'https://idp.test/jwks';

async function buildApp(available: () => boolean) {
  const key = await generateTestKey('ES256', 'k1');
  const calls: string[] = [];
  const http: IAuthHttp = {
    get: (url) => {
      calls.push(url);
      return Promise.resolve(
        available()
          ? { status: 200, body: JSON.stringify({ keys: [key.jwk] }) }
          : { status: 503, body: '' },
      );
    },
    post: () => Promise.reject(new Error('post is not expected by this fixture')),
  };
  const app: IKernelApplication = createApplication({
    plugins: [
      RuntimePlugin(),
      HealthPlugin(),
      AuthPlugin({
        http,
        jwt: { secret: 'self-issued-secret-at-least-32-characters' },
        issuers: [{
          name: 'idp',
          issuer: ISS,
          audience: 'api',
          keys: { jwksUri: JWKS },
          keySet: { ttlMs: 60_000, minRefreshIntervalMs: 1 },
          toPrincipal: (claims) => ({ id: String(claims.sub), roles: ['from-idp'] }),
        }],
      }),
    ],
  });
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json(ctx.request.user),
  });
  await app.start();
  const token = await signToken(key, {
    iss: ISS,
    aud: 'api',
    sub: 'idp-user',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  return { app, token, calls };
}

async function health(app: IKernelApplication) {
  const response = await app.inject({ method: 'GET', url: '/health' });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe('outside issuers through a real app', () => {
  it('authenticates via the global middleware and reports up once fetched', async () => {
    const { app, token, calls } = await buildApp(() => true);
    try {
      const before = await health(app);
      expect(before.status).toBe(200);
      const checks = before.body.checks as Record<string, { status: string; data: unknown }>;
      expect(checks.auth).toEqual({
        status: 'degraded',
        data: { issuers: { idp: 'unfetched' } },
        latencyMs: expect.any(Number),
      });
      expect(calls).toEqual([]);

      const me = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ id: 'idp-user', roles: ['from-idp'] });

      const after = await health(app);
      const afterChecks = after.body.checks as Record<string, { status: string }>;
      expect(afterChecks.auth.status).toBe('up');
      expect(calls.length).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('refuses when the key set is unreachable and never reports down', async () => {
    const { app, token } = await buildApp(() => false);
    try {
      const me = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(401);
      const report = await health(app);
      expect(report.status).toBe(200);
      const checks = report.body.checks as Record<string, { status: string }>;
      expect(checks.auth.status).toBe('degraded');
    } finally {
      await app.stop();
    }
  });

  it('still authenticates a self-issued JWT through the jwt strategy first', async () => {
    const { app, calls } = await buildApp(() => true);
    try {
      const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
      const own = await jwt.sign({ sub: 'self' }, { expiresIn: '5m' });
      const me = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${own}` },
      });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { id: string }).id).toBe('self');
      expect(calls).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});
