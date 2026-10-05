/**
 * Integration test — the tenant-binding compare runs on whichever side sees
 * the tenant SECOND (M101c, V8-7).
 *
 * The session middleware compares at load time (priority 260), which covers
 * every tenant resolved BEFORE it — the shipped resolvers at the default
 * priority 40. The tenant middleware runs the SAME shared compare
 * (`tenantBindingMismatch` in `common`) right after it stamps a tenant, which
 * covers a tenant resolved AFTER the session loaded. This file drives a REAL
 * kernel app with `SessionPlugin` and a custom `ITenantResolver` at
 * `middlewarePriority: 310` (behind the session middleware at 260 and a fake
 * auth middleware at 300 that sets the principal), so the tenant is only known
 * after the session has loaded and parked itself in `ctx.state`.
 *
 * The two compare sites are deliberately byte-identical — the same `403 Tenant
 * Mismatch` through `respondWithError` (the M70f convergence) — so the
 * observable contract is the same regardless of which site fires. What differs
 * is ORDER: with the tenant resolved first (the header resolver at 40) the
 * session middleware's load-time compare fires; with the tenant resolved
 * second (the user resolver at 310) the tenant middleware's compare fires.
 * Both must refuse a session bound to tenant `a` presented under tenant `b`,
 * and neither may rebind the session to the tenant it was just refused under.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import type { ITenantResolver, MiddlewareFunction } from '@setu-ts/common';
import { none, some } from '@setu-ts/common';
import { MultiTenancyPlugin } from '../../src/index.ts';

const SECRET = 'tenant-binding-order-secret-at-least-32-chars';

/** The shared refusal body both compare sites converge on (M70f). */
const MISMATCH_BODY = {
  error: 'Tenant Mismatch',
  detail: 'This session was created for a different tenant',
};

/** The session plugin's default cookie name. */
const SESSION_COOKIE = 'setu_session';

/** Reads the first `setu_session` cookie a response set, or `undefined`. */
function sessionCookie(headers: Headers): string | undefined {
  for (const cookie of headers.getSetCookie()) {
    if (cookie.startsWith(`${SESSION_COOKIE}=`)) return cookie.split(';')[0];
  }
  return undefined;
}

/** A GET to the route under test, with the given headers. */
function hit(
  app: IKernelApplication,
  headers: Record<string, string>,
): Promise<{ statusCode: number; headers: Headers; body: string | null }> {
  return app.inject({ method: 'GET', url: 'http://localhost/data', headers });
}

/**
 * A fake auth middleware (priority 300): it names the principal's tenant from
 * the `x-user-tenant` header, so each request can present a different tenant
 * through the principal rather than a tenant header.
 */
function principalMiddleware(): MiddlewareFunction {
  return async (ctx, next) => {
    const tenant = ctx.request.headers.get('x-user-tenant');
    if (tenant !== null) {
      ctx.request.user = { id: `user-${tenant}`, claims: { tenant } };
    }
    await next();
  };
}

/**
 * A custom `ITenantResolver` that reads the tenant off the authenticated
 * principal. Registered at `middlewarePriority: 310`, so it resolves the
 * tenant AFTER the session middleware (260) has loaded and parked the session.
 */
const userResolver: ITenantResolver = {
  // deno-lint-ignore require-await
  async resolve(request) {
    const claim = request.user?.claims?.tenant;
    return typeof claim === 'string' ? some({ id: claim }) : none();
  },
};

/** Whether the route handler ran on the last request (reset before each). */
let handlerRan = false;

/** Boots a real kernel app whose tenant resolver runs at the given priority. */
async function bootApp(
  resolver: ITenantResolver,
  middlewarePriority: number,
  tenantBinding = true,
): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SECRET, tenantBinding }),
      MultiTenancyPlugin({ resolver, middlewarePriority }),
    ],
  });
  app.middleware.add(principalMiddleware(), { priority: 300, name: 'fake-auth' });
  app.router.get('/data', (ctx) => {
    handlerRan = true;
    return ctx.response.json({ ok: true, tenant: ctx.request.tenant?.id ?? null });
  });
  await app.start();
  return app;
}

describe('tenant binding — the compare runs on whichever side sees the tenant second', () => {
  it('refuses (tenant side) a session bound to `a` when the principal names `b`, at priority 310', async () => {
    const app = await bootApp(userResolver, 310);
    try {
      // 1. Mint a session under tenant `a`. The handler runs and the session
      //    is sealed to `a` on commit.
      handlerRan = false;
      const first = await hit(app, { 'x-user-tenant': 'a' });
      expect(first.statusCode).toBe(200);
      expect(handlerRan).toBe(true);
      const cookie = sessionCookie(first.headers);
      expect(cookie).toBeDefined();

      // 2. Present that session under a principal naming tenant `b`. The
      //    tenant is resolved at 310 — AFTER the session loaded — so this is
      //    the tenant middleware's compare that must fire: 403, handler never
      //    runs under the mismatched session.
      handlerRan = false;
      const refused = await hit(app, { 'x-user-tenant': 'b', cookie: cookie! });
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body ?? '{}')).toEqual(MISMATCH_BODY);
      expect(handlerRan).toBe(false);

      // 3. The refusal did NOT rebind the session: it is still bound to `a`,
      //    so a follow-up under `a` passes …
      handlerRan = false;
      const backToA = await hit(app, { 'x-user-tenant': 'a', cookie: cookie! });
      expect(backToA.statusCode).toBe(200);
      expect(handlerRan).toBe(true);

      // … and a follow-up under `b` is still refused. If the seal had
      //    (buggily) re-sealed the session to `b` on the refusal, this would
      //    answer 200 — the exact defect the narrowed seal condition closes.
      handlerRan = false;
      const stillRefused = await hit(app, { 'x-user-tenant': 'b', cookie: cookie! });
      expect(stillRefused.statusCode).toBe(403);
      expect(handlerRan).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('refuses (session side) the same mismatch at the default priority 40, unchanged', async () => {
    // A header resolver at the default priority 40 resolves the tenant BEFORE
    // the session middleware loads it at 260, so the session middleware's
    // load-time compare fires. This is the shipped path: the refusal is
    // byte-identical and the handler never runs.
    const headerResolver: ITenantResolver = {
      // deno-lint-ignore require-await
      async resolve(request) {
        const header = request.headers.get('x-tenant-id');
        return header !== null ? some({ id: header }) : none();
      },
    };
    const app = await bootApp(headerResolver, 40);
    try {
      // 1. Mint a session under tenant `a` (named by header, resolved at 40).
      handlerRan = false;
      const first = await hit(app, { 'x-tenant-id': 'a' });
      expect(first.statusCode).toBe(200);
      expect(handlerRan).toBe(true);
      const cookie = sessionCookie(first.headers);
      expect(cookie).toBeDefined();

      // 2. Present it under tenant `b`. The tenant is resolved at 40, before
      //    the session loads, so the SESSION middleware's load-time compare
      //    fires: the same 403 body, handler never runs.
      handlerRan = false;
      const refused = await hit(app, { 'x-tenant-id': 'b', cookie: cookie! });
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body ?? '{}')).toEqual(MISMATCH_BODY);
      expect(handlerRan).toBe(false);

      // 3. Not rebound: a follow-up under `a` still passes.
      handlerRan = false;
      const backToA = await hit(app, { 'x-tenant-id': 'a', cookie: cookie! });
      expect(backToA.statusCode).toBe(200);
      expect(handlerRan).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('tenantBinding: false disables the tenant-side compare too, in every middleware order', async () => {
    // A session sealed to `a` while binding was on, then presented to an app
    // that turned binding OFF. The opt-out documents "no seal, no compare";
    // with the tenant resolved after the session loads, the tenant side must
    // honor it exactly as the session side does at the default priority.
    const sealing = await bootApp(userResolver, 310);
    let cookie: string | undefined;
    try {
      cookie = sessionCookie((await hit(sealing, { 'x-user-tenant': 'a' })).headers);
      expect(cookie).toBeDefined();
    } finally {
      await sealing.stop();
    }

    const optedOut = await bootApp(userResolver, 310, false);
    try {
      handlerRan = false;
      const response = await hit(optedOut, { 'x-user-tenant': 'b', cookie: cookie! });
      expect(response.statusCode).toBe(200);
      expect(handlerRan).toBe(true);
    } finally {
      await optedOut.stop();
    }
  });
});
