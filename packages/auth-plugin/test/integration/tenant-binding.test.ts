import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthService, IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { AuthPlugin, requireAuth } from '../../src/index.ts';

describe('M139a real tenant and authentication pipeline', () => {
  it('binds verified JWTs and scopes application credential lookups with the request', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({ resolver: 'header', required: false }),
        AuthPlugin({
          jwt: { secret: 'm139a-tenant-secret', tenantClaim: 'tid' },
          local: {
            verify: (id, secret, request) =>
              Promise.resolve(
                id === 'ada@example.com' && secret === 'pw' && request?.tenant?.id === 'acme'
                  ? { id: 'ada' }
                  : null,
              ),
          },
        }),
      ],
    });
    app.router.get('/private', {
      middleware: [requireAuth()],
      handler: (ctx) => ctx.response.json({ id: ctx.request.user?.id }),
    });
    app.router.post('/login', async (ctx) => {
      const auth = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);
      const who = await auth.verifyCredentials(
        { identifier: 'ada@example.com', secret: 'pw' },
        ctx.request,
      );
      return ctx.response.status(who === null ? 401 : 200).json(who);
    });
    await app.start();
    try {
      const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
      const token = await jwt.sign({ sub: 'ada', tid: 'acme' });
      for (const [tenant, status] of [
        ['acme', 200],
        ['globex', 401],
        [undefined, 401],
      ] as const) {
        const headers = {
          authorization: `Bearer ${token}`,
          ...(tenant === undefined ? {} : { 'x-tenant-id': tenant }),
        };
        expect((await app.inject({ method: 'GET', url: '/private', headers })).statusCode).toBe(
          status,
        );
      }
      for (const [tenant, status] of [
        ['acme', 200],
        ['globex', 401],
      ] as const) {
        expect(
          (await app.inject({ method: 'POST', url: '/login', headers: { 'x-tenant-id': tenant } }))
            .statusCode,
        ).toBe(status);
      }
    } finally {
      await app.stop();
    }
  });
});
