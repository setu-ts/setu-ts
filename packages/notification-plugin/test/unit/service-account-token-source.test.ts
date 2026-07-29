/**
 * Tests for `ServiceAccountTokenSource` — RS256 assertion signing, the OAuth2
 * exchange, and token caching.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { ServiceAccountTokenSource } from '../../src/providers/token-source.ts';
import { createFakeFcmHttp } from '../fixtures/fake-fcm-http.ts';

/** Generates a real RSA keypair and returns its PKCS#8 PEM plus the public key. */
async function generateKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
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
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const base64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    base64.match(/.{1,64}/g)!.join('\n')
  }\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

/** A runtime whose clock the test drives, with real Web Crypto. */
function createClockRuntime(startMs = 1_700_000_000_000): {
  runtime: IRuntimeServices;
  advance(ms: number): void;
} {
  let nowMs = startMs;
  return {
    runtime: {
      now: (): number => nowMs,
      subtle: crypto.subtle,
    } as unknown as IRuntimeServices,
    advance(ms: number): void {
      nowMs += ms;
    },
  };
}

/** Decodes a base64url segment to bytes. */
function fromBase64url(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

describe('ServiceAccountTokenSource', () => {
  it('exchanges a signed assertion for an access token', async () => {
    const { pem } = await generateKeyPair();
    const { runtime } = createClockRuntime();
    const http = createFakeFcmHttp();
    const source = new ServiceAccountTokenSource({
      clientEmail: 'fcm@project.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    expect(await source.getAccessToken()).toBe('test-token');

    const [call] = http.callsMatching('oauth2.googleapis.com');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(call.body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')).toBeTruthy();
  });

  it('signs a verifiable RS256 assertion with the documented claims', async () => {
    // The one test that exercises real signing rather than a fake token source:
    // a fake would let a malformed or unsigned assertion pass unnoticed.
    const { pem, publicKey } = await generateKeyPair();
    const { runtime } = createClockRuntime(1_700_000_000_000);
    const http = createFakeFcmHttp();
    const source = new ServiceAccountTokenSource({
      clientEmail: 'fcm@project.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    await source.getAccessToken();

    const assertion = new URLSearchParams(
      http.callsMatching('oauth2.googleapis.com')[0].body,
    ).get('assertion')!;
    const [headerB64, claimsB64, signatureB64] = assertion.split('.');

    const header = JSON.parse(new TextDecoder().decode(fromBase64url(headerB64)));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(claimsB64)));
    expect(claims.iss).toBe('fcm@project.iam.gserviceaccount.com');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_000 + 3600);

    const verified = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      fromBase64url(signatureB64) as unknown as BufferSource,
      new TextEncoder().encode(`${headerB64}.${claimsB64}`),
    );
    expect(verified).toBe(true);
  });

  it('caches the token across calls instead of re-signing per send', async () => {
    const { pem } = await generateKeyPair();
    const { runtime } = createClockRuntime();
    const http = createFakeFcmHttp();
    const source = new ServiceAccountTokenSource({
      clientEmail: 'a@b.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    await source.getAccessToken();
    await source.getAccessToken();
    await source.getAccessToken();

    expect(http.callsMatching('oauth2.googleapis.com').length).toBe(1);
  });

  it('refreshes early, before the nominal expiry, to absorb clock skew', async () => {
    const { pem } = await generateKeyPair();
    const { runtime, advance } = createClockRuntime();
    const http = createFakeFcmHttp();
    const source = new ServiceAccountTokenSource({
      clientEmail: 'a@b.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    await source.getAccessToken();
    // 3600s token, 60s margin -> still cached at 3539s, refreshed at 3541s.
    advance(3_539_000);
    await source.getAccessToken();
    expect(http.callsMatching('oauth2.googleapis.com').length).toBe(1);

    advance(2_000);
    await source.getAccessToken();
    expect(http.callsMatching('oauth2.googleapis.com').length).toBe(2);
  });

  it('throws when the exchange returns a non-OK response', async () => {
    const { pem } = await generateKeyPair();
    const { runtime } = createClockRuntime();
    const http = createFakeFcmHttp({
      token: { ok: false, status: 401, text: 'invalid_grant' },
    });
    const source = new ServiceAccountTokenSource({
      clientEmail: 'a@b.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    await expect(source.getAccessToken()).rejects.toThrow(
      'FCM token exchange failed (401): invalid_grant',
    );
  });

  it('throws when the exchange body is not JSON', async () => {
    const { pem } = await generateKeyPair();
    const { runtime } = createClockRuntime();
    const http = createFakeFcmHttp({ token: { text: '<html>gateway</html>' } });
    const source = new ServiceAccountTokenSource({
      clientEmail: 'a@b.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    await expect(source.getAccessToken()).rejects.toThrow('non-JSON body');
  });

  it('throws when the exchange body carries no access_token', async () => {
    const { pem } = await generateKeyPair();
    const { runtime } = createClockRuntime();
    const http = createFakeFcmHttp({ token: { text: JSON.stringify({ expires_in: 3600 }) } });
    const source = new ServiceAccountTokenSource({
      clientEmail: 'a@b.iam.gserviceaccount.com',
      privateKey: pem,
      runtime,
      http,
    });

    await expect(source.getAccessToken()).rejects.toThrow('no access_token');
  });

  it('rejects a malformed private key at first use', async () => {
    const { runtime } = createClockRuntime();
    const source = new ServiceAccountTokenSource({
      clientEmail: 'a@b.iam.gserviceaccount.com',
      privateKey: 'not a pem',
      runtime,
      http: createFakeFcmHttp(),
    });

    await expect(source.getAccessToken()).rejects.toThrow('PEM must start with');
  });
});
