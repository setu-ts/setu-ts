/**
 * Unit tests for tenant binding — seal on commit, compare on load (X4-3).
 *
 * Drives `sessionMiddleware` with a resolved tenant and verifies the reserved
 * `__setu_tenant` key is sealed on commit, a matching tenant passes, a
 * mismatched tenant short-circuits with `403` before the handler runs, and
 * `tenantBinding: false` restores the previous (inert) behaviour.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISession, ITenant } from '@setu-ts/common';

import { deriveKeyRing } from '../../src/codec/crypto.ts';
import { sessionMiddleware } from '../../src/middleware/session-middleware.ts';
import { resolveSessionConfig } from '../../src/options.ts';
import type { SessionPluginOptions } from '../../src/options.ts';
import {
  readTenantBinding,
  TENANT_BINDING_KEY,
} from '../../src/services/session-tenant-binding.ts';
import { SESSION_STATE_KEY, SessionService } from '../../src/services/session-service.ts';
import { makeClock, makeContext } from '../fixtures/context.ts';

const SECRET = 'm'.repeat(32);

interface BuiltMiddleware {
  middleware: ReturnType<typeof sessionMiddleware>;
  cookie: (headers: Headers) => string | null;
}

async function makeMiddleware(options: SessionPluginOptions = {}): Promise<BuiltMiddleware> {
  const clock = makeClock();
  const service = new SessionService(
    resolveSessionConfig(options),
    await deriveKeyRing(crypto.subtle, [SECRET], options.mode ?? 'encrypt'),
    {
      subtle: crypto.subtle,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      now: clock.now,
      uuid: clock.uuid,
    },
  );
  const middleware = sessionMiddleware(service, options.tenantBinding ?? true);
  return {
    middleware,
    cookie: (headers) => headers.getSetCookie()[0] ?? null,
  };
}

/** Sets the resolved tenant on a context's request (the tenancy middleware's job). */
function withTenant(ctx: ReturnType<typeof makeContext>['ctx'], id: string): void {
  ctx.request.tenant = { id } satisfies ITenant;
}

describe('session tenant binding (X4-3)', () => {
  it('seals the tenant id into the session on commit', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();
    withTenant(ctx, 'acme');

    await middleware(ctx, () => Promise.resolve());

    // The seal marks the session dirty, so a cookie is emitted even on a
    // read-only request.
    const cookie = response.setCookies()[0];
    expect(cookie).toBeDefined();

    // Replay the cookie under the same tenant — the binding must round-trip.
    const replay = makeContext({ headers: { cookie } });
    withTenant(replay.ctx, 'acme');
    let seen: ISession | undefined;
    await middleware(replay.ctx, () => {
      seen = replay.ctx.state.get(SESSION_STATE_KEY) as ISession | undefined;
      return Promise.resolve();
    });
    expect(readTenantBinding(seen!)).toBe('acme');
  });

  it('does not seal when no tenant is resolved', async () => {
    const { middleware } = await makeMiddleware();
    const { ctx, response } = makeContext();
    // No tenant set.

    await middleware(ctx, () => Promise.resolve());

    // A read-only, tenant-less request emits no cookie at all (nothing dirty).
    expect(response.setCookies().length).toBe(0);

    // And a fresh session carries no binding.
    const session = ctx.state.get(SESSION_STATE_KEY) as ISession;
    expect(readTenantBinding(session)).toBeUndefined();
    expect(session.has(TENANT_BINDING_KEY)).toBe(false);
  });

  it('passes when the session tenant matches the request tenant', async () => {
    const { middleware } = await makeMiddleware();

    const first = makeContext();
    withTenant(first.ctx, 'acme');
    await middleware(first.ctx, () => Promise.resolve());
    const cookie = first.response.setCookies()[0];

    const replay = makeContext({ headers: { cookie } });
    withTenant(replay.ctx, 'acme');
    let handlerRan = false;
    await middleware(replay.ctx, () => {
      handlerRan = true;
      return Promise.resolve();
    });

    expect(handlerRan).toBe(true);
    expect(replay.response.statusCode).toBe(200);
  });

  it('short-circuits with 403 and never runs the handler on a mismatch', async () => {
    const { middleware } = await makeMiddleware();

    const first = makeContext();
    withTenant(first.ctx, 'acme');
    await middleware(first.ctx, () => Promise.resolve());
    const cookie = first.response.setCookies()[0];

    // Replay the acme cookie under globex.
    const replay = makeContext({ headers: { cookie } });
    withTenant(replay.ctx, 'globex');
    let handlerRan = false;
    await middleware(replay.ctx, () => {
      handlerRan = true;
      return Promise.resolve();
    });

    expect(handlerRan).toBe(false);
    expect(replay.response.statusCode).toBe(403);
    const body = replay.response.body as Record<string, unknown>;
    expect(body.error).toBe('Tenant Mismatch');
  });

  it('does not compare when the request has no tenant (session bound, request unbound)', async () => {
    const { middleware } = await makeMiddleware();

    const first = makeContext();
    withTenant(first.ctx, 'acme');
    await middleware(first.ctx, () => Promise.resolve());
    const cookie = first.response.setCookies()[0];

    // Replay under NO tenant — nothing is compared, the handler runs.
    const replay = makeContext({ headers: { cookie } });
    let handlerRan = false;
    await middleware(replay.ctx, () => {
      handlerRan = true;
      return Promise.resolve();
    });
    expect(handlerRan).toBe(true);
  });

  it('is inert end to end when tenantBinding is false', async () => {
    const { middleware } = await makeMiddleware({ tenantBinding: false });

    const first = makeContext();
    withTenant(first.ctx, 'acme');
    await middleware(first.ctx, () => Promise.resolve());
    const cookie = first.response.setCookies()[0];

    // No seal happened, so replaying under a different tenant is not a
    // mismatch — the handler runs.
    const replay = makeContext({ headers: { cookie } });
    withTenant(replay.ctx, 'globex');
    let handlerRan = false;
    await middleware(replay.ctx, () => {
      handlerRan = true;
      return Promise.resolve();
    });
    expect(handlerRan).toBe(true);
    expect(replay.response.statusCode).toBe(200);
  });

  it('re-binds after clear() on the next commit', async () => {
    const { middleware } = await makeMiddleware();

    const first = makeContext();
    withTenant(first.ctx, 'acme');
    await middleware(first.ctx, () => Promise.resolve());
    const cookie = first.response.setCookies()[0];

    // Replay and clear the session — the reserved key is dropped.
    const replay = makeContext({ headers: { cookie } });
    withTenant(replay.ctx, 'acme');
    await middleware(replay.ctx, () => {
      (replay.ctx.state.get(SESSION_STATE_KEY) as ISession).clear();
      return Promise.resolve();
    });
    const recookie = replay.response.setCookies()[0];
    expect(recookie).toBeDefined();

    // The cleared session is re-bound to the current tenant on commit, so a
    // following request under acme still matches.
    const after = makeContext({ headers: { recookie } });
    withTenant(after.ctx, 'acme');
    let seen: ISession | undefined;
    await middleware(after.ctx, () => {
      seen = after.ctx.state.get(SESSION_STATE_KEY) as ISession | undefined;
      return Promise.resolve();
    });
    expect(readTenantBinding(seen!)).toBe('acme');
  });

  it('keeps the binding after regenerate() (a new session adopts the current tenant)', async () => {
    const { middleware } = await makeMiddleware();

    const first = makeContext();
    withTenant(first.ctx, 'acme');
    await middleware(first.ctx, () => Promise.resolve());
    const cookie = first.response.setCookies()[0];

    // Replay under the same tenant and regenerate — the regenerated session is
    // a new session and re-binds to the current tenant on commit.
    const replay = makeContext({ headers: { cookie } });
    withTenant(replay.ctx, 'acme');
    await middleware(replay.ctx, () => {
      (replay.ctx.state.get(SESSION_STATE_KEY) as ISession).regenerate();
      return Promise.resolve();
    });
    const recookie = replay.response.setCookies()[0];
    expect(recookie).toBeDefined();

    const after = makeContext({ headers: { recookie } });
    withTenant(after.ctx, 'acme');
    let seen: ISession | undefined;
    await middleware(after.ctx, () => {
      seen = after.ctx.state.get(SESSION_STATE_KEY) as ISession | undefined;
      return Promise.resolve();
    });
    expect(readTenantBinding(seen!)).toBe('acme');
  });
});
