/**
 * Unit tests for CSRF token minting, verification, and the middleware.
 *
 * Covers the one-implementation property directly: the standalone
 * `verifyCsrfToken` and the middleware must accept and reject exactly the same
 * requests, since a React Router action validating inline would otherwise drift
 * from what middleware enforces.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IRequestContext, IRuntimeServices } from '@hono-enterprise/common';

import { deriveKeyRing } from '../../../src/codec/crypto.ts';
import { CSRF_SESSION_KEY, getCsrfToken, readCsrfToken } from '../../../src/csrf/token.ts';
import { verifyCsrfToken } from '../../../src/csrf/verify.ts';
import { csrfFormMiddleware } from '../../../src/middleware/csrf-form-middleware.ts';
import { CsrfTokenMismatchError, SessionMiddlewareMissingError } from '../../../src/errors.ts';
import { resolveSessionConfig } from '../../../src/options.ts';
import { SESSION_STATE_KEY, SessionService } from '../../../src/services/session-service.ts';
import type { MakeContextOptions } from '../../fixtures/context.ts';
import { fakeRandomBytes, makeClock, makeContext } from '../../fixtures/context.ts';

const SECRET = 'c'.repeat(32);
const FORM = 'application/x-www-form-urlencoded';

/** Builds a context with the session middleware's effect already applied. */
async function withSession(options: MakeContextOptions = {}) {
  const clock = makeClock();
  const service = new SessionService(
    resolveSessionConfig(),
    await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt'),
    {
      subtle: crypto.subtle,
      randomBytes: fakeRandomBytes,
      now: clock.now,
      uuid: clock.uuid,
    },
  );

  const harness = makeContext(options);
  harness.registry.register(CAPABILITIES.SESSION, service);
  // Only `randomBytes` is exercised; the rest of IRuntimeServices is not reached
  // on this path, so a partial double is honest here.
  harness.registry.register(CAPABILITIES.RUNTIME, {
    randomBytes: fakeRandomBytes,
  } as unknown as IRuntimeServices);

  const session = await service.load(harness.ctx);
  harness.ctx.state.set(SESSION_STATE_KEY, session);

  return { ...harness, session, service };
}

describe('getCsrfToken', () => {
  it('mints a token, stores it in the session, and dirties it', async () => {
    const { ctx, session } = await withSession();
    expect(session.isDirty).toBe(false);

    const token = getCsrfToken(ctx);

    expect(token.length).toBeGreaterThan(20);
    expect(session.get<string>(CSRF_SESSION_KEY)).toBe(token);
    // Dirty, so the token is committed with the response carrying the form.
    expect(session.isDirty).toBe(true);
  });

  it('is stable across calls within one session', async () => {
    const { ctx } = await withSession();
    expect(getCsrfToken(ctx)).toBe(getCsrfToken(ctx));
  });

  it('emits base64url only, so it is safe in a form value and a cookie', async () => {
    const { ctx } = await withSession();
    expect(getCsrfToken(ctx)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('throws when the session middleware did not run', async () => {
    const { ctx } = await withSession();
    ctx.state.delete(SESSION_STATE_KEY);
    expect(() => getCsrfToken(ctx)).toThrow(SessionMiddlewareMissingError);
  });
});

describe('readCsrfToken', () => {
  it('returns undefined before a token is minted', async () => {
    const { session } = await withSession();
    expect(readCsrfToken(session)).toBe(undefined);
  });

  it('returns the minted token without minting one itself', async () => {
    const { ctx, session } = await withSession();
    const token = getCsrfToken(ctx);
    expect(readCsrfToken(session)).toBe(token);
  });

  it('ignores a non-string or empty stored value', async () => {
    const { session } = await withSession();
    session.set(CSRF_SESSION_KEY, '');
    expect(readCsrfToken(session)).toBe(undefined);

    session.set(CSRF_SESSION_KEY, 42);
    expect(readCsrfToken(session)).toBe(undefined);
  });
});

describe('verifyCsrfToken', () => {
  /** A POST context carrying a form body, with a token already in session. */
  async function postWith(body: string, headers: Record<string, string> = {}) {
    const harness = await withSession({
      method: 'POST',
      body,
      headers: { 'content-type': FORM, ...headers },
    });
    const token = getCsrfToken(harness.ctx);
    return { ...harness, token };
  }

  it('accepts a matching form token', async () => {
    const { ctx, token } = await postWith('_csrf=PLACEHOLDER');
    const fresh = await withSession({
      method: 'POST',
      body: `_csrf=${encodeURIComponent(token)}`,
      headers: { 'content-type': FORM },
    });
    fresh.session.set(CSRF_SESSION_KEY, token);

    await verifyCsrfToken(fresh.ctx);
    expect(ctx).toBeDefined();
  });

  it('rejects when the session holds no token', async () => {
    const { ctx } = await withSession({
      method: 'POST',
      body: '_csrf=anything',
      headers: { 'content-type': FORM },
    });

    await expect(verifyCsrfToken(ctx)).rejects.toThrow(CsrfTokenMismatchError);
    await expect(verifyCsrfToken(ctx)).rejects.toThrow('no CSRF token');
  });

  it('rejects when the request carries no token', async () => {
    const { ctx } = await postWith('name=value');
    await expect(verifyCsrfToken(ctx)).rejects.toThrow('request carried no CSRF token');
  });

  it('rejects an empty submitted token', async () => {
    const { ctx } = await postWith('_csrf=');
    await expect(verifyCsrfToken(ctx)).rejects.toThrow('request carried no CSRF token');
  });

  it('rejects a wrong token', async () => {
    const { ctx } = await postWith('_csrf=definitely-not-the-token');
    await expect(verifyCsrfToken(ctx)).rejects.toThrow('did not match');
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const harness = await withSession({ method: 'POST', headers: { 'content-type': FORM } });
    const token = getCsrfToken(harness.ctx);

    const attempt = await withSession({
      method: 'POST',
      body: `_csrf=${encodeURIComponent(token.slice(0, -1))}`,
      headers: { 'content-type': FORM },
    });
    attempt.session.set(CSRF_SESSION_KEY, token);

    await expect(verifyCsrfToken(attempt.ctx)).rejects.toThrow('did not match');
  });

  it('ignores a non-form body unless a header is configured', async () => {
    const harness = await withSession({
      method: 'POST',
      body: JSON.stringify({ _csrf: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    getCsrfToken(harness.ctx);

    await expect(verifyCsrfToken(harness.ctx)).rejects.toThrow('request carried no CSRF token');
  });

  it('reads a custom field name', async () => {
    const harness = await withSession({ method: 'POST', headers: { 'content-type': FORM } });
    const token = getCsrfToken(harness.ctx);

    const attempt = await withSession({
      method: 'POST',
      body: `authenticity_token=${encodeURIComponent(token)}`,
      headers: { 'content-type': FORM },
    });
    attempt.session.set(CSRF_SESSION_KEY, token);

    await verifyCsrfToken(attempt.ctx, { fieldName: 'authenticity_token' });
  });

  it('reads the token from a configured header, including for multipart bodies', async () => {
    const harness = await withSession({ method: 'POST' });
    const token = getCsrfToken(harness.ctx);

    const attempt = await withSession({
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'x-csrf-token': token },
    });
    attempt.session.set(CSRF_SESSION_KEY, token);

    await verifyCsrfToken(attempt.ctx, { headerName: 'x-csrf-token' });
  });

  it('falls back to the form field when the configured header is absent', async () => {
    const harness = await withSession({ method: 'POST', headers: { 'content-type': FORM } });
    const token = getCsrfToken(harness.ctx);

    const attempt = await withSession({
      method: 'POST',
      body: `_csrf=${encodeURIComponent(token)}`,
      headers: { 'content-type': FORM },
    });
    attempt.session.set(CSRF_SESSION_KEY, token);

    await verifyCsrfToken(attempt.ctx, { headerName: 'x-csrf-token' });
  });

  it('does not consume the body, so the handler can still read it', async () => {
    const harness = await withSession({ method: 'POST', headers: { 'content-type': FORM } });
    const token = getCsrfToken(harness.ctx);

    const attempt = await withSession({
      method: 'POST',
      body: `_csrf=${encodeURIComponent(token)}&name=alice`,
      headers: { 'content-type': FORM },
    });
    attempt.session.set(CSRF_SESSION_KEY, token);

    await verifyCsrfToken(attempt.ctx);
    // Replayable body: this is what lets verification run before the handler.
    expect(await attempt.ctx.request.text()).toContain('name=alice');
  });
});

describe('csrfFormMiddleware', () => {
  /** Runs the middleware and reports whether the handler was reached. */
  async function run(
    ctx: IRequestContext,
    options: Parameters<typeof csrfFormMiddleware>[0] = {},
  ) {
    let handlerRan = false;
    const result = await csrfFormMiddleware(options)(ctx, () => {
      handlerRan = true;
      return Promise.resolve();
    });
    return { handlerRan, result };
  }

  it('lets safe methods through without touching the session', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const { ctx } = makeContext({ method });
      const { handlerRan } = await run(ctx);
      expect(handlerRan).toBe(true);
    }
  });

  it('treats the method case-insensitively', async () => {
    const { ctx } = makeContext({ method: 'get' });
    expect((await run(ctx)).handlerRan).toBe(true);
  });

  it('honours a custom ignore list', async () => {
    const harness = await withSession({ method: 'POST' });
    const { handlerRan } = await run(harness.ctx, { ignoreMethods: ['POST'] });
    expect(handlerRan).toBe(true);
  });

  it('short-circuits with 403 and never reaches the handler on a wrong token', async () => {
    const harness = await withSession({
      method: 'POST',
      body: '_csrf=wrong',
      headers: { 'content-type': FORM },
    });
    getCsrfToken(harness.ctx);

    const { handlerRan } = await run(harness.ctx);

    expect(handlerRan).toBe(false);
    expect(harness.response.statusCode).toBe(403);
  });

  it('short-circuits when no token was submitted', async () => {
    const harness = await withSession({
      method: 'POST',
      body: 'name=x',
      headers: { 'content-type': FORM },
    });
    getCsrfToken(harness.ctx);

    expect((await run(harness.ctx)).handlerRan).toBe(false);
    expect(harness.response.statusCode).toBe(403);
  });

  it('does not disclose the reason for failure', async () => {
    const harness = await withSession({
      method: 'POST',
      body: '_csrf=wrong',
      headers: { 'content-type': FORM },
    });
    getCsrfToken(harness.ctx);
    await run(harness.ctx);

    expect(harness.response.body).toEqual({
      error: 'Forbidden',
      message: 'CSRF token validation failed',
    });
  });

  it('calls the handler when the token matches', async () => {
    const harness = await withSession({ method: 'POST', headers: { 'content-type': FORM } });
    const token = getCsrfToken(harness.ctx);

    const attempt = await withSession({
      method: 'POST',
      body: `_csrf=${encodeURIComponent(token)}`,
      headers: { 'content-type': FORM },
    });
    attempt.session.set(CSRF_SESSION_KEY, token);

    const { handlerRan } = await run(attempt.ctx);
    expect(handlerRan).toBe(true);
  });

  it('propagates a non-CSRF error rather than converting it to 403', async () => {
    // No session middleware ran, so the accessor throws — a wiring bug, which
    // must surface rather than masquerade as a rejected token.
    const { ctx } = makeContext({ method: 'POST', headers: { 'content-type': FORM } });
    await expect(run(ctx)).rejects.toThrow();
  });

  it('accepts and rejects exactly what the standalone verifier does', async () => {
    const harness = await withSession({ method: 'POST', headers: { 'content-type': FORM } });
    const token = getCsrfToken(harness.ctx);

    for (
      const [body, shouldPass] of [
        [`_csrf=${encodeURIComponent(token)}`, true],
        ['_csrf=wrong', false],
        ['', false],
      ] as const
    ) {
      const viaMiddleware = await withSession({
        method: 'POST',
        body,
        headers: { 'content-type': FORM },
      });
      viaMiddleware.session.set(CSRF_SESSION_KEY, token);
      const { handlerRan } = await run(viaMiddleware.ctx);

      const viaFunction = await withSession({
        method: 'POST',
        body,
        headers: { 'content-type': FORM },
      });
      viaFunction.session.set(CSRF_SESSION_KEY, token);
      const functionPassed = await verifyCsrfToken(viaFunction.ctx)
        .then(() => true, () => false);

      expect(handlerRan).toBe(shouldPass);
      expect(functionPassed).toBe(shouldPass);
    }
  });
});
