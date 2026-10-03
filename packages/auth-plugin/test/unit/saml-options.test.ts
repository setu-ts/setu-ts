/**
 * The `saml` sign-in arm's construction refusals, and the configuration handed
 * to node-saml, field by field (M100f plan §3.2).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { compileSignIn } from '../../src/sign-in/config.ts';
import type { SamlProvider } from '../../src/interfaces/index.ts';
import { MemorySamlRequestStore } from '../../src/stores/saml-request-store.ts';
import { compileSamlProvider } from '../../src/saml/config.ts';
import {
  buildLibraryConfig,
  SAML_CLOCK_SKEW_MS,
  SAML_PENDING_TTL_MS,
} from '../../src/saml/engine.ts';
import type { SamlCacheProvider } from '../../src/saml/engine.ts';
import { AuthPlugin } from '../../src/index.ts';

const PEM = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n';

const saml = (overrides: Record<string, unknown> = {}): SamlProvider =>
  ({
    kind: 'saml',
    name: 'corp',
    entityId: 'https://sp.test',
    idp: { entityId: 'https://idp.test', ssoUrl: 'https://idp.test/sso', certs: [PEM] },
    acsUrl: 'https://app.test/auth/corp/acs',
    toPrincipal: (profile: { nameID: string }) => ({ id: profile.nameID }),
    ...overrides,
  }) as unknown as SamlProvider;

function compile(provider: SamlProvider): void {
  compileSignIn({ providers: [provider] });
}

describe('saml arm validation', () => {
  it('compiles a valid provider with its three route paths and a memory store', () => {
    const compiled = compileSignIn({ providers: [saml()] });
    expect(compiled.providers).toEqual([]);
    expect(compiled.samlProviders).toHaveLength(1);
    const provider = compiled.samlProviders[0];
    expect(provider.loginPath).toBe('/auth/corp/login');
    expect(provider.acsPath).toBe('/auth/corp/acs');
    expect(provider.metadataPath).toBe('/auth/corp/metadata');
    expect(provider.store).toBeInstanceOf(MemorySamlRequestStore);
    expect(provider.idp.certs).toEqual([PEM]);
  });

  it('keeps an injected store, module and failureRedirect', () => {
    const store = new MemorySamlRequestStore();
    const module = { SAML: class {} };
    const compiled = compileSamlProvider(
      saml({ store, module, failureRedirect: '/login' }),
      'corp',
      '/auth',
    );
    expect(compiled.store).toBe(store);
    expect(compiled.module).toBe(module);
    expect(compiled.failureRedirect).toBe('/login');
  });

  it('honours a root base path', () => {
    const compiled = compileSignIn({
      basePath: '/',
      providers: [saml({ acsUrl: 'https://app.test/corp/acs' })],
    });
    expect(compiled.samlProviders[0].acsPath).toBe('/corp/acs');
  });

  const refusals: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
    ['an empty entityId', { entityId: '' }, /non-empty entityId/],
    ['a missing idp', { idp: undefined }, /needs an idp object/],
    ['an empty idp.entityId', {
      idp: { entityId: '', ssoUrl: 'https://idp.test/sso', certs: [PEM] },
    }, /idp\.entityId/],
    ['an http idp.ssoUrl', {
      idp: { entityId: 'x', ssoUrl: 'http://idp.example/sso', certs: [PEM] },
    }, /idp\.ssoUrl/],
    ['a missing idp.ssoUrl', {
      idp: { entityId: 'x', certs: [PEM] },
    }, /idp\.ssoUrl/],
    ['an empty certs list', {
      idp: { entityId: 'x', ssoUrl: 'https://idp.test/sso', certs: [] },
    }, /idp\.certs/],
    ['a non-array certs', {
      idp: { entityId: 'x', ssoUrl: 'https://idp.test/sso', certs: PEM },
    }, /idp\.certs/],
    ['an empty cert entry', {
      idp: { entityId: 'x', ssoUrl: 'https://idp.test/sso', certs: [''] },
    }, /idp\.certs/],
    ['a missing toPrincipal', { toPrincipal: undefined }, /toPrincipal/],
    ['an http acsUrl', { acsUrl: 'http://app.example/auth/corp/acs' }, /acsUrl must be https/],
    [
      'an acsUrl for another path',
      { acsUrl: 'https://app.test/acs' },
      /must end with \/auth\/corp\/acs/,
    ],
    ['an off-site failureRedirect', { failureRedirect: 'https://evil.test/' }, /failureRedirect/],
    ['an empty failureRedirect', { failureRedirect: '' }, /failureRedirect/],
    ['a store missing a method', { store: { saveRequest: () => {} } }, /store must implement/],
    ['a non-object module', { module: 'npm:x' }, /module must be/],
    ['a null module', { module: null }, /module must be/],
  ];
  for (const [label, overrides, message] of refusals) {
    it(`refuses ${label}`, () => {
      expect(() => compile(saml(overrides))).toThrow(message);
    });
  }

  it('refuses a saml name colliding with an oidc provider', () => {
    expect(() =>
      compileSignIn({
        providers: [
          saml(),
          {
            kind: 'oidc',
            name: 'corp',
            issuer: 'https://idp.test',
            clientId: 'c',
            redirectUri: 'https://app.test/auth/corp/callback',
            toPrincipal: () => null,
          },
        ],
      })
    ).toThrow(/duplicates/);
  });

  it('names saml among the accepted kinds', () => {
    expect(() => compile(saml({ kind: 'ldap' }))).toThrow(/'oidc', 'oauth2' or 'saml'/);
  });

  it('refuses at AuthPlugin(...), before any application exists', () => {
    expect(() => AuthPlugin({ signIn: { providers: [saml({ acsUrl: 'nope' })] } })).toThrow(
      /acsUrl/,
    );
  });
});

describe('library configuration', () => {
  it('sets every security option explicitly', () => {
    const cache: SamlCacheProvider = {
      saveAsync: () => Promise.resolve(null),
      getAsync: () => Promise.resolve(null),
      removeAsync: () => Promise.resolve(null),
    };
    const provider = compileSamlProvider(saml(), 'corp', '/auth');
    const config = buildLibraryConfig(provider, cache);
    expect(config).toEqual({
      issuer: 'https://sp.test',
      callbackUrl: 'https://app.test/auth/corp/acs',
      entryPoint: 'https://idp.test/sso',
      audience: 'https://sp.test',
      idpIssuer: 'https://idp.test',
      idpCert: [PEM],
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: 'always',
      acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
      requestIdExpirationPeriodMs: SAML_PENDING_TTL_MS,
      maxAssertionAgeMs: 0,
      signatureAlgorithm: 'sha256',
      authnRequestBinding: 'HTTP-Redirect',
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      cacheProvider: cache,
    });
    // A copy, so the library cannot mutate the compiled provider's list.
    expect(config.idpCert).not.toBe(provider.idp.certs);
    expect(SAML_CLOCK_SKEW_MS).toBe(60_000);
    expect(SAML_PENDING_TTL_MS).toBe(600_000);
  });
});
