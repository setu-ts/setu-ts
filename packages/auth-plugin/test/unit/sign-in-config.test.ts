/**
 * `signIn` option validation (plan §3.2/§3.3).
 *
 * Each refusal is a configuration that would otherwise fail at the provider with
 * an error naming neither the option nor the route, so the message is asserted
 * along with the refusal.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { compileSignIn, DEFAULT_SIGN_IN_BASE_PATH } from '../../src/sign-in/config.ts';
import { MemoryPasskeyStore } from '../../src/stores/passkey-store.ts';
import type { OAuth2Provider, OidcProvider, SignInConfig } from '../../src/interfaces/index.ts';

const oidc = (overrides: Partial<OidcProvider> = {}): OidcProvider => ({
  kind: 'oidc',
  name: 'acme',
  clientId: 'client-1',
  clientSecret: 'secret-at-least-8',
  issuer: 'https://idp.test',
  redirectUri: 'https://app.test/auth/acme/callback',
  toPrincipal: (claims) => ({ id: String(claims.sub) }),
  ...overrides,
});

const oauth2 = (overrides: Partial<OAuth2Provider> = {}): OAuth2Provider => ({
  kind: 'oauth2',
  name: 'github',
  clientId: 'gh-client',
  clientSecret: 'gh-secret-at-least-8',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  userinfoEndpoint: 'https://api.github.com/user',
  redirectUri: 'https://app.test/auth/github/callback',
  toPrincipal: (claims) => ({ id: String(claims.login) }),
  ...overrides,
});

/**
 * The same provider with the secret field REMOVED rather than set to `undefined`
 * — what a genuinely public client looks like, and the only way to express it
 * under exactOptionalPropertyTypes.
 */
function withoutSecret(provider: OidcProvider): OidcProvider {
  const { clientSecret, ...rest } = provider;
  expect(clientSecret).toBe('secret-at-least-8');
  return rest as OidcProvider;
}

const config = (providers: readonly unknown[], base?: string): SignInConfig =>
  ({ providers, ...(base === undefined ? {} : { basePath: base }) }) as SignInConfig;

function refusal(input: SignInConfig): string {
  try {
    compileSignIn(input);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('compileSignIn', () => {
  it('applies the default base path and derives route paths', () => {
    const compiled = compileSignIn(config([oidc()]));
    expect(compiled.basePath).toBe(DEFAULT_SIGN_IN_BASE_PATH);
    expect(compiled.logoutPath).toBe('/auth/logout');
    const provider = compiled.providers[0];
    expect(provider?.loginPath).toBe('/auth/acme/login');
    expect(provider?.callbackPath).toBe('/auth/acme/callback');
    expect(provider?.kind).toBe('oidc');
  });

  it('honours a custom prefix, and a bare / means no prefix at all', () => {
    expect(
      compileSignIn(
        config([oidc({ redirectUri: 'https://app.test/signin/acme/callback' })], '/signin'),
      ).providers[0]?.loginPath,
    ).toBe(
      '/signin/acme/login',
    );
    const root = compileSignIn(config([oidc()], '/'));
    expect(root.providers[0]?.loginPath).toBe('/acme/login');
    expect(root.logoutPath).toBe('/logout');
  });

  it('refuses a base path that is not kebab segments without a trailing slash', () => {
    for (const basePath of ['/Auth', '/auth/', '/a//b', 'auth', '/a_b']) {
      expect(refusal(config([oidc()], basePath)), basePath).toContain('basePath');
    }
  });

  it('refuses a provider name that is not kebab-case or duplicates another', () => {
    expect(refusal(config([oidc({ name: 'Acme' })]))).toContain('kebab-case');
    expect(refusal(config([oidc({ name: 'acme_x' })]))).toContain('kebab-case');
    expect(refusal(config([oidc(), oidc()]))).toContain('duplicates another provider name');
  });

  it('refuses an empty provider list and an unknown kind', () => {
    expect(refusal(config([]))).toContain('at least one provider');
    // With mfa it is a password-only sign-in, not a mistake.
    const passwordOnly = compileSignIn({ providers: [], mfa: { required: () => true } });
    expect(passwordOnly.providers).toEqual([]);
    expect(passwordOnly.mfa).not.toBeNull();
    // With passkeys it is a passkey-only sign-in, also not a mistake.
    const passkeyOnly = compileSignIn({
      providers: [],
      passkeys: {
        rpId: 'localhost',
        rpName: 'Test',
        origins: ['http://localhost'],
        store: new MemoryPasskeyStore(),
        resolvePrincipal: () => null,
      },
    });
    expect(passkeyOnly.providers).toEqual([]);
    expect(passkeyOnly.mfa).toBeNull();
    expect(passkeyOnly.passkeys).not.toBeNull();
    expect(refusal(config([{ ...oidc(), kind: 'saml' }]))).toContain("must be 'oidc' or 'oauth2'");
  });

  it('refuses a redirectUri that does not end with the provider callback path', () => {
    // The registered route and the value the provider matches against must be
    // the same string; a mismatch fails at the provider instead of here.
    expect(
      refusal(config([oidc({ redirectUri: 'https://app.test/auth/other/callback' })])),
    ).toContain('path must end with /auth/acme/callback');
    // The configured basePath is part of the registered route.
    expect(
      refusal(config([oidc({ redirectUri: 'https://app.test/auth/acme/callback' })], '/signin')),
    ).toContain('path must end with /signin/acme/callback');
    expect(() =>
      compileSignIn(config([oidc({ redirectUri: 'https://app.test/acme/callback' })], '/'))
    ).not.toThrow();
    // Compared on the parsed path: a query does not defeat it, a mount prefix is allowed.
    expect(() =>
      compileSignIn(config([oidc({ redirectUri: 'https://app.test/auth/acme/callback?x=1' })]))
    ).not.toThrow();
    expect(() =>
      compileSignIn(config([oidc({ redirectUri: 'https://app.test/api/auth/acme/callback' })]))
    ).not.toThrow();
    expect(
      refusal(config([oidc({ redirectUri: 'http://app.test/auth/acme/callback' })])),
    ).toContain('https');
  });

  it('refuses a failureRedirect that is not same-origin', () => {
    expect(refusal(config([oidc({ failureRedirect: '//evil.test' })]))).toContain('same-origin');
    expect(refusal(config([oidc({ failureRedirect: 'https://evil.test/oops' })]))).toContain(
      'same-origin',
    );
    expect(
      compileSignIn(config([oidc({ failureRedirect: '/login' })])).providers[0]?.failureRedirect,
    )
      .toBe('/login');
  });

  it('applies the credential rules', () => {
    // A secret defaults to basic; without one the client is public.
    expect(compileSignIn(config([oidc()])).providers[0]?.tokenEndpointAuth).toBe(
      'client_secret_basic',
    );
    const publicClient = withoutSecret(oidc({ tokenEndpointAuth: 'none' }));
    expect(compileSignIn(config([publicClient])).providers[0]?.tokenEndpointAuth).toBe('none');
    // Half-configured credentials are refused rather than silently honoured: a
    // secret-based method with NO secret would send a code to a provider that
    // cannot authenticate the client. Both methods are checked, since the guard
    // is one condition over two values.
    for (const auth of ['client_secret_basic', 'client_secret_post'] as const) {
      expect(refusal(config([withoutSecret(oidc({ tokenEndpointAuth: auth }))])), auth).toContain(
        'needs a clientSecret',
      );
    }
    // A secret-based method WITH a secret is the normal case, not a refusal.
    expect(
      compileSignIn(config([oidc({ tokenEndpointAuth: 'client_secret_post' })])).providers[0]
        ?.clientSecret,
    ).toBe('secret-at-least-8');
    // A public client that says so is accepted.
    expect(
      compileSignIn(config([withoutSecret(oidc({ tokenEndpointAuth: 'none' }))])).providers[0]
        ?.tokenEndpointAuth,
    ).toBe('none');
    // A secret that is never sent is a configuration mistake, not a free default.
    expect(refusal(config([oidc({ tokenEndpointAuth: 'none' })]))).toContain('never be sent');
    expect(refusal(config([oidc({ tokenEndpointAuth: 'basic' as never })]))).toContain(
      'tokenEndpointAuth must be one of',
    );
  });

  it('compiles the oidc arm through the shared issuer path with clientId as audience', () => {
    const provider = compileSignIn(config([oidc()])).providers[0];
    // audience = clientId is what makes an ID token minted for another client
    // fail, and routing through compileIssuers means M100b's pinned validation
    // applies to the same provider.
    expect(provider?.compiledIssuer?.audience).toBe('client-1');
    expect(provider?.compiledIssuer?.issuer).toBe('https://idp.test');
    expect(provider?.compiledIssuer?.discoveryUrl).toBe(
      'https://idp.test/.well-known/openid-configuration',
    );
    expect(provider?.compiledIssuer?.jwksUri).toBeNull();
  });

  it('refuses an oidc provider whose scopes omit openid', () => {
    expect(refusal(config([oidc({ scopes: ['profile'] })]))).toContain('openid scope');
    expect(compileSignIn(config([oidc()])).providers[0]?.scopes).toEqual(['openid']);
    expect(compileSignIn(config([oidc({ scopes: ['openid', 'email'] })])).providers[0]?.scopes)
      .toEqual(['openid', 'email']);
  });

  it('compiles the oauth2 arm with its three endpoints and no issuer', () => {
    const provider = compileSignIn(config([oauth2()])).providers[0];
    expect(provider?.kind).toBe('oauth2');
    expect(provider?.tokenEndpoint).toBe('https://github.com/login/oauth/access_token');
    expect(provider?.userinfoEndpoint).toBe('https://api.github.com/user');
    expect(provider?.compiledIssuer).toBeUndefined();
    expect(provider?.scopes).toEqual([]);
  });

  it('refuses an oauth2 provider missing or holding an insecure endpoint', () => {
    for (
      const bad of [
        oauth2({ tokenEndpoint: 'ftp://github.com/token' }),
        oauth2({ userinfoEndpoint: 'http://api.github.com/user' }),
        oauth2({ authorizationEndpoint: 'not-a-url' }),
      ]
    ) {
      expect(refusal(config([bad]))).toContain('must be https');
    }
  });

  it('refuses rpInitiatedLogout on the oauth2 arm', () => {
    // The type forbids it; a plain-JavaScript config must still be refused,
    // because the logout route only knows how to end an OIDC session.
    expect(
      refusal(config([oauth2({ rpInitiatedLogout: { postLogoutRedirectUri: '/done' } } as never)])),
    )
      .toContain('only available on an oidc provider');
  });

  it('compiles rpInitiatedLogout and refuses more than one provider claiming it', () => {
    const compiled = compileSignIn(config([
      oidc({
        rpInitiatedLogout: { postLogoutRedirectUri: 'https://app.test/auth/logout/done' },
      }),
    ]));
    expect(compiled.rpLogoutProvider?.name).toBe('acme');
    expect(compiled.rpLogoutProvider?.rpInitiatedLogout?.idTokenHint).toBe(false);

    expect(
      refusal(config([
        oidc({ rpInitiatedLogout: { postLogoutRedirectUri: 'https://app.test/a' } }),
        oidc({
          name: 'other',
          redirectUri: 'https://app.test/auth/other/callback',
          rpInitiatedLogout: { postLogoutRedirectUri: 'https://app.test/b' },
        }),
      ])),
    ).toContain('only one signIn provider may set rpInitiatedLogout');
  });

  it('requires a toPrincipal function and a non-empty clientId', () => {
    expect(refusal(config([oidc({ toPrincipal: undefined as never })]))).toContain('toPrincipal');
    expect(refusal(config([oidc({ clientId: '' })]))).toContain('clientId');
  });

  describe('mfa', () => {
    const withMfa = (mfa: unknown): SignInConfig => ({ providers: [oidc()], mfa }) as SignInConfig;
    const required = () => true;

    it('is null when absent and passes a valid policy through', () => {
      expect(compileSignIn(config([oidc()])).mfa).toBeNull();
      const mfa = { required, pendingTtlMs: 60_000, challengePath: '/mfa' };
      expect(compileSignIn(withMfa(mfa)).mfa).toBe(mfa);
    });

    it('refuses a pendingTtlMs that would never expire or always expire', () => {
      // NaN is what Number(env.X) yields for an unset variable, and every
      // comparison against it is false: the record would never expire.
      for (const pendingTtlMs of [Number.NaN, 0, -1, 1.5, Infinity]) {
        expect(refusal(withMfa({ required, pendingTtlMs })), String(pendingTtlMs))
          .toContain('pendingTtlMs');
      }
    });

    it('refuses a non-function required', () => {
      expect(refusal(withMfa({ required: true }))).toContain('mfa.required');
    });

    it('refuses a challengePath that is not same-origin', () => {
      for (const challengePath of ['', '//evil.test', 'https://evil.test/', 'mfa', '/\\evil']) {
        expect(refusal(withMfa({ required, challengePath })), challengePath)
          .toContain('challengePath');
      }
    });
  });
});
