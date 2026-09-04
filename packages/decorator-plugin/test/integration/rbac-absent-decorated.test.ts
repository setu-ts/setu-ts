import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { authMiddleware, AuthPlugin, requireRole } from '@setu-ts/auth-plugin';
import { errorHandler } from '@setu-ts/exceptions';

import { Controller, Get, Roles } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

/**
 * §3.5: with enforcement on and NO authorization provider registered, a
 * decorated route FAILS CLOSED — it answers `501` and the handler provably
 * does not run. The first draft of this milestone warned and registered the
 * route UNGUARDED, which is an authorization bypass; this suite is the guard
 * against that shape ever returning.
 *
 * The app uses the M68 composition — `AuthPlugin` WITHOUT the `rbac` arm — so
 * a principal exists (the refusal is not the `401`) while
 * `CAPABILITIES.AUTHORIZATION` is genuinely absent.
 */

const JWT_SECRET = 'x'.repeat(40);

describe('decorated route with no authorization capability (§3.5)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('answers 501 fail-closed and never reaches the handler', async () => {
    let handlerRan = false;

    @Controller('/reports')
    class ReportsController {
      @Get('/digest')
      @Roles('admin')
      digest() {
        handlerRan = true;
        return { digest: true };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: JWT_SECRET } }),
        DecoratorPlugin({ controllers: [ReportsController] }),
      ],
    });
    app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), {
      priority: 0,
      name: 'error-handler',
    });
    app.middleware.add(authMiddleware(), { priority: 100, name: 'auth' });
    // The guarded twin of the decorated route above: same app, same
    // `errorHandler` format, same absent capability, same required role.
    app.router.get('/guarded/digest', {
      middleware: [requireRole('admin')],
      handler: (ctx) => ctx.response.json({ digest: true }),
    });
    await app.start();

    try {
      const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
      // The principal HOLDS the required role — the route is refused for the
      // missing capability, not for the principal.
      const token = await jwt.sign({ sub: 'admin-1', roles: ['admin'] });

      const refused = await app.inject({
        method: 'GET',
        url: 'http://localhost/reports/digest',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(refused.statusCode).toBe(501);
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body.title).toBe('Not Implemented');
      expect(body.detail).toBe('Authorization is not configured');
      expect(handlerRan).toBe(false);

      // This module's doc claims every refusal carries "the same status,
      // title and detail strings `@setu-ts/auth-plugin`'s guards use", and
      // that "the byte-identity is pinned by an integration test rather than
      // by construction". Asserting this suite's own literal did not pin it:
      // §2.2 forbids the SRC import, so the two packages each hold a copy of
      // the string, and M89b's arrival made them disagree — the decorated
      // route said `Authorization is not configured` while the guarded one
      // said `… for this application`, with every gate green.
      //
      // A TEST may import both, so the identity is now DRIVEN: the same app
      // serves a `requireRole` route beside the decorated one and the two
      // bodies are compared. This is what makes the doc's claim checkable.
      const guarded = await app.inject({
        method: 'GET',
        url: 'http://localhost/guarded/digest',
        headers: { authorization: `Bearer ${token}` },
      });

      const guardedBody = (await guarded.json()) as Record<string, unknown>;

      // Everything that DEFINES the refusal must match. `instance` is the
      // request path and must differ: the kernel refuses two routes on one
      // path (M68), so the twin cannot share `/reports/digest`.
      const refusalOf = (body: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'instance'));

      expect(guarded.statusCode).toBe(refused.statusCode);
      expect(refusalOf(guardedBody)).toEqual(refusalOf(body));
      expect(body.instance).toBe('/reports/digest');
      expect(guardedBody.instance).toBe('/guarded/digest');
    } finally {
      await app.stop();
    }
  });
});
