/**
 * A test SAML identity provider and a real kernel application acting as its
 * service provider (M100f plan §5).
 *
 * The IdP is fake only at the network boundary: its responses are signed with
 * a freshly generated RSA key through real xml-crypto, and verified by the
 * REAL node-saml the plugin loads, so a test passing here has exercised every
 * check the ACS performs. No key material is committed — each run generates
 * its own, and node-saml verifies against the public key in PEM form.
 *
 * @module
 */
import { SignedXml } from 'npm:xml-crypto@^6';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, getSession, SessionPlugin } from '@setu-ts/session-plugin';
import type { SessionPluginOptions } from '@setu-ts/session-plugin';

import { AuthPlugin, requireAuth } from '../../src/index.ts';
import type { MfaOptions, SamlProvider } from '../../src/index.ts';

/** Base URL for `app.fetch` requests (no socket). */
export const BASE = 'http://localhost';
/** The IdP's entity id. */
export const IDP_ENTITY = 'https://idp.test/saml';
/** The IdP's SSO endpoint. */
export const IDP_SSO = 'https://idp.test/sso';
/** The SP entity id. */
export const SP_ENTITY = 'https://sp.test';
/** The provider name. */
export const PROVIDER = 'corp';
/** The ACS URL the IdP posts to. */
export const ACS_URL = `${BASE}/auth/${PROVIDER}/acs`;
/** Session secret. */
export const SESSION_SECRET = 'saml-session-secret-at-least-32-characters';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';

/** A signing key in the two PEM forms the fixture needs. */
export interface TestSigningKey {
  readonly privatePem: string;
  readonly publicPem: string;
}

function toPem(label: string, der: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Generates a fresh RSA-2048 signing key. */
export async function generateSigningKey(): Promise<TestSigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return {
    privatePem: toPem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    publicPem: toPem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey)),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Fields of one assertion; every one is overridable by a test. */
export interface AssertionFields {
  id: string;
  /** The signed SubjectConfirmationData InResponseTo; `null` omits it. */
  inResponseTo: string | null;
  issuer: string;
  /** The `NameID` element text; `null` omits the element. */
  nameID: string | null;
  audience: string;
  recipient: string | null;
  notBefore: number;
  notOnOrAfter: number;
  attributes: Record<string, string | string[]>;
}

/** Builds an unsigned assertion element. */
export function assertionXml(fields: AssertionFields): string {
  const attributes = Object.entries(fields.attributes).map(([name, value]) =>
    `<saml:Attribute Name="${name}">${
      (Array.isArray(value) ? value : [value]).map((v) =>
        `<saml:AttributeValue>${v}</saml:AttributeValue>`
      )
        .join('')
    }</saml:Attribute>`
  ).join('');
  const recipient = fields.recipient === null ? '' : ` Recipient="${fields.recipient}"`;
  return `<saml:Assertion xmlns:saml="${SAML_NS}" ID="${fields.id}" Version="2.0" IssueInstant="${
    iso(fields.notBefore)
  }"><saml:Issuer>${fields.issuer}</saml:Issuer><saml:Subject>${
    fields.nameID === null
      ? ''
      : `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${fields.nameID}</saml:NameID>`
  }<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${
    fields.inResponseTo === null ? '' : ` InResponseTo="${fields.inResponseTo}"`
  } NotOnOrAfter="${
    iso(fields.notOnOrAfter)
  }"${recipient}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${
    iso(fields.notBefore)
  }" NotOnOrAfter="${
    iso(fields.notOnOrAfter)
  }"><saml:AudienceRestriction><saml:Audience>${fields.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${
    iso(fields.notBefore)
  }" SessionIndex="session-1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attributes}</saml:AttributeStatement></saml:Assertion>`;
}

/** Signs the element whose `ID` is `id`, placing the signature after its Issuer. */
export function signElement(xml: string, id: string, key: TestSigningKey): string {
  const signer = new SignedXml({
    privateKey: key.privatePem,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  signer.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signer.computeSignature(xml, {
    location: { reference: `//*[@ID='${id}']/*[local-name()='Issuer']`, action: 'after' },
  });
  return signer.getSignedXml();
}

/** Wraps assertion XML (already signed or not) in a Response envelope. */
export function responseXml(
  assertions: string,
  inResponseTo: string | null,
  issuer = IDP_ENTITY,
): string {
  const irt = inResponseTo === null ? '' : ` InResponseTo="${inResponseTo}"`;
  return `<samlp:Response xmlns:samlp="${SAMLP_NS}" ID="_resp-${crypto.randomUUID()}" Version="2.0" IssueInstant="${
    iso(Date.now())
  }" Destination="${ACS_URL}"${irt}><saml:Issuer xmlns:saml="${SAML_NS}">${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertions}</samlp:Response>`;
}

/** Base64 for a SAMLResponse form field. */
export function encode(xml: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(xml)));
}

/** Inflates a Redirect-binding SAMLRequest and returns its `ID`. */
export async function requestIdOf(location: string): Promise<string> {
  const encoded = new URL(location).searchParams.get('SAMLRequest') ?? '';
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const xml = await new Response(stream).text();
  const match = / ID="([^"]+)"/.exec(xml);
  if (match === null) {
    throw new Error(`no ID in AuthnRequest: ${xml}`);
  }
  return match[1];
}

/** A cookie jar holding every cookie by name. */
export class MultiCookieJar {
  readonly cookies = new Map<string, string>();

  /** Records every `Set-Cookie`, dropping expired ones. */
  update(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      if (/max-age=0/i.test(header) || index === pair.length - 1) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, pair.slice(index + 1));
      }
    }
  }

  /** The `Cookie` header value, or `undefined` when empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Sends a request with the jar's cookies and records the answer. */
  async fetch(app: IKernelApplication, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = this.header();
    if (cookie !== undefined) {
      headers.set('cookie', cookie);
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

/** Options for {@linkcode buildSamlApp}. */
export interface SamlAppOptions {
  readonly provider?: Partial<SamlProvider>;
  readonly session?: Partial<SessionPluginOptions>;
  readonly plugins?: readonly IPlugin[];
  readonly mfa?: MfaOptions;
  /** Registered before AuthPlugin (CSRF-composition tests). */
  readonly before?: readonly IPlugin[];
}

/** A started SP application and its IdP key. */
export interface SamlHarness {
  readonly app: IKernelApplication;
  readonly key: TestSigningKey;
}

/** Builds and starts an SP application trusting `key`. */
export async function buildSamlApp(
  key: TestSigningKey,
  options: SamlAppOptions = {},
): Promise<SamlHarness> {
  const provider: SamlProvider = {
    kind: 'saml',
    name: PROVIDER,
    entityId: SP_ENTITY,
    idp: { entityId: IDP_ENTITY, ssoUrl: IDP_SSO, certs: [key.publicPem] },
    acsUrl: ACS_URL,
    toPrincipal: (profile) => ({
      id: `corp:${profile.nameID}`,
      roles: ['user'],
      claims: { email: profile.attributes.email },
    }),
    ...options.provider,
  };
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ...(options.before ?? []),
      SessionPlugin({ secret: SESSION_SECRET, ...options.session }),
      AuthPlugin({
        signIn: {
          providers: [provider],
          ...(options.mfa === undefined ? {} : { mfa: options.mfa }),
        },
      }),
      ...(options.plugins ?? []),
    ],
  });
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user }),
  });
  app.router.post('/_remember', (ctx) => {
    getSession(ctx).set('remembered', 'before-saml');
    return ctx.response.json({ ok: true });
  });
  app.router.get('/_csrf', async (ctx) => ctx.response.json({ token: await getCsrfToken(ctx) }));
  app.router.get(
    '/_remembered',
    (ctx) => ctx.response.json({ value: getSession(ctx).get('remembered') ?? null }),
  );
  await app.start();
  return { app, key };
}

/** Defaults for an assertion answering `requestId`. */
export function validFields(
  requestId: string,
  overrides: Partial<AssertionFields> = {},
): AssertionFields {
  const now = Date.now();
  return {
    id: `_assert-${crypto.randomUUID()}`,
    inResponseTo: requestId,
    issuer: IDP_ENTITY,
    nameID: 'alice',
    audience: SP_ENTITY,
    recipient: ACS_URL,
    notBefore: now - 30_000,
    notOnOrAfter: now + 300_000,
    attributes: { email: 'alice@corp.test' },
    ...overrides,
  };
}

/** A complete valid signed response for `requestId`, base64-encoded. */
export function signedResponse(
  key: TestSigningKey,
  requestId: string,
  overrides: Partial<AssertionFields> = {},
): string {
  const fields = validFields(requestId, overrides);
  return encode(responseXml(signElement(assertionXml(fields), fields.id, key), requestId));
}

/** Starts a login and returns the AuthnRequest id. */
export async function startLogin(
  harness: SamlHarness,
  jar: MultiCookieJar,
  query = '',
): Promise<string> {
  const response = await jar.fetch(harness.app, `/auth/${PROVIDER}/login${query}`);
  if (response.status !== 302) {
    throw new Error(`login answered ${response.status}: ${await response.text()}`);
  }
  await response.body?.cancel();
  return await requestIdOf(response.headers.get('location') ?? '');
}

/** Posts a SAMLResponse to the ACS. */
export function postAcs(
  harness: SamlHarness,
  jar: MultiCookieJar,
  samlResponse: string,
  extraHeaders: Record<string, string> = {},
  provider = PROVIDER,
): Promise<Response> {
  return jar.fetch(harness.app, `/auth/${provider}/acs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
  });
}
