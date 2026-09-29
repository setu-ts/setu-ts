import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { IssuerKeySet } from '../../src/issuers/key-set-cache.ts';
import { compileIssuers, discoveryUrlFor } from '../../src/issuers/trusted-issuer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeHttp } from '../fixtures/issuer-tokens.ts';

const KEY = { kty: 'RSA', kid: 'k1', n: 'n', e: 'AQAB' };

function setup(issuerValue: string, document: () => { status?: number; body: unknown }) {
  const runtime = createFakeRuntime();
  const fake = createFakeHttp({
    [discoveryUrlFor(issuerValue)]: document,
    'https://idp.test/certs': { body: { keys: [KEY] } },
    'http://localhost:8080/certs': { body: { keys: [KEY] } },
  });
  const failures: string[] = [];
  const compiled = compileIssuers([{
    name: 'idp',
    issuer: issuerValue,
    audience: 'api',
    keys: { discovery: true },
    keySet: { ttlMs: 1000, minRefreshIntervalMs: 100 },
    toPrincipal: () => null,
  }])[0];
  const keySet = new IssuerKeySet(compiled, runtime, fake.http, (_n, r) => failures.push(r));
  return { runtime, keySet, calls: fake.calls, failures };
}

describe('discovery', () => {
  it('removes one trailing slash so the path has a single /.well-known', () => {
    expect(discoveryUrlFor('https://tenant.auth0.com/')).toBe(
      'https://tenant.auth0.com/.well-known/openid-configuration',
    );
    expect(discoveryUrlFor('https://idp.test/realms/x')).toBe(
      'https://idp.test/realms/x/.well-known/openid-configuration',
    );
  });

  it('reads jwks_uri from a matching document and caches the document', async () => {
    const t = setup('https://idp.test/', () => ({
      body: { issuer: 'https://idp.test/', jwks_uri: 'https://idp.test/certs' },
    }));
    expect(await t.keySet.keys()).toEqual([KEY]);
    t.runtime.setHrtime(100);
    await t.keySet.keys(true);
    expect(t.calls).toEqual([
      'https://idp.test/.well-known/openid-configuration',
      'https://idp.test/certs',
      'https://idp.test/certs',
    ]);
  });

  it('refuses a document whose issuer does not equal the configured one', async () => {
    const t = setup('https://idp.test', () => ({
      body: { issuer: 'https://evil.test', jwks_uri: 'https://idp.test/certs' },
    }));
    expect(await t.keySet.keys()).toBeNull();
    expect(t.failures).toEqual(['discovery-issuer-mismatch']);
  });

  it('refuses a non-https jwks_uri and a missing one, allowing loopback http', async () => {
    const plain = setup('https://idp.test', () => ({
      body: { issuer: 'https://idp.test', jwks_uri: 'http://idp.test/certs' },
    }));
    expect(await plain.keySet.keys()).toBeNull();
    expect(plain.failures).toEqual(['discovery-jwks-uri-invalid']);
    const missing = setup('https://idp.test', () => ({ body: { issuer: 'https://idp.test' } }));
    expect(await missing.keySet.keys()).toBeNull();
    expect(missing.failures).toEqual(['discovery-jwks-uri-invalid']);
    const loopback = setup('http://localhost:8080', () => ({
      body: { issuer: 'http://localhost:8080', jwks_uri: 'http://localhost:8080/certs' },
    }));
    expect(await loopback.keySet.keys()).toEqual([KEY]);
  });

  it('retries a failed discovery only after the cooldown', async () => {
    let fail = true;
    const t = setup('https://idp.test', () =>
      fail ? { status: 500, body: 'no' } : {
        body: { issuer: 'https://idp.test', jwks_uri: 'https://idp.test/certs' },
      });
    expect(await t.keySet.keys()).toBeNull();
    fail = false;
    expect(await t.keySet.keys()).toBeNull();
    expect(t.calls.length).toBe(1);
    t.runtime.setHrtime(100);
    expect(await t.keySet.keys()).toEqual([KEY]);
  });
});
