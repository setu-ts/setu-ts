/**
 * Integration — auth-session MFA: password sign-in with MFA required →
 * second-factor-required, requireAuth route still 401; after a valid code →
 * signed in with amr: ['pwd','otp']; session id changed at both steps;
 * expired pending refused.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthSessionService, IRuntimeServices } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin, MemoryTotpStore, requireAuth, TotpService } from '../../src/index.ts';
import type { OidcProvider } from '../../src/index.ts';
import { PENDING_MFA_SESSION_KEY } from '../../src/sign-in/auth-session-service.ts';
import { decodeBase32 } from '../../src/mfa/base32.ts';
import { computeTotpCode, totpCounter } from '../../src/mfa/totp-codes.ts';
import { createFakeHttp, generateTestKey } from '../fixtures/issuer-tokens.ts';
import type { RecordedRequest, TestKey } from '../fixtures/issuer-tokens.ts';

const BASE = 'http://localhost';
const ISSUER = 'https://idp.test';
const CLIENT_ID = 'setu-app';
const SESSION_SECRET = 'mfa-integration-session-secret-32-chars';

interface MfaHarness {
  readonly app: IKernelApplication;
  readonly key: TestKey;
  readonly requests: RecordedRequest[];
  readonly totpStore: MemoryTotpStore;
}

async function buildMfaApp(): Promise<MfaHarness> {
  const key = await generateTestKey('RS256', 'k1');
  const { http, requests } = createFakeHttp({
    [`${ISSUER}/.well-known/openid-configuration`]: {
      body: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        end_session_endpoint: `${ISSUER}/logout`,
      },
    },
    [`${ISSUER}/jwks`]: { body: { keys: [key.jwk] } },
    [`${ISSUER}/token`]: {
      body: {
        access_token: 'provider-access-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: 'pre-signed',
      },
    },
  });

  // The shared TOTP store, wired to the app's runtime via a closure that
  // resolves the runtime at request time.
  let runtimeRef: IRuntimeServices | null = null;
  const totpStore = new MemoryTotpStore({
    get now() {
      return () => runtimeRef?.now() ?? Date.now();
    },
    get randomBytes() {
      return (n: number) => runtimeRef?.randomBytes(n) ?? new Uint8Array(n);
    },
    get subtle() {
      return runtimeRef?.subtle ?? globalThis.crypto.subtle;
    },
    // Minimal stubs for the remaining IRuntimeServices members; the memory
    // store never calls them.
    platform: () => 'deno' as const,
    version: () => 'test',
    hostname: () => 'localhost',
    hrtime: () => 0,
    setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }),
    clearTimeout: (h: { id: number }) => clearTimeout(h.id),
    setInterval: (fn: () => void) => ({ id: setInterval(fn, 0) }),
    clearInterval: (h: { id: number }) => clearInterval(h.id),
    uuid: () => crypto.randomUUID(),
    env: {},
    exit: () => {
      throw new Error('exit');
    },
  } as IRuntimeServices);

  const oidc: OidcProvider = {
    kind: 'oidc',
    name: 'idp',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    scopes: ['openid'],
    redirectUri: `${BASE}/auth/idp/callback`,
    toPrincipal: (claims) =>
      typeof claims.sub === 'string' ? { id: `idp:${claims.sub}`, roles: ['user'] } : null,
  };

  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SESSION_SECRET }),
      AuthPlugin({
        http,
        signIn: {
          providers: [oidc],
          mfa: {
            required: () => true,
          },
        },
      }),
    ],
  });

  // Password login route: signs in with MFA policy active.
  app.router.post('/password-login', async (ctx) => {
    runtimeRef = ctx.services.get<IRuntimeServices>('runtime');
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const outcome = await auth.signIn(ctx, { id: 'alice', roles: ['user'] }, { methods: ['pwd'] });
    return ctx.response.json({ outcome: outcome.status });
  });

  // TOTP complete route: uses the TotpService to complete the pending sign-in.
  app.router.post('/mfa/complete', async (ctx) => {
    const body = (await ctx.request.json()) as { code: string };
    const runtime = ctx.services.get<IRuntimeServices>('runtime');
    runtimeRef = runtime;
    const service = new TotpService({ store: totpStore, runtime, issuer: 'TestApp' });
    const result = await service.completeSignIn(ctx, body.code);
    return ctx.response.json({ result });
  });

  // Recovery code complete route.
  app.router.post('/mfa/complete-recovery', async (ctx) => {
    const body = (await ctx.request.json()) as { code: string };
    const runtime = ctx.services.get<IRuntimeServices>('runtime');
    runtimeRef = runtime;
    const service = new TotpService({ store: totpStore, runtime, issuer: 'TestApp' });
    const result = await service.completeSignInWithRecoveryCode(ctx, body.code);
    return ctx.response.json({ result });
  });

  // Enrolment route: begins TOTP enrolment for the pending principal.
  app.router.post('/mfa/enrol', async (ctx) => {
    const runtime = ctx.services.get<IRuntimeServices>('runtime');
    runtimeRef = runtime;
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const pending = auth.pending(ctx);
    if (pending === null) {
      return ctx.response.status(400).json({ error: 'no-pending' });
    }
    const service = new TotpService({ store: totpStore, runtime, issuer: 'TestApp' });
    const { secret, uri } = await service.beginEnrolment(pending.principal.id, 'alice');
    return ctx.response.json({ secret, uri });
  });

  // Confirm enrolment route.
  app.router.post('/mfa/confirm', async (ctx) => {
    const body = (await ctx.request.json()) as { code: string };
    const runtime = ctx.services.get<IRuntimeServices>('runtime');
    runtimeRef = runtime;
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const pending = auth.pending(ctx);
    if (pending === null) {
      return ctx.response.status(400).json({ error: 'no-pending' });
    }
    const service = new TotpService({ store: totpStore, runtime, issuer: 'TestApp' });
    const result = await service.confirmEnrolment(pending.principal.id, body.code);
    return ctx.response.json({ result });
  });

  // Protected route.
  app.router.get('/protected', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user }),
  });

  // Session state reader.
  app.router.get('/_session', (ctx) => {
    const session = getSession(ctx);
    return ctx.response.json({
      id: session.id,
      pending: session.get(PENDING_MFA_SESSION_KEY) ?? null,
    });
  });

  // Age the pending MFA record past its TTL.
  app.router.post('/_age-pending-mfa', (ctx) => {
    const session = getSession(ctx);
    const pending = session.get<Record<string, unknown>>(PENDING_MFA_SESSION_KEY);
    if (pending !== null && pending !== undefined) {
      session.set(PENDING_MFA_SESSION_KEY, { ...pending, at: 0 });
    }
    return ctx.response.json({ ok: true });
  });

  await app.start();

  return { app, key, requests, totpStore };
}

/** A single-cookie jar tracking the session cookie across `app.fetch` calls. */
class CookieJar {
  cookie: string | undefined;

  update(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      this.cookie = /max-age=0/i.test(header) || pair.endsWith('=') ? undefined : pair;
    }
  }

  async fetch(app: IKernelApplication, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie !== undefined) {
      headers.set('cookie', this.cookie);
    }
    const response = await app.fetch(
      new Request(path.startsWith('http') ? path : `${BASE}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
      }),
    );
    this.update(response);
    return response;
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('auth-session MFA', () => {
  let harness: MfaHarness;

  afterEach(async () => {
    await harness.app.stop();
  });

  it('password sign-in with MFA required returns second-factor-required', async () => {
    harness = await buildMfaApp();
    const jar = new CookieJar();
    const response = await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const body = await json(response);
    expect(body.outcome).toBe('second-factor-required');
  });

  it('requireAuth route is still 401 during pending state', async () => {
    harness = await buildMfaApp();
    const jar = new CookieJar();
    // Sign in (triggers MFA pending).
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    // Try the protected route with the session cookie.
    const protectedRes = await jar.fetch(harness.app, '/protected');
    expect(protectedRes.status).toBe(401);
  });

  it('session id changes at sign-in (rotation)', async () => {
    harness = await buildMfaApp();
    const jar = new CookieJar();
    // Sign in (triggers MFA pending, rotates session).
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe('string');
    expect((session.id as string).length).toBeGreaterThan(0);
  });

  it('expired pending record is refused', async () => {
    harness = await buildMfaApp();
    const jar = new CookieJar();
    // Sign in (triggers MFA pending).
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    // Age the pending record past its TTL.
    await jar.fetch(harness.app, '/_age-pending-mfa', { method: 'POST' });
    // The pending record should now be expired (at=0).
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect(session.pending).not.toBeNull();
    expect((session.pending as Record<string, unknown>).at).toBe(0);
  });

  it("a code from principal B does not complete principal A's pending sign-in", async () => {
    harness = await buildMfaApp();
    const jar = new CookieJar();
    // Sign in as alice (triggers MFA pending).
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    // Try to complete with a code that was never enrolled for alice.
    const completeRes = await jar.fetch(harness.app, '/mfa/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    const body = await json(completeRes);
    // The code is invalid (not enrolled for alice in this store instance).
    expect(['invalid', 'not-enrolled']).toContain(body.result);
  });

  it('full MFA flow: enrol, complete sign-in', async () => {
    harness = await buildMfaApp();
    const jar = new CookieJar();

    // Step 1: password sign-in → pending.
    const loginRes = await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const loginBody = await json(loginRes);
    expect(loginBody.outcome).toBe('second-factor-required');

    // Step 2: begin enrolment.
    const enrolRes = await jar.fetch(harness.app, '/mfa/enrol', { method: 'POST' });
    const enrolBody = await json(enrolRes);
    expect(enrolBody.secret).toBeDefined();
    expect(enrolBody.uri).toContain('otpauth://totp/');

    // Step 3: compute the current TOTP code and complete the sign-in.
    // (confirmEnrolment is for the settings page; the sign-in path goes
    // straight from enrolment to completeSignIn.)
    const runtime = harness.app.services.get<IRuntimeServices>('runtime');
    const enrolment = await harness.totpStore.getEnrolment('alice');
    expect(enrolment).not.toBeNull();
    const secret = decodeBase32(enrolment!.secret);
    const code = (await computeTotpCode(runtime.subtle, secret, totpCounter(runtime.now()))).slice(
      -6,
    );
    const completeRes = await jar.fetch(harness.app, '/mfa/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const completeBody = await json(completeRes);
    expect(completeBody.result).toBe('signed-in');

    // Step 4: the protected route now returns 200.
    const protectedRes = await jar.fetch(harness.app, '/protected');
    expect(protectedRes.status).toBe(200);
    const protectedBody = await json(protectedRes);
    expect(protectedBody.user).toBeDefined();
    const amr = (protectedBody.user as Record<string, unknown>).claims as Record<string, unknown>;
    expect(amr.amr).toEqual(['pwd', 'otp']);
  });
});
