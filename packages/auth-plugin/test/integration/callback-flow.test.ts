/**
 * Integration — the sign-in callback route (plan §3.6) on a real kernel
 * application with the real `SessionPlugin`, against a fake provider whose ID
 * tokens are signed with real keys and verified by the plugin's real verifier.
 *
 * Every refusal is asserted by its fixed detail, so a test cannot pass because
 * the callback failed for a DIFFERENT reason than the one it claims to cover.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { errorHandler } from '@setu-ts/exceptions';

import { encodeBase64Url } from '../../src/utils/base64url.ts';
import {
  buildSignInApp,
  callback,
  CLIENT_ID,
  CookieJar,
  followLogin,
  GH,
  ISSUER,
  json,
} from '../fixtures/sign-in-app.ts';
import type { BuildOptions, SignInHarness } from '../fixtures/sign-in-app.ts';

/** Asserts a 401 whose detail is the given fixed code. */
async function expectRefused(response: Response, detail: string): Promise<void> {
  expect(response.status).toBe(401);
  expect(await json(response)).toEqual({ error: 'Unauthorized', detail });
}

describe('sign-in callback route', () => {
  let harness: SignInHarness;
  let jar: CookieJar;

  async function start(options: BuildOptions = {}): Promise<void> {
    harness = await buildSignInApp(options);
    jar = new CookieJar();
  }

  afterEach(async () => {
    await harness.app.stop();
  });

  it('signs the user in, rotates the session id and redirects to the stored returnTo', async () => {
    await start({ session: { store: 'memory' } });
    const params = await followLogin(harness, jar, 'idp', '?returnTo=/dashboard');
    const before = (await json(await jar.fetch(harness.app, '/_session'))).id;

    const response = await callback(harness, jar, { code: 'c1', state: params.get('state') ?? '' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');

    const me = await json(await jar.fetch(harness.app, '/me'));
    expect(me.user).toEqual({ id: 'idp:user-1', roles: ['user'], claims: { amr: ['fed'] } });
    // Session fixation: the id the browser held before sign-in is gone.
    const after = (await json(await jar.fetch(harness.app, '/_session'))).id;
    expect(after).not.toBe(before);
  });

  it('exchanges the code with the stored PKCE verifier and client_secret_basic', async () => {
    await start();
    const params = await followLogin(harness, jar);
    await callback(harness, jar, { code: 'the-code', state: params.get('state') ?? '' });
    const exchange = harness.requests.find((request) => request.url === `${ISSUER}/token`);
    expect(exchange?.method).toBe('POST');
    expect(exchange?.form?.grant_type).toBe('authorization_code');
    expect(exchange?.form?.code).toBe('the-code');
    expect(exchange?.form?.redirect_uri).toBe('http://localhost/auth/idp/callback');
    expect(exchange?.headers?.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:shh`)}`);
    // The verifier sent is the one whose S256 hash was the login's challenge.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(exchange?.form?.code_verifier ?? ''),
    );
    expect(encodeBase64Url(new Uint8Array(digest))).toBe(params.get('code_challenge'));
  });

  it('hands the provider tokens to onTokens, and nowhere else', async () => {
    await start();
    const params = await followLogin(harness, jar);
    await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(harness.tokens.length).toBe(1);
    const tokens = harness.tokens[0] as Record<string, unknown>;
    expect(tokens.accessToken).toBe('provider-access-token');
    expect(typeof tokens.idToken).toBe('string');
    const session = JSON.stringify(await json(await jar.fetch(harness.app, '/_session')));
    expect(session).not.toContain('provider-access-token');
  });

  it('keeps a completed sign-in when onTokens throws', async () => {
    await start({ onTokensThrows: true });
    const params = await followLogin(harness, jar);
    const response = await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(response.status).toBe(302);
    expect((await jar.fetch(harness.app, '/me')).status).toBe(200);
  });

  it('refuses a provider-reported error without reading error_description', async () => {
    await start();
    const params = await followLogin(harness, jar);
    const response = await callback(harness, jar, {
      error: 'access_denied',
      error_description: 'user said no <script>',
      state: params.get('state') ?? '',
    });
    await expectRefused(response, 'provider-denied');
  });

  it('refuses a missing, an unknown and a replayed state', async () => {
    await start();
    await expectRefused(await callback(harness, jar, { code: 'c' }), 'state-invalid');
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: 'never-issued' }),
      'state-invalid',
    );
    const params = await followLogin(harness, jar);
    const state = params.get('state') ?? '';
    expect((await callback(harness, jar, { code: 'c', state })).status).toBe(302);
    await expectRefused(await callback(harness, jar, { code: 'c', state }), 'state-invalid');
  });

  it('refuses a state issued for a different provider (mix-up), consuming it', async () => {
    await start();
    const params = await followLogin(harness, jar, 'idp');
    const state = params.get('state') ?? '';
    await expectRefused(await callback(harness, jar, { code: 'c', state }, 'gh'), 'state-invalid');
    // Consumed: the right callback cannot use it afterwards either.
    await expectRefused(await callback(harness, jar, { code: 'c', state }), 'state-invalid');
  });

  it('refuses an RFC 9207 iss naming another issuer, and accepts the right one', async () => {
    await start();
    let params = await followLogin(harness, jar);
    await expectRefused(
      await callback(harness, jar, {
        code: 'c',
        state: params.get('state') ?? '',
        iss: 'https://attacker.test',
      }),
      'state-invalid',
    );
    params = await followLogin(harness, jar);
    const response = await callback(harness, jar, {
      code: 'c',
      state: params.get('state') ?? '',
      iss: ISSUER,
    });
    expect(response.status).toBe(302);
  });

  it('refuses an expired attempt', async () => {
    await start();
    const params = await followLogin(harness, jar);
    await jar.fetch(harness.app, '/_age-pending', { method: 'POST' });
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'state-invalid',
    );
  });

  it('refuses a callback carrying no code', async () => {
    await start();
    const params = await followLogin(harness, jar);
    await expectRefused(
      await callback(harness, jar, { state: params.get('state') ?? '' }),
      'exchange-failed',
    );
  });

  it('refuses an ID token whose nonce belongs to another attempt', async () => {
    await start();
    const params = await followLogin(harness, jar);
    harness.state.idClaims = { nonce: 'from-an-older-login' };
    await harness.prepare();
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'exchange-failed',
    );
    expect((await jar.fetch(harness.app, '/me')).status).toBe(401);
  });

  it('refuses an ID token minted for another client', async () => {
    await start();
    const params = await followLogin(harness, jar);
    harness.state.idClaims = { aud: 'someone-else' };
    await harness.prepare();
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'exchange-failed',
    );
  });

  it('refuses an ID token whose iss is another issuer or absent (M100c F1)', async () => {
    await start();
    for (const iss of ['https://evil.test', undefined]) {
      const params = await followLogin(harness, jar);
      harness.state.idClaims = { iss };
      await harness.prepare();
      await expectRefused(
        await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
        'exchange-failed',
      );
    }
  });

  it('redirects to a non-ASCII returnTo as a legal header (M100c F3)', async () => {
    await start();
    const params = await followLogin(
      harness,
      jar,
      'idp',
      `?returnTo=${encodeURIComponent('/日本')}`,
    );
    const response = await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/%E6%97%A5%E6%9C%AC');
  });

  it('checks azp when aud names several clients', async () => {
    await start();
    let params = await followLogin(harness, jar);
    harness.state.idClaims = { aud: [CLIENT_ID, 'other'], azp: 'other' };
    await harness.prepare();
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'exchange-failed',
    );
    params = await followLogin(harness, jar);
    harness.state.idClaims = { aud: [CLIENT_ID, 'other'], azp: CLIENT_ID };
    await harness.prepare();
    const accepted = await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(accepted.status).toBe(302);
  });

  it('refuses a token response with no ID token, a provider error, and an unreachable provider', async () => {
    await start();
    let params = await followLogin(harness, jar);
    harness.state.omitIdToken = true;
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'exchange-failed',
    );
    harness.state.omitIdToken = false;

    params = await followLogin(harness, jar);
    harness.state.tokenAnswer = { status: 400, body: { error: 'invalid_grant' } };
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'exchange-failed',
    );

    params = await followLogin(harness, jar);
    // A body the fake cannot serialize makes the seam reject, as a network
    // failure would: the refusal must still be the fixed detail, never a 500.
    harness.state.tokenAnswer = {
      get body(): unknown {
        throw new Error('connection reset');
      },
    };
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }),
      'exchange-failed',
    );
  });

  it('refuses with 403 when toPrincipal returns null or throws', async () => {
    await start({ oidc: { toPrincipal: () => null } });
    let params = await followLogin(harness, jar);
    let response = await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'Forbidden', detail: 'principal-refused' });
    await harness.app.stop();

    await start({
      oidc: {
        toPrincipal: () => {
          throw new Error('claims quoted here: secret@corp');
        },
      },
    });
    params = await followLogin(harness, jar);
    response = await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('secret@corp');
  });

  it('redirects to failureRedirect with a fixed error code instead of 401', async () => {
    await start({ oidc: { failureRedirect: '/login?from=idp' } });
    const response = await callback(harness, jar, { code: 'c', state: 'unknown' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?from=idp&error=state-invalid');
    await harness.app.stop();
    await start({ oidc: { failureRedirect: '/login' } });
    const plain = await callback(harness, jar, { error: 'access_denied' });
    expect(plain.headers.get('location')).toBe('/login?error=provider-denied');
  });

  it('answers in the configured error format when errorHandler is registered', async () => {
    await start({
      plugins: [{
        name: 'error-format',
        version: '0.0.0',
        register(ctx) {
          ctx.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 1 });
        },
      }],
    });
    const response = await callback(harness, jar, { code: 'c', state: 'unknown' });
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await json(response);
    expect(body.detail).toBe('state-invalid');
    expect(body.status).toBe(401);
    expect(body.message).toBeUndefined();
  });

  it('reads an oauth2 profile from the userinfo endpoint with the access token', async () => {
    await start();
    const params = await followLogin(harness, jar, 'gh', '?returnTo=/repos');
    const response = await callback(
      harness,
      jar,
      { code: 'gh-code', state: params.get('state') ?? '' },
      'gh',
    );
    expect(response.headers.get('location')).toBe('/repos');
    const exchange = harness.requests.find((request) => request.url === GH.token);
    // client_secret_post: the pair travels in the form, not a header.
    expect(exchange?.form?.client_secret).toBe('shh');
    expect(exchange?.headers?.authorization).toBeUndefined();
    const me = await json(await jar.fetch(harness.app, '/me'));
    expect((me.user as { id: string }).id).toBe('gh:42');
    // RFC 6750: the access token rides the Authorization header of the profile read.
    const profile = harness.requests.find((request) => request.url === GH.userinfo);
    expect(profile?.headers?.authorization).toBe('Bearer gh-token');
  });

  it('refuses with profile-unavailable when userinfo fails', async () => {
    await start();
    const params = await followLogin(harness, jar, 'gh');
    harness.state.userinfo = { status: 500, body: 'down' };
    await expectRefused(
      await callback(harness, jar, { code: 'c', state: params.get('state') ?? '' }, 'gh'),
      'profile-unavailable',
    );
  });
});
