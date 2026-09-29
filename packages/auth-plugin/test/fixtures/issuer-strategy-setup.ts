/**
 * Shared setup for outside-issuer strategy tests.
 *
 * @module
 */
import type { IRequest } from '@setu-ts/common';
import { IssuerStrategy } from '../../src/strategies/issuer-strategy.ts';
import { IssuerKeySet } from '../../src/issuers/key-set-cache.ts';
import { compileIssuers } from '../../src/issuers/trusted-issuer.ts';
import type { TrustedIssuer } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from './fake-runtime.ts';
import { createFakeHttp, generateTestKey, type TestKey } from './issuer-tokens.ts';

export const NOW = 1_800_000_000_000;
export const ISS = 'https://idp.test';
const JWKS = 'https://idp.test/jwks';

export function request(authorization?: string, header = 'authorization'): IRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set(header, authorization);
  return { headers } as unknown as IRequest;
}

export async function setupStrategy(
  options: {
    keys?: TestKey[];
    jwks?: () => { status?: number; body: unknown };
    issuer?: Partial<TrustedIssuer>;
    header?: string;
    scheme?: string;
  } = {},
) {
  const key = options.keys?.[0] ?? await generateTestKey('RS256', 'k1');
  const keys = options.keys ?? [key];
  const runtime = createFakeRuntime(NOW);
  let jwks = options.jwks ?? (() => ({ body: { keys: keys.map((k) => k.jwk) } }));
  const fake = createFakeHttp({ [JWKS]: () => jwks() });
  const refusals: string[] = [];
  const [compiled] = compileIssuers([{
    name: 'idp',
    issuer: ISS,
    audience: 'api',
    keys: { jwksUri: JWKS },
    toPrincipal: (claims) => ({ id: String(claims.sub) }),
    ...options.issuer,
  }]);
  const keySet = new IssuerKeySet(compiled, runtime, fake.http, () => {});
  const strategy = new IssuerStrategy({
    bindings: [{ issuer: compiled, keySet }],
    runtime,
    report: (_name, reason) => refusals.push(reason),
    ...(options.header !== undefined ? { header: options.header } : {}),
    ...(options.scheme !== undefined ? { scheme: options.scheme } : {}),
  });
  return {
    key,
    runtime,
    strategy,
    refusals,
    calls: fake.calls,
    setJwks: (next: () => { status?: number; body: unknown }) => {
      jwks = next;
    },
  };
}

export const valid = (extra: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: 'api',
  sub: 'u1',
  exp: NOW / 1000 + 300,
  ...extra,
});
