/**
 * The SAML login and metadata routes against the real node-saml, and the
 * branches the real library cannot be made to take, through an injected fake
 * module (M100f plan §3.3–§3.6).
 *
 * @module
 */
import { afterEach, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  ACS_URL,
  buildSamlApp,
  generateSigningKey,
  IDP_SSO,
  MultiCookieJar,
  postAcs,
  PROVIDER,
  requestIdOf,
  SP_ENTITY,
  startLogin,
} from '../fixtures/saml-idp.ts';
import type { SamlHarness, TestSigningKey } from '../fixtures/saml-idp.ts';
import { SAML_BINDING_COOKIE } from '../../src/saml/binding-cookie.ts';
import { SAML_METADATA_CONTENT_TYPE } from '../../src/saml/routes.ts';
import type { ISamlRequestStore } from '../../src/index.ts';
import { MemorySamlRequestStore, SamlRuntimeLoadError } from '../../src/index.ts';
import type { SamlCacheProvider, SamlLibraryConfig } from '../../src/saml/engine.ts';

let key: TestSigningKey;
let harness: SamlHarness | undefined;

beforeAll(async () => {
  key = await generateSigningKey();
});

afterEach(async () => {
  await harness?.app.stop();
  harness = undefined;
});

async function inflate(location: string): Promise<string> {
  const encoded = new URL(location).searchParams.get('SAMLRequest') ?? '';
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

describe('SAML login and metadata (real node-saml)', () => {
  it('redirects to the IdP with a deflated AuthnRequest and sets the binding cookie', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const response = await jar.fetch(harness.app, `/auth/${PROVIDER}/login`);
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith(`${IDP_SSO}?SAMLRequest=`)).toBe(true);
    expect(new URL(location).searchParams.has('RelayState')).toBe(false);
    const xml = await inflate(location);
    expect(xml).toContain(`AssertionConsumerServiceURL="${ACS_URL}"`);
    expect(xml).toContain(`Destination="${IDP_SSO}"`);
    expect(xml).toContain(`>${SP_ENTITY}</saml:Issuer>`);
    expect(xml).not.toContain('RequestedAuthnContext');
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith(SAML_BINDING_COOKIE));
    expect(cookie).toMatch(/Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=None$/);
    expect(jar.cookies.get(SAML_BINDING_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('serves the SP metadata descriptor', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    for (let i = 0; i < 2; i++) {
      const response = await jar.fetch(harness.app, `/auth/${PROVIDER}/metadata`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(SAML_METADATA_CONTENT_TYPE);
      const xml = await response.text();
      expect(xml).toContain(`entityID="${SP_ENTITY}"`);
      expect(xml).toContain('AuthnRequestsSigned="false"');
      expect(xml).toContain('WantAssertionsSigned="true"');
      expect(xml).toContain(`Location="${ACS_URL}"`);
      expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    }
  });

  it('completes a login started on one replica on another sharing a store', async () => {
    const store = new MemorySamlRequestStore();
    harness = await buildSamlApp(key, { provider: { store } });
    const other = await buildSamlApp(key, { provider: { store } });
    try {
      const jar = new MultiCookieJar();
      const requestId = await startLogin(harness, jar);
      const { signedResponse } = await import('../fixtures/saml-idp.ts');
      const response = await postAcs(other, jar, signedResponse(key, requestId));
      expect(response.status).toBe(302);
    } finally {
      await other.app.stop();
    }
  });

  it('answers 503 when the store cannot save the request', async () => {
    const store: ISamlRequestStore = {
      saveRequest: () => Promise.reject(new Error('store down')),
      peekRequest: () => Promise.resolve(null),
      consumeRequest: () => Promise.resolve(null),
      claimAssertionId: () => Promise.resolve(true),
    };
    harness = await buildSamlApp(key, { provider: { store } });
    const jar = new MultiCookieJar();
    const response = await jar.fetch(harness.app, `/auth/${PROVIDER}/login`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('provider-unavailable');
    expect(jar.cookies.has(SAML_BINDING_COOKIE)).toBe(false);
  });

  it('keeps only a same-origin returnTo', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const requestId = await startLogin(harness, jar, '?returnTo=https://evil.test/');
    const { signedResponse } = await import('../fixtures/saml-idp.ts');
    const response = await postAcs(harness, jar, signedResponse(key, requestId));
    expect(response.headers.get('location')).toBe('/');
  });

  it('extracts the request id the fixture needs', async () => {
    harness = await buildSamlApp(key);
    const jar = new MultiCookieJar();
    const response = await jar.fetch(harness.app, `/auth/${PROVIDER}/login`);
    expect(await requestIdOf(response.headers.get('location') ?? '')).toMatch(/^_[0-9a-f]{40}$/);
  });
});

/** Behaviour of the injected fake library, set per test. */
interface FakeBehaviour {
  authorize: (cache: SamlCacheProvider) => Promise<string>;
  validate: (cache: SamlCacheProvider) => Promise<{ profile: unknown; loggedOut: boolean }>;
}

function fakeModule(behaviour: FakeBehaviour): { SAML: unknown } {
  class FakeSaml {
    readonly #config: SamlLibraryConfig;
    constructor(config: SamlLibraryConfig) {
      this.#config = config;
    }
    getAuthorizeUrlAsync(): Promise<string> {
      return behaviour.authorize(this.#config.cacheProvider);
    }
    validatePostResponseAsync(): Promise<{ profile: unknown; loggedOut: boolean }> {
      return behaviour.validate(this.#config.cacheProvider);
    }
    generateServiceProviderMetadata(): string {
      return '<md/>';
    }
  }
  return { SAML: FakeSaml };
}

const savingAuthorize = async (cache: SamlCacheProvider): Promise<string> => {
  await cache.saveAsync('_req1', '2026-01-01T00:00:00Z');
  return 'https://idp.test/sso?SAMLRequest=x';
};

function assertion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $: { ID: '_a1' },
    // A bare string, as xml2js yields for an element with no attributes.
    Issuer: ['https://idp.test/saml'],
    Subject: [{
      NameID: [{ _: 'alice' }],
      SubjectConfirmation: [{
        SubjectConfirmationData: [{
          $: { Recipient: ACS_URL, InResponseTo: '_req1', NotOnOrAfter: 'not-a-date' },
        }],
      }],
    }],
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}, parsed = assertion()): unknown {
  return {
    issuer: 'https://idp.test/saml',
    nameID: 'alice',
    inResponseTo: '_req1',
    getAssertion: () => ({ Assertion: parsed }),
    ...overrides,
  };
}

function withoutNameId(): Record<string, unknown> {
  const base = assertion();
  const subject = (base.Subject as Record<string, unknown>[])[0];
  return { ...base, Subject: [{ SubjectConfirmation: subject.SubjectConfirmation }] };
}

function withFormatAndSession(): Record<string, unknown> {
  const base = assertion();
  const subject = (base.Subject as Record<string, unknown>[])[0];
  return {
    ...base,
    Subject: [{ ...subject, NameID: [{ _: 'alice', $: { Format: 'fmt' } }] }],
    AuthnStatement: [{ $: { SessionIndex: 's' } }],
  };
}

async function runAcs(
  behaviour: Partial<FakeBehaviour>,
  options: {
    provider?: Record<string, unknown>;
    skipLogin?: boolean;
    body?: string;
    binding?: string;
  } = {},
): Promise<{ response: Response; jar: MultiCookieJar }> {
  harness = await buildSamlApp(key, {
    provider: {
      module: fakeModule({
        authorize: savingAuthorize,
        validate: () => Promise.resolve({ profile: profile(), loggedOut: false }),
        ...behaviour,
      }),
      ...options.provider,
    },
  });
  const jar = new MultiCookieJar();
  if (options.binding !== undefined) {
    jar.cookies.set(SAML_BINDING_COOKIE, options.binding);
  }
  if (options.skipLogin !== true) {
    const login = await jar.fetch(harness.app, `/auth/${PROVIDER}/login`);
    await login.body?.cancel();
  }
  const response = options.body === undefined
    ? await postAcs(harness, jar, 'eA==')
    : await jar.fetch(harness.app, `/auth/${PROVIDER}/acs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: options.body,
    });
  return { response, jar };
}

describe('SAML routes (injected library)', () => {
  it('signs in when the library resolves without consuming the request', async () => {
    const { response } = await runAcs({});
    expect(response.status).toBe(302);
  });

  it('answers 503 when the library throws while building the AuthnRequest', async () => {
    harness = await buildSamlApp(key, {
      provider: {
        module: fakeModule({
          authorize: () => Promise.reject(new Error('boom')),
          validate: () => Promise.reject(new Error('unused')),
        }),
      },
    });
    const response = await new MultiCookieJar().fetch(harness.app, `/auth/${PROVIDER}/login`);
    expect(response.status).toBe(503);
  });

  it('answers 503 when the library never saves a request', async () => {
    harness = await buildSamlApp(key, {
      provider: {
        module: fakeModule({
          authorize: () => Promise.resolve('https://idp.test/sso'),
          validate: () => Promise.reject(new Error('unused')),
        }),
      },
    });
    const response = await new MultiCookieJar().fetch(harness.app, `/auth/${PROVIDER}/login`);
    expect(response.status).toBe(503);
  });

  it("serves the injected library's metadata", async () => {
    harness = await buildSamlApp(key, {
      provider: {
        module: fakeModule({ authorize: savingAuthorize, validate: savingAuthorize as never }),
      },
    });
    const response = await new MultiCookieJar().fetch(harness.app, `/auth/${PROVIDER}/metadata`);
    expect(await response.text()).toBe('<md/>');
  });

  const refusals: ReadonlyArray<[string, Partial<FakeBehaviour>, string]> = [
    ['a null profile (NoPassive / logout)', {
      validate: () => Promise.resolve({ profile: null, loggedOut: true }),
    }, 'assertion-invalid'],
    ['a profile without InResponseTo', {
      validate: () =>
        Promise.resolve({ profile: profile({ inResponseTo: undefined }), loggedOut: false }),
    }, 'assertion-invalid'],
    ['a profile answering an unknown request', {
      validate: () =>
        Promise.resolve({ profile: profile({ inResponseTo: '_other' }), loggedOut: false }),
    }, 'state-invalid'],
    ['an assertion without an ID', {
      validate: () =>
        Promise.resolve({ profile: profile({}, assertion({ $: {} })), loggedOut: false }),
    }, 'assertion-invalid'],
    ['a profile with no assertion accessor', {
      validate: () =>
        Promise.resolve({ profile: profile({ getAssertion: undefined }), loggedOut: false }),
    }, 'assertion-invalid'],
    ['an assertion accessor returning nothing', {
      validate: () =>
        Promise.resolve({ profile: profile({ getAssertion: () => null }), loggedOut: false }),
    }, 'assertion-invalid'],
    ['a confirmation without data', {
      validate: () =>
        Promise.resolve({
          profile: profile({}, assertion({ Subject: [{ SubjectConfirmation: [{}] }] })),
          loggedOut: false,
        }),
    }, 'assertion-invalid'],
    ['no subject confirmation at all', {
      validate: () =>
        Promise.resolve({ profile: profile({}, assertion({ Subject: 'x' })), loggedOut: false }),
    }, 'assertion-invalid'],
    ['a subject-confirmation data node without attributes', {
      validate: () =>
        Promise.resolve({
          profile: profile(
            {},
            assertion({ Subject: [{ SubjectConfirmation: [{ SubjectConfirmationData: ['x'] }] }] }),
          ),
          loggedOut: false,
        }),
    }, 'assertion-invalid'],
    ['an assertion with no Issuer element (the issuer only as an attribute)', {
      validate: () => {
        const { Issuer: _dropped, ...noIssuer } = assertion();
        return Promise.resolve({ profile: profile({}, noIssuer), loggedOut: false });
      },
    }, 'assertion-invalid'],
    ['a profile without a NameID', {
      // node-saml's merged profile still carries `nameID` (from an attribute
      // of that name); only the missing ELEMENT may decide.
      validate: () =>
        Promise.resolve({
          profile: profile({ nameID: 'from-attribute' }, withoutNameId()),
          loggedOut: false,
        }),
    }, 'assertion-invalid'],
  ];
  for (const [label, behaviour, detail] of refusals) {
    it(`refuses ${label}`, async () => {
      const { response } = await runAcs(behaviour);
      expect(response.status).toBe(401);
      expect(await response.text()).toContain(detail);
    });
  }

  it('refuses a request recorded for another provider', async () => {
    const store = new MemorySamlRequestStore();
    await store.saveRequest({
      requestId: '_req1',
      provider: 'someone-else',
      returnTo: '/',
      binding: 'b',
      issuedAt: 'x',
      expiresAt: Number.MAX_SAFE_INTEGER,
    }, 0);
    // The browser presents the matching binding, so ONLY the provider check
    // can refuse this.
    const { response } = await runAcs({}, { provider: { store }, skipLogin: true, binding: 'b' });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('state-invalid');
  });

  it('builds a profile with a NameID format, a session index and no attributes', async () => {
    let seen: unknown;
    const { response } = await runAcs(
      {
        validate: () =>
          Promise.resolve({
            profile: profile({ attributes: 'x' }, withFormatAndSession()),
            loggedOut: false,
          }),
      },
      {
        provider: {
          toPrincipal: (p: unknown) => {
            seen = p;
            return { id: 'x' };
          },
        },
      },
    );
    expect(response.status).toBe(302);
    expect(seen).toEqual({
      issuer: 'https://idp.test/saml',
      nameID: 'alice',
      nameIDFormat: 'fmt',
      sessionIndex: 's',
      attributes: {},
    });
  });

  it("consumes through the library's removeAsync, and a null key consumes nothing", async () => {
    const { response } = await runAcs({
      validate: async (cache) => {
        expect(await cache.saveAsync('k', 'v')).toBeNull();
        expect(await cache.getAsync('_req1')).toBe('2026-01-01T00:00:00Z');
        expect(await cache.getAsync('_missing')).toBeNull();
        expect(await cache.removeAsync(null)).toBeNull();
        expect(await cache.removeAsync('_req1')).toBe('2026-01-01T00:00:00Z');
        // A second removal is answered from the record already captured.
        expect(await cache.removeAsync('_req1')).toBe('2026-01-01T00:00:00Z');
        return { profile: profile(), loggedOut: false };
      },
    });
    expect(response.status).toBe(302);
  });

  it("answers the library's getAsync/removeAsync with null at login", async () => {
    const { response } = await runAcs({
      authorize: async (cache) => {
        expect(await cache.getAsync('x')).toBeNull();
        expect(await cache.removeAsync('x')).toBeNull();
        return await savingAuthorize(cache);
      },
    });
    expect(response.status).toBe(302);
  });

  it('refuses an unreadable form body', async () => {
    const { response } = await runAcs({});
    expect(response.status).toBe(302);
    const bad = await harness!.app.fetch(
      new Request(`http://localhost/auth/${PROVIDER}/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(bad.status).toBe(401);
  });

  it('describes a non-Error library rejection in the debug log without leaking it', async () => {
    const { response } = await runAcs({ validate: () => Promise.reject('a string') });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('a string');
  });

  it('fails register() with SamlRuntimeLoadError for an unusable injected module', async () => {
    const error = await buildSamlApp(key, { provider: { module: { SAML: 'nope' } } }).catch((e) =>
      e
    );
    expect(error).toBeInstanceOf(SamlRuntimeLoadError);
  });
});
