/**
 * Integration — the sign-in login route (plan §3.4, §3.5, §3.7) on a real kernel
 * application with the real `SessionPlugin`.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { encodeBase64Url } from '../../src/utils/base64url.ts';
import { MAX_PENDING_ENTRIES } from '../../src/sign-in/pending-state.ts';
import { MAX_RETURN_TO_BYTES } from '../../src/sign-in/return-to.ts';
import {
  buildSignInApp,
  CLIENT_ID,
  CookieJar,
  discoveryDocument,
  followLogin,
  GH,
  ISSUER,
  json,
  pendingEntry,
} from '../fixtures/sign-in-app.ts';
import type { SignInHarness } from '../fixtures/sign-in-app.ts';

describe('sign-in login route', () => {
  let harness: SignInHarness;

  afterEach(async () => {
    await harness.app.stop();
  });

  it('redirects to the discovered authorization endpoint with state, nonce and S256 PKCE', async () => {
    harness = await buildSignInApp();
    const jar = new CookieJar();
    const response = await jar.fetch(harness.app, '/auth/idp/login?returnTo=/dashboard');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    const params = location.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe('http://localhost/auth/idp/callback');
    expect(params.get('scope')).toBe('openid profile');
    expect(params.get('code_challenge_method')).toBe('S256');
    // 32 random bytes, base64url without padding.
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Never form_post: the session cookie must accompany a top-level GET.
    expect(params.has('response_mode')).toBe(false);
    expect(jar.cookie).toBeDefined();

    // The pending entry lives in the user's own session, keyed by state.
    const entry = await pendingEntry(harness, jar, params.get('state'));
    if (entry === undefined) throw new Error('no pending entry');
    expect(entry.provider).toBe('idp');
    expect(entry.returnTo).toBe('/dashboard');
    expect(entry.nonce).toBe(params.get('nonce'));
    // The challenge is the S256 hash of the stored verifier.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(entry.verifier)),
    );
    expect(encodeBase64Url(new Uint8Array(digest))).toBe(params.get('code_challenge'));
  });

  it('sends no nonce for an oauth2 provider and still sends PKCE', async () => {
    harness = await buildSignInApp();
    const jar = new CookieJar();
    const params = await followLogin(harness, jar, 'gh');
    expect(params.has('nonce')).toBe(false);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('');
    const response = await jar.fetch(harness.app, '/auth/gh/login');
    expect(response.headers.get('location')?.startsWith(GH.authorize)).toBe(true);
  });

  it('stores / for an unsafe returnTo rather than the value it was given', async () => {
    harness = await buildSignInApp();
    const jar = new CookieJar();
    const params = await followLogin(harness, jar, 'idp', '?returnTo=//evil.test/x');
    expect((await pendingEntry(harness, jar, params.get('state')))?.returnTo).toBe('/');
  });

  it('answers 503 provider-unavailable when discovery cannot be read, writing no entry', async () => {
    harness = await buildSignInApp();
    harness.state.discovery = null;
    const jar = new CookieJar();
    const response = await jar.fetch(harness.app, '/auth/idp/login');
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({
      error: 'Service Unavailable',
      detail: 'provider-unavailable',
    });
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect(session.pending).toEqual([]);
  });

  it('answers 503 when discovery omits the token endpoint', async () => {
    harness = await buildSignInApp();
    harness.state.discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` };
    const response = await new CookieJar().fetch(harness.app, '/auth/idp/login');
    expect(response.status).toBe(503);
    await response.body?.cancel();
  });

  it('refuses a discovered endpoint that is not https (M100c F5)', async () => {
    const cases: Record<string, unknown>[] = [
      { token_endpoint: 'http://attacker.example/token' },
      { authorization_endpoint: 'javascript:alert(1)' },
      // Round-2 N1: `new URL` strips the LF, and the raw value would break `Location`.
      { authorization_endpoint: `${ISSUER}/author\nize` },
    ];
    for (const [index, extra] of cases.entries()) {
      harness = await buildSignInApp({ discovery: discoveryDocument(extra) });
      const response = await new CookieJar().fetch(harness.app, '/auth/idp/login');
      expect(response.status).toBe(503);
      await response.body?.cancel();
      if (index < cases.length - 1) await harness.app.stop();
    }
  });

  it('survives repeated logins with the longest returnTo on the COOKIE strategy (M100c F4)', async () => {
    harness = await buildSignInApp();
    const jar = new CookieJar();
    const longest = '/' + 'a'.repeat(MAX_RETURN_TO_BYTES - 1);
    for (let index = 0; index < 7; index += 1) {
      const response = await jar.fetch(harness.app, `/auth/idp/login?returnTo=${longest}`);
      expect(response.status).toBe(302);
      await response.body?.cancel();
    }
    expect(jar.cookie?.length ?? 0).toBeLessThan(3000);
  });

  it('keeps at most three pending attempts, so two tabs work but the map cannot grow', async () => {
    harness = await buildSignInApp();
    const jar = new CookieJar();
    for (let index = 0; index < 7; index += 1) {
      await followLogin(harness, jar);
    }
    const session = await json(await jar.fetch(harness.app, '/_session'));
    expect((session.pending as unknown[]).length).toBe(MAX_PENDING_ENTRIES);
  });
});
