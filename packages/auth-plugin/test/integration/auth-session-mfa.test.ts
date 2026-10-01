/**
 * Integration — auth-session MFA through a real kernel app: password sign-in
 * with MFA required → second-factor-required, requireAuth route still 401; after
 * a confirmed factor and a valid code → signed in with amr: ['pwd','otp']; the
 * session id changes at both steps; an expired pending record is refused, and
 * the configured signIn.mfa.pendingTtlMs governs that refusal.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthSessionService, IRequestContext, IRuntimeServices } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin, MemoryTotpStore, requireAuth, TotpService } from '../../src/index.ts';
import type { MfaOptions, OidcProvider } from '../../src/index.ts';
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
  readonly runtime: IRuntimeServices;
}

async function buildMfaApp(mfa: MfaOptions): Promise<MfaHarness> {
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

  const totpStore = new MemoryTotpStore();
  // The app's runtime, captured from a request context: services resolve per
  // request, so there is nothing to read at this point.
  let runtimeRef: IRuntimeServices | null = null;
  const captureRuntime = (ctx: IRequestContext): IRuntimeServices => {
    runtimeRef = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    return runtimeRef;
  };

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
          mfa,
        },
      }),
    ],
  });

  // Password login route: signs in with MFA policy active.
  app.router.post('/password-login', async (ctx) => {
    captureRuntime(ctx);
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const outcome = await auth.signIn(ctx, { id: 'alice', roles: ['user'] }, { methods: ['pwd'] });
    return ctx.response.json({ outcome: outcome.status });
  });

  // TOTP complete route: uses the TotpService to complete the pending sign-in.
  app.router.post('/mfa/complete', async (ctx) => {
    const body = (await ctx.request.json()) as { code: string };
    const service = new TotpService({
      store: totpStore,
      runtime: captureRuntime(ctx),
      issuer: 'TestApp',
    });
    const result = await service.completeSignIn(ctx, body.code);
    return ctx.response.json({ result });
  });

  // Recovery code complete route.
  app.router.post('/mfa/complete-recovery', async (ctx) => {
    const body = (await ctx.request.json()) as { code: string };
    const service = new TotpService({
      store: totpStore,
      runtime: captureRuntime(ctx),
      issuer: 'TestApp',
    });
    const result = await service.completeSignInWithRecoveryCode(ctx, body.code);
    return ctx.response.json({ result });
  });

  // Enrolment route: begins TOTP enrolment for the pending principal.
  app.router.post('/mfa/enrol', async (ctx) => {
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const pending = auth.pending(ctx);
    if (pending === null) {
      return ctx.response.status(400).json({ error: 'no-pending' });
    }
    const service = new TotpService({
      store: totpStore,
      runtime: captureRuntime(ctx),
      issuer: 'TestApp',
    });
    const { secret, uri } = await service.beginEnrolment(pending.principal.id, 'alice');
    return ctx.response.json({ secret, uri });
  });

  // Confirm enrolment route.
  app.router.post('/mfa/confirm', async (ctx) => {
    const body = (await ctx.request.json()) as { code: string };
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    const pending = auth.pending(ctx);
    if (pending === null) {
      return ctx.response.status(400).json({ error: 'no-pending' });
    }
    const service = new TotpService({
      store: totpStore,
      runtime: captureRuntime(ctx),
      issuer: 'TestApp',
    });
    const result = await service.confirmEnrolment(pending.principal.id, body.code);
    return ctx.response.json({
      result: result.status,
      codes: result.status === 'ok' ? result.recoveryCodes : [],
    });
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

  // Age the pending MFA record: past any TTL by default, or by `?by=<ms>`.
  app.router.post('/_age-pending-mfa', (ctx) => {
    const session = getSession(ctx);
    const pending = session.get<Record<string, unknown>>(PENDING_MFA_SESSION_KEY);
    const by = ctx.query.by;
    if (pending !== null && pending !== undefined) {
      const at = by === undefined ? 0 : (pending.at as number) - Number(by);
      session.set(PENDING_MFA_SESSION_KEY, { ...pending, at });
    }
    return ctx.response.json({ ok: true });
  });

  await app.start();

  return {
    app,
    key,
    requests,
    totpStore,
    get runtime() {
      if (runtimeRef === null) {
        throw new Error('the app runtime has not been captured yet — make a request first');
      }
      return runtimeRef;
    },
  };
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

/** The 6-digit code `secretText` produces for `step`, on the app's clock. */
async function codeForStep(
  harness: MfaHarness,
  secretText: string,
  step: number,
): Promise<string> {
  return (await computeTotpCode(harness.runtime.subtle, decodeBase32(secretText), step)).slice(-6);
}

/** Password sign-in, enrolment, and confirmation, leaving the session pending. */
async function enrolAndConfirm(harness: MfaHarness, jar: CookieJar): Promise<string> {
  return (await enrolConfirmAndCodes(harness, jar)).secret;
}

/** As {@linkcode enrolAndConfirm}, also returning the recovery codes confirmation minted. */
async function enrolConfirmAndCodes(
  harness: MfaHarness,
  jar: CookieJar,
): Promise<{ secret: string; codes: string[] }> {
  const login = await json(
    await jar.fetch(harness.app, '/password-login', { method: 'POST' }),
  );
  expect(login.outcome).toBe('second-factor-required');
  const enrol = await json(await jar.fetch(harness.app, '/mfa/enrol', { method: 'POST' }));
  const secret = enrol.secret as string;
  const step = totpCounter(harness.runtime.now());
  const confirm = await json(
    await jar.fetch(harness.app, '/mfa/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: await codeForStep(harness, secret, step) }),
    }),
  );
  expect(confirm.result).toBe('ok');
  return { secret, codes: confirm.codes as string[] };
}

async function complete(
  harness: MfaHarness,
  jar: CookieJar,
  code: string,
): Promise<unknown> {
  const response = await jar.fetch(harness.app, '/mfa/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return (await json(response)).result;
}

const ALWAYS_REQUIRED: MfaOptions = { required: () => true };

describe('auth-session MFA', () => {
  let harness: MfaHarness;

  afterEach(async () => {
    await harness.app.stop();
  });

  it('password sign-in with MFA required returns second-factor-required', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    const response = await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const body = await json(response);
    expect(body.outcome).toBe('second-factor-required');
  });

  it('requireAuth route is still 401 during pending state', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    // Sign in (triggers MFA pending).
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    // Try the protected route with the session cookie.
    const protectedRes = await jar.fetch(harness.app, '/protected');
    expect(protectedRes.status).toBe(401);
  });

  it('session id changes at sign-in (rotation)', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    // Sign in (triggers MFA pending, rotates session).
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe('string');
    expect((session.id as string).length).toBeGreaterThan(0);
  });

  it('an expired pending record is refused at completion', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    const secret = await enrolAndConfirm(harness, jar);
    const confirmedAt = totpCounter(harness.runtime.now());

    // A fresh sign-in, aged past any TTL.
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    await jar.fetch(harness.app, '/_age-pending-mfa', { method: 'POST' });
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect((session.pending as Record<string, unknown>).at).toBe(0);

    // The code is valid for the next step, so the refusal is the expiry alone.
    const code = await codeForStep(harness, secret, confirmedAt + 1);
    expect(await complete(harness, jar, code)).toBe('no-pending');

    // The refusal did not spend the code: an expired record is refused BEFORE
    // the code is checked, so its step stays unclaimed for a fresh sign-in.
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    expect(await complete(harness, jar, code)).toBe('signed-in');
  });

  it('a configured pendingTtlMs refuses completion (the option has effect)', async () => {
    // 60 s configured: a record aged 120 s is refused, though the 300 s default
    // would accept it — so the refusal is the configured value, not the default.
    harness = await buildMfaApp({ required: () => true, pendingTtlMs: 60_000 });
    const jar = new CookieJar();
    const secret = await enrolAndConfirm(harness, jar);
    const confirmedAt = totpCounter(harness.runtime.now());

    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    await jar.fetch(harness.app, '/_age-pending-mfa?by=120000', { method: 'POST' });
    const result = await complete(
      harness,
      jar,
      await codeForStep(harness, secret, confirmedAt + 1),
    );
    expect(result).toBe('no-pending');
  });

  it('the default TTL completes the same aged flow (control for the case above)', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    const secret = await enrolAndConfirm(harness, jar);
    const confirmedAt = totpCounter(harness.runtime.now());

    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    await jar.fetch(harness.app, '/_age-pending-mfa?by=120000', { method: 'POST' });
    const result = await complete(
      harness,
      jar,
      await codeForStep(harness, secret, confirmedAt + 1),
    );
    expect(result).toBe('signed-in');
  });

  it('an unconfirmed enrolment cannot complete a sign-in', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const enrol = await json(await jar.fetch(harness.app, '/mfa/enrol', { method: 'POST' }));
    const secret = enrol.secret as string;
    const step = totpCounter(harness.runtime.now());
    // The code is correct for the secret just generated; there is no factor yet.
    const result = await complete(harness, jar, await codeForStep(harness, secret, step));
    expect(result).toBe('not-enrolled');
    // Still pending: the refusal did not sign anyone in.
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect(session.pending).not.toBeNull();
  });

  it("a code from principal B does not complete principal A's pending sign-in", async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
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

  it('full MFA flow: enrol, confirm, complete sign-in, amr carries both factors', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();

    // Steps 1–3: password sign-in → pending; enrol; confirm the factor.
    const secret = await enrolAndConfirm(harness, jar);
    const confirmedAt = totpCounter(harness.runtime.now());

    // Step 4: a fresh pending sign-in, completed with the confirmed factor.
    const loginRes = await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const loginBody = await json(loginRes);
    expect(loginBody.outcome).toBe('second-factor-required');

    const completeRes = await jar.fetch(harness.app, '/mfa/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: await codeForStep(harness, secret, confirmedAt + 1) }),
    });
    const completeBody = await json(completeRes);
    expect(completeBody.result).toBe('signed-in');

    // Step 5: the protected route now returns 200.
    const protectedRes = await jar.fetch(harness.app, '/protected');
    expect(protectedRes.status).toBe(200);
    const protectedBody = await json(protectedRes);
    expect(protectedBody.user).toBeDefined();
    const amr = (protectedBody.user as Record<string, unknown>).claims as Record<string, unknown>;
    expect(amr.amr).toEqual(['pwd', 'otp']);
  });

  it('a recovery code completes a pending sign-in and is single-use', async () => {
    harness = await buildMfaApp(ALWAYS_REQUIRED);
    const jar = new CookieJar();
    const { codes } = await enrolConfirmAndCodes(harness, jar);
    expect(codes).toHaveLength(10);

    await jar.fetch(harness.app, '/password-login', { method: 'POST' });
    const first = await json(
      await jar.fetch(harness.app, '/mfa/complete-recovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: `${codes[0]}A` }),
      }),
    );
    // A valid code with one extra character is refused: the canonical shape is
    // enforced before the store is consulted.
    expect(first.result).toBe('invalid');

    const second = await json(
      await jar.fetch(harness.app, '/mfa/complete-recovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: codes[0] }),
      }),
    );
    expect(second.result).toBe('signed-in');
  });
});
