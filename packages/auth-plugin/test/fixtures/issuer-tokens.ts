/**
 * Real-crypto fixtures for outside-issuer tests: key pairs per algorithm,
 * exported as JWKs, and a signer producing compact JWS tokens.
 *
 * @module
 */
import { encodeBase64Url } from '../../src/utils/base64url.ts';
import type { IAuthHttp, IssuerAlgorithm } from '../../src/interfaces/index.ts';

/** A generated signing key with its public JWK. */
export interface TestKey {
  readonly alg: IssuerAlgorithm | 'Ed25519';
  readonly privateKey: CryptoKey;
  readonly jwk: Record<string, unknown>;
}

const GEN: Record<IssuerAlgorithm, RsaHashedKeyGenParams | EcKeyGenParams | Algorithm> = {
  RS256: {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  PS256: {
    name: 'RSA-PSS',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
  ES384: { name: 'ECDSA', namedCurve: 'P-384' },
  EdDSA: { name: 'Ed25519' },
};

const SIGN: Record<IssuerAlgorithm, RsaPssParams | EcdsaParams | Algorithm> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5' },
  PS256: { name: 'RSA-PSS', saltLength: 32 },
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
  ES384: { name: 'ECDSA', hash: 'SHA-384' },
  EdDSA: { name: 'Ed25519' },
};

/**
 * Generates a key pair for an algorithm and returns its public JWK tagged with
 * `kid`, `use: 'sig'` and `alg`.
 */
export async function generateTestKey(
  alg: IssuerAlgorithm,
  kid: string,
  jwkExtras: Record<string, unknown> = {},
): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(GEN[alg], true, ['sign', 'verify']) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { key_ops: _ops, ext: _ext, alg: _alg, ...material } = exported;
  return {
    alg,
    privateKey: pair.privateKey,
    jwk: { ...material, kid, use: 'sig', alg, ...jwkExtras },
  };
}

function segment(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Signs a token. `header` overrides the default `{ alg, typ, kid }`. */
export async function signToken(
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const family: IssuerAlgorithm = key.alg === 'Ed25519' ? 'EdDSA' : key.alg;
  const head = { alg: key.alg, typ: 'JWT', kid: key.jwk.kid, ...header };
  const input = `${segment(head)}.${segment(payload)}`;
  const signature = await crypto.subtle.sign(
    SIGN[family],
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Builds an unsigned-shape token from raw header, payload and signature bytes. */
export function rawToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature = 'AA',
): string {
  return `${segment(header)}.${segment(payload)}.${signature}`;
}

/** One recorded request: the method, target, and what was sent. */
export interface RecordedRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly form: Readonly<Record<string, string>> | null;
  readonly headers: Readonly<Record<string, string>> | null;
}

/** A recording fake `IAuthHttp` answering from a URL → response map. */
export function createFakeHttp(
  routes: Record<
    string,
    { status?: number; body: unknown } | (() => { status?: number; body: unknown })
  >,
): {
  http: IAuthHttp;
  /** Every requested URL, in order, whichever method was used. */
  calls: string[];
  /** Every request with its method and body, for asserting an exact exchange. */
  requests: RecordedRequest[];
} {
  const calls: string[] = [];
  const requests: RecordedRequest[] = [];
  const answer = (
    method: 'GET' | 'POST',
    url: string,
    form: Readonly<Record<string, string>> | null,
    headers: Readonly<Record<string, string>> | null,
  ): Promise<{ status: number; body: string }> => {
    calls.push(url);
    requests.push({ method, url, form, headers });
    const route = routes[url];
    if (route === undefined) {
      return Promise.reject(new Error(`no route for ${url}`));
    }
    const resolved = typeof route === 'function' ? route() : route;
    const body = typeof resolved.body === 'string'
      ? resolved.body
      : JSON.stringify(resolved.body);
    return Promise.resolve({ status: resolved.status ?? 200, body });
  };
  return {
    calls,
    requests,
    http: {
      get(url) {
        return answer('GET', url, null, null);
      },
      post(url, { form, headers }) {
        return answer('POST', url, form, headers ?? null);
      },
    },
  };
}
