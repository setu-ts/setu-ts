/**
 * The authorization-code exchange and userinfo read (plan §3.6).
 *
 * The seam records the EXACT request each `tokenEndpointAuth` method produces,
 * because the three methods differ only in where the client credential appears —
 * and a credential in the wrong place is either a broken login or a leak.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  authorizationUrl,
  exchangeCode,
  fetchUserInfo,
  parseTokenResponse,
} from '../../src/sign-in/token-exchange.ts';
import type { IAuthHttp } from '../../src/interfaces/index.ts';

interface Recorded {
  readonly url: string;
  readonly form: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

function seam(
  reply: { status: number; body: string },
  sink: { posts: Recorded[]; gets: Array<{ url: string }> },
): IAuthHttp {
  return {
    post(url, options) {
      sink.posts.push({ url, form: options.form, headers: options.headers ?? {} });
      return Promise.resolve(reply);
    },
    get(url, _options) {
      sink.gets.push({ url });
      return Promise.resolve(reply);
    },
  };
}

const base = {
  tokenEndpoint: 'https://idp.test/oauth/token',
  clientId: 'client-1',
  code: 'the-code',
  verifier: 'the-verifier',
  redirectUri: 'https://app.test/auth/acme/callback',
  signal: new AbortController().signal,
};

const OK = {
  status: 200,
  body: JSON.stringify({
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 300,
    scope: 'openid profile',
    refresh_token: 'rt-1',
    id_token: 'idt-1',
  }),
};

describe('exchangeCode', () => {
  it('sends client_secret_basic in the Authorization header, not the form', async () => {
    const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
    const outcome = await exchangeCode(seam(OK, sink), {
      ...base,
      auth: 'client_secret_basic',
      clientSecret: 'shhh',
    });
    expect(outcome.ok).toBe(true);
    const post = sink.posts[0];
    expect(post?.url).toBe(base.tokenEndpoint);
    // RFC 6749 §2.3.1: `client_id:client_secret`, base64 of the UTF-8 bytes.
    expect(post?.headers.authorization).toBe(
      `Basic ${btoa(`${base.clientId}:shhh`)}`,
    );
    expect(post?.form.client_secret).toBeUndefined();
    expect(post?.form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: base.redirectUri,
      client_id: 'client-1',
      code_verifier: 'the-verifier',
    });
  });

  it('sends client_secret_post as a form field and no Authorization header', async () => {
    const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
    await exchangeCode(seam(OK, sink), {
      ...base,
      auth: 'client_secret_post',
      clientSecret: 'shhh',
    });
    expect(sink.posts[0]?.form.client_secret).toBe('shhh');
    expect(sink.posts[0]?.headers.authorization).toBeUndefined();
  });

  it('sends neither credential for a public client', async () => {
    const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
    const outcome = await exchangeCode(seam(OK, sink), { ...base, auth: 'none' });
    expect(outcome.ok).toBe(true);
    expect(sink.posts[0]?.headers.authorization).toBeUndefined();
    expect(sink.posts[0]?.form.client_secret).toBeUndefined();
    // PKCE is still sent: it is the only thing binding the code to this attempt.
    expect(sink.posts[0]?.form.code_verifier).toBe('the-verifier');
  });

  it('refuses a secret-based method whose secret is missing', async () => {
    for (const auth of ['client_secret_basic', 'client_secret_post'] as const) {
      const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
      const outcome = await exchangeCode(seam(OK, sink), { ...base, auth });
      expect(outcome.ok).toBe(false);
      // Refused before any request: a half-configured credential must not send
      // a code to a provider that cannot authenticate the client.
      expect(sink.posts).toEqual([]);
    }
  });

  it('escapes a secret containing form syntax so it cannot inject a parameter', async () => {
    const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
    await exchangeCode(seam(OK, sink), {
      ...base,
      auth: 'client_secret_post',
      clientSecret: 'a&grant_type=implicit&scope=admin',
    });
    // The seam received the secret as ONE value; encoding is its job.
    expect(sink.posts[0]?.form.client_secret).toBe('a&grant_type=implicit&scope=admin');
    expect(sink.posts[0]?.form.grant_type).toBe('authorization_code');
    expect(Object.keys(sink.posts[0]?.form ?? {})).not.toContain('scope');
  });

  it('reports a provider error with its sanitised code and drops its description', async () => {
    const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
    const outcome = await exchangeCode(
      seam(
        {
          status: 400,
          body: JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Code is expired, user: admin@corp',
          }),
        },
        sink,
      ),
      { ...base, auth: 'none' },
    );
    expect(outcome).toEqual({ ok: false, reason: 'provider-error', errorCode: 'invalid_grant' });
    // The description is attacker-controlled text: it must not ride along.
    expect(JSON.stringify(outcome)).not.toContain('admin@corp');
  });

  it('drops a provider error code outside the RFC 6749 alphabet', () => {
    const outcome = parseTokenResponse(400, JSON.stringify({ error: 'oops <script>' }));
    expect(outcome).toEqual({ ok: false, reason: 'provider-error' });
  });

  it('refuses a non-JSON body, an array, and a 200 with no access token', () => {
    expect(parseTokenResponse(200, 'not json')).toEqual({
      ok: false,
      reason: 'invalid-response',
    });
    expect(parseTokenResponse(200, '[]')).toEqual({ ok: false, reason: 'invalid-response' });
    expect(parseTokenResponse(200, '{}')).toEqual({ ok: false, reason: 'invalid-response' });
    expect(parseTokenResponse(200, '{"access_token":""}')).toEqual({
      ok: false,
      reason: 'invalid-response',
    });
  });

  it('omits optional fields the provider did not send, and rejects a non-finite expiry', () => {
    const outcome = parseTokenResponse(200, '{"access_token":"at","expires_in":"300"}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.tokens).toEqual({ accessToken: 'at' });
    expect('expiresIn' in outcome.tokens).toBe(false);
  });
});

describe('fetchUserInfo', () => {
  it('returns the claims object', async () => {
    const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
    const outcome = await fetchUserInfo(
      seam({ status: 200, body: '{"sub":"u1","login":"octo"}' }, sink),
      { userinfoEndpoint: 'https://api.github.com/user', accessToken: 'at', signal: base.signal },
    );
    expect(outcome).toEqual({ ok: true, claims: { sub: 'u1', login: 'octo' } });
    expect(sink.gets).toEqual([{ url: 'https://api.github.com/user' }]);
  });

  it('refuses a non-2xx, a non-JSON body, and a JSON array', async () => {
    const cases: Array<[number, string, string]> = [
      [401, '{}', 'provider-error'],
      [200, 'nope', 'invalid-profile'],
      [200, '[1,2]', 'invalid-profile'],
    ];
    for (const [status, body, reason] of cases) {
      const sink = { posts: [] as Recorded[], gets: [] as Array<{ url: string }> };
      const outcome = await fetchUserInfo(seam({ status, body }, sink), {
        userinfoEndpoint: 'https://api.github.com/user',
        accessToken: 'at',
        signal: base.signal,
      });
      expect(outcome).toEqual({ ok: false, reason });
    }
  });
});

describe('authorizationUrl', () => {
  it('sends the code-flow parameters with an S256 challenge', () => {
    const url = new URL(
      authorizationUrl({
        authorizationEndpoint: 'https://idp.test/authorize',
        clientId: 'client-1',
        scopes: ['openid', 'profile'],
        redirectUri: base.redirectUri,
        state: 'st-1',
        nonce: 'n-1',
        challenge: 'chal-1',
      }),
    );
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('nonce')).toBe('n-1');
    expect(url.searchParams.get('code_challenge')).toBe('chal-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('omits nonce for an oauth2 provider and appends to an endpoint with a query', () => {
    const url = authorizationUrl({
      authorizationEndpoint: 'https://idp.test/authorize?tenant=7',
      clientId: 'c',
      scopes: [],
      redirectUri: '/auth/x/callback',
      state: 's',
      challenge: 'ch',
    });
    expect(url).toContain('authorize?tenant=7&');
    expect(url).not.toContain('nonce');
    // Exactly one `?`, whatever the endpoint looked like.
    expect(url.match(/\?/g)?.length).toBe(1);
  });
});
