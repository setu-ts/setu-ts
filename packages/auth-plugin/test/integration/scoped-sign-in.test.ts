/**
 * `scopedRbac.timing: 'sign-in'` through a REAL kernel application with
 * `SessionPlugin` (M110b plan §3.12), and Scenario B: grants unioned from
 * three keyed lists, resolved once at sign-in.
 *
 * The second-factor case drives `promotePending` — the one synchronous funnel
 * TOTP `completeSignIn`, recovery codes and passkey step-up all call
 * (`totp-service.ts`, `ceremonies.ts`) — through the package's own internal
 * promotion seam, as each of those verifiers does.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, scopeFromParam } from '@setu-ts/common';
import type { IAuthSessionService, ScopedGrant } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { AuthPlugin, GrantResolutionError, requireScopedPermission } from '../../src/index.ts';
import type { GrantSourceConfig } from '../../src/index.ts';
import {
  asPendingPromotion,
  SCOPED_GRANTS_SESSION_KEY,
} from '../../src/sign-in/auth-session-service.ts';
import { CookieJar } from '../fixtures/sign-in-app.ts';
import { CATALOGUE } from '../fixtures/scoped.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const REGION_EU = { type: 'region', id: 'eu' };
const CHANNEL_WEB = { type: 'channel', id: 'web' };

interface Harness {
  readonly app: IKernelApplication;
  /** The mutable channel list, to revoke a grant after sign-in. */
  readonly channelGrants: ScopedGrant[];
  readonly calls: string[];
}

async function start(options: { failing?: boolean } = {}): Promise<Harness> {
  const channelGrants: ScopedGrant[] = [{ role: 'viewer', scope: CHANNEL_WEB }];
  const calls: string[] = [];
  const sources: GrantSourceConfig[] = [
    // role × region
    { kind: 'static', grants: [{ subject: 'alice', role: 'approver', scope: REGION_EU }] },
    // role × channel, from a remote source asked once at sign-in
    {
      kind: 'custom',
      source: {
        name: 'channels',
        grantsFor: (principal, query) => {
          calls.push(`${principal.id}:${query.kind}`);
          if (options.failing === true) {
            return Promise.reject(new Error('directory down'));
          }
          return Promise.resolve(
            principal.id === 'alice' || principal.id === 'mfa-alice' ? [...channelGrants] : [],
          );
        },
      },
    },
    // per user, global
    { kind: 'static', grants: [{ subject: 'bob', role: 'viewer', scope: null }] },
  ];
  const built = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: 'scoped-sign-in-session-secret-32-chars!!' }),
      AuthPlugin({
        rbac: CATALOGUE,
        signIn: { providers: [], mfa: { required: (principal) => principal.id === 'mfa-alice' } },
        scopedRbac: { sources, timing: 'sign-in' },
      }),
    ],
  });
  built.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 50 });
  built.router.post('/login/:user', async (ctx) => {
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const claims = ctx.request.headers.get('x-claims');
    const outcome = await auth.signIn(
      ctx,
      { id: ctx.params.user, ...(claims === null ? {} : { claims: JSON.parse(claims) }) },
      { methods: ['pwd'] },
    );
    return ctx.response.json({ outcome: outcome.status });
  });
  built.router.post('/second-factor', (ctx) => {
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    return ctx.response.json({ promoted: asPendingPromotion(auth)?.promotePending(ctx, 'otp') });
  });
  built.router.post('/logout', (ctx) => {
    ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION).signOut(ctx);
    return ctx.response.json({});
  });
  const scoped = (permission: string, param: string, type: string) =>
    requireScopedPermission(permission, { scope: scopeFromParam(param, type) });
  built.router.get('/regions/:region/approve', {
    middleware: [scoped('invoices:approve', 'region', 'region')],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
  built.router.get('/channels/:channel/invoices', {
    middleware: [scoped('invoices:read', 'channel', 'channel')],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
  built.router.get('/session-raw', (ctx) => {
    const session = ctx.services.get<{ from(c: unknown): { get(k: string): unknown } }>(
      CAPABILITIES.SESSION,
    );
    return ctx.response.json({ stored: session.from(ctx).get(SCOPED_GRANTS_SESSION_KEY) ?? null });
  });
  await built.start();
  app = built;
  return { app: built, channelGrants, calls };
}

async function code(
  jar: CookieJar,
  target: IKernelApplication,
  path: string,
  method = 'GET',
): Promise<number> {
  const response = await jar.fetch(target, path, { method });
  await response.body?.cancel();
  return response.status;
}

describe('Scenario B — three keyed lists unioned, resolved once at sign-in', () => {
  it('each list grants in its own scope, and the remote source is asked once with an all question', async () => {
    const { app: target, calls } = await start();
    const jar = new CookieJar();
    expect(await code(jar, target, '/login/alice', 'POST')).toBe(200);
    expect(await code(jar, target, '/regions/eu/approve')).toBe(200);
    expect(await code(jar, target, '/channels/web/invoices')).toBe(200);
    expect(calls).toEqual(['alice:all']);
    const bob = new CookieJar();
    expect(await code(bob, target, '/login/bob', 'POST')).toBe(200);
    expect(await code(bob, target, '/channels/anything/invoices')).toBe(200);
  });

  it('NEGATIVE: a region grant does not apply in another region', async () => {
    const { app: target } = await start();
    const jar = new CookieJar();
    await code(jar, target, '/login/alice', 'POST');
    expect(await code(jar, target, '/regions/us/approve')).toBe(403);
  });
});

describe("'sign-in' timing", () => {
  it('stores the grants under the private session key, for the signed-in principal', async () => {
    const { app: target } = await start();
    const jar = new CookieJar();
    await code(jar, target, '/login/alice', 'POST');
    const response = await jar.fetch(target, '/session-raw');
    const { stored } = await response.json() as {
      stored: { principalId: string; grants: unknown[] };
    };
    expect(stored.principalId).toBe('alice');
    expect(stored.grants.length).toBe(2);
  });

  it('keeps a revoked grant in force until sign-out — the documented latency — then drops it', async () => {
    const harness = await start();
    const jar = new CookieJar();
    await code(jar, harness.app, '/login/alice', 'POST');
    harness.channelGrants.length = 0; // revoked at the source
    expect(await code(jar, harness.app, '/channels/web/invoices')).toBe(200);
    await code(jar, harness.app, '/logout', 'POST');
    await code(jar, harness.app, '/login/alice', 'POST');
    expect(await code(jar, harness.app, '/channels/web/invoices')).toBe(403);
  });

  it('a claim named like the private key grants nothing', async () => {
    const { app: target } = await start();
    const jar = new CookieJar();
    const forged = {
      [SCOPED_GRANTS_SESSION_KEY]: {
        principalId: 'mallory',
        grants: [{ role: 'owner', scope: REGION_EU }],
      },
    };
    await jar.fetch(target, '/login/mallory', {
      method: 'POST',
      headers: { 'x-claims': JSON.stringify(forged) },
    });
    expect(await code(jar, target, '/regions/eu/approve')).toBe(403);
  });

  it('a source failure rejects sign-in with a 503 and records nothing', async () => {
    const { app: target } = await start({ failing: true });
    const jar = new CookieJar();
    const response = await jar.fetch(target, '/login/alice', { method: 'POST' });
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body.detail).toBe('Authorization grants could not be resolved');
    expect(JSON.stringify(body)).not.toContain('directory down');
    expect(await code(jar, target, '/channels/web/invoices')).toBe(401);
  });

  it('the grants resolved at the first factor arrive with the second', async () => {
    const harness = await start();
    const jar = new CookieJar();
    const first = await jar.fetch(harness.app, '/login/mfa-alice', { method: 'POST' });
    expect(await first.json()).toEqual({ outcome: 'second-factor-required' });
    // Pending: not signed in yet.
    expect(await code(jar, harness.app, '/channels/web/invoices')).toBe(401);
    const promoted = await jar.fetch(harness.app, '/second-factor', { method: 'POST' });
    expect(await promoted.json()).toEqual({ promoted: 'signed-in' });
    const stored = await (await jar.fetch(harness.app, '/session-raw')).json() as {
      stored: { principalId: string; grants: unknown[] };
    };
    expect(stored.stored.principalId).toBe('mfa-alice');
    expect(stored.stored.grants).toEqual([{ role: 'viewer', scope: CHANNEL_WEB }]);
    // The grant resolved at the FIRST factor now authorizes — and the source
    // was asked once, at that first factor, never at promotion.
    expect(await code(jar, harness.app, '/channels/web/invoices')).toBe(200);
    expect(harness.calls).toEqual(['mfa-alice:all']);
  });

  it('the error class is exported for instanceof', () => {
    expect(new GrantResolutionError('source-failed', 'x')).toBeInstanceOf(Error);
  });
});
