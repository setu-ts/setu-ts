import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin, AuthPluginConfigurationError } from '../../src/index.ts';
import type { TrustedIssuer } from '../../src/index.ts';
import { compileIssuers, isAcceptableUrl } from '../../src/issuers/trusted-issuer.ts';

const base: TrustedIssuer = {
  name: 'idp',
  issuer: 'https://idp.test',
  audience: 'api',
  keys: { jwksUri: 'https://idp.test/jwks' },
  toPrincipal: () => null,
};

function refusal(entries: readonly unknown[]): string {
  try {
    AuthPlugin({ issuers: entries as TrustedIssuer[] });
  } catch (error) {
    expect(error).toBeInstanceOf(AuthPluginConfigurationError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('TrustedIssuer validation at construction', () => {
  it('applies defaults', () => {
    const [compiled] = compileIssuers([base]);
    expect([...compiled.algorithms]).toEqual(['RS256', 'PS256', 'ES256', 'ES384', 'EdDSA']);
    expect(compiled.clockToleranceSec).toBe(30);
    expect(compiled.timings).toEqual({
      ttlMs: 600_000,
      minRefreshIntervalMs: 60_000,
      fetchTimeoutMs: 5_000,
      maxStaleMs: 86_400_000,
    });
    expect(compiled.discoveryUrl).toBeNull();
  });

  it('refuses each weakening configuration by name', () => {
    const cases: Array<[unknown[], string]> = [
      [[{ ...base, name: '' }], 'non-empty name'],
      [[base, { ...base, issuer: 'https://b.test' }], 'duplicates another issuer name'],
      [[base, { ...base, name: 'b' }], "duplicates the issuer 'https://idp.test'"],
      [[{ ...base, issuer: '' }], 'non-empty issuer'],
      [[{ ...base, audience: '' }], 'non-empty audience'],
      [[{ ...base, toPrincipal: undefined }], 'toPrincipal'],
      [[{ ...base, algorithms: [] }], 'must not be empty'],
      [[{ ...base, algorithms: ['HS256'] }], "algorithm 'HS256' is not supported"],
      [[{ ...base, keys: { jwksUri: 'http://idp.test/jwks' } }], 'keys.jwksUri'],
      [[{ ...base, issuer: 'http://idp.test', keys: { discovery: true } }], 'for discovery'],
      [[{ ...base, keys: {} }], 'keys must be'],
    ];
    for (const [entries, message] of cases) {
      expect(refusal(entries)).toContain(message);
    }
  });

  it('refuses a clock tolerance of NaN, Infinity, -1 and 301', () => {
    for (const value of [NaN, Infinity, -1, 301]) {
      expect(refusal([{ ...base, clockToleranceSec: value }])).toContain('clockToleranceSec');
    }
    expect(compileIssuers([{ ...base, clockToleranceSec: 0 }])[0].clockToleranceSec).toBe(0);
  });

  it('refuses non-finite or non-positive key-set timings', () => {
    for (const key of ['ttlMs', 'minRefreshIntervalMs', 'fetchTimeoutMs', 'maxStaleMs']) {
      for (const value of [NaN, 0, -5, Infinity]) {
        expect(refusal([{ ...base, keySet: { [key]: value } }])).toContain(`keySet.${key}`);
      }
    }
  });

  it('builds a discovery URL for discovery: true', () => {
    const [compiled] = compileIssuers([{ ...base, keys: { discovery: true } }]);
    expect(compiled.discoveryUrl).toBe('https://idp.test/.well-known/openid-configuration');
    expect(compiled.jwksUri).toBeNull();
  });

  it('accepts https and loopback http only', () => {
    expect(isAcceptableUrl('https://x.test')).toBe(true);
    expect(isAcceptableUrl('http://localhost:1')).toBe(true);
    expect(isAcceptableUrl('http://127.0.0.1')).toBe(true);
    expect(isAcceptableUrl('http://[::1]:8')).toBe(true);
    expect(isAcceptableUrl('http://idp.test')).toBe(false);
    expect(isAcceptableUrl('ftp://x.test')).toBe(false);
    expect(isAcceptableUrl('not a url')).toBe(false);
  });

  it('accepts issuers as the only strategy', () => {
    const plugin = AuthPlugin({ issuers: [base] });
    expect(plugin.provides).not.toContain('jwt');
  });
});
