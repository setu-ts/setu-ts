/**
 * The shared outside-issuer verification core, exercised directly.
 *
 * `JwtVerifier` is the seam between M100b (bearer access tokens) and M100c (ID
 * tokens from the same provider), so its reason codes and its check ORDER are
 * pinned here: a token must never reach claim checks before its signature has
 * verified, and `none`/HMAC must be refused before any key is read.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { JwtVerifier, decodeJsonSegment } from '../../src/issuers/jwt-verifier.ts';
import type { KeySetReader } from '../../src/issuers/jwt-verifier.ts';
import type { Jwk } from '../../src/issuers/key-selection.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { generateTestKey, rawToken, signToken } from '../fixtures/issuer-tokens.ts';
import type { TestKey } from '../fixtures/issuer-tokens.ts';

const NOW = 1_700_000_000_000;

function keySet(keys: readonly Jwk[] | null): KeySetReader & { forces: number } {
  const state = { forces: 0 };
  return {
    get forces() {
      return state.forces;
    },
    keys(force?: boolean) {
      if (force === true) state.forces++;
      return Promise.resolve(keys);
    },
  };
}

function verifier(
  reader: KeySetReader,
  overrides: { audience?: string; clockToleranceSec?: number } = {},
): JwtVerifier {
  return new JwtVerifier({
    keySet: reader,
    runtime: createFakeRuntime(NOW),
    algorithms: new Set(['RS256', 'ES256', 'EdDSA']),
    audience: overrides.audience ?? 'api',
    clockToleranceSec: overrides.clockToleranceSec ?? 30,
  });
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://idp.test',
    aud: 'api',
    sub: 'u1',
    exp: Math.floor(NOW / 1000) + 300,
    ...overrides,
  };
}

async function signed(key: TestKey, payload: Record<string, unknown>): Promise<string> {
  return signToken(key, payload);
}

describe('JwtVerifier', () => {
  it('verifies a well-formed token and returns frozen claims', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const outcome = await verifier(keySet([key.jwk])).verify(await signed(key, claims()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.claims.sub).toBe('u1');
    // The callback hands these to application code, so they arrive immutable.
    expect(Object.isFrozen(outcome.claims)).toBe(true);
  });

  it('refuses a token that is not three segments', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const reader = keySet([key.jwk]);
    expect(await verifier(reader).verify('a.b')).toEqual({
      ok: false,
      reason: 'malformed-token',
    });
    expect(reader.forces).toBe(0);
  });

  it('refuses a malformed header and a non-string kid', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const v = verifier(keySet([key.jwk]));
    expect(await v.verify(`@@.${rawToken({}, claims()).split('.')[1]}.AA`)).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
    expect(await v.verify(rawToken({ alg: 'RS256', kid: 7 }, claims()))).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
  });

  it('refuses crit, then alg none and HS256, before reading any key', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const v = verifier(keySet([key.jwk]));
    expect(await v.verify(rawToken({ alg: 'RS256', crit: ['x'] }, claims()))).toEqual({
      ok: false,
      reason: 'crit-unsupported',
    });
    for (const alg of ['none', 'HS256']) {
      expect(await v.verify(rawToken({ alg, kid: 'k1' }, claims()))).toEqual({
        ok: false,
        reason: 'algorithm-refused',
      });
    }
  });

  it('refuses an algorithm outside the allowlist', async () => {
    // The verifier's allowlist is RS256/ES256/EdDSA; PS256 is not in it here.
    const key = await generateTestKey('RS256', 'k1');
    const token = await signToken(key, claims(), { alg: 'PS256' });
    expect(await verifier(keySet([key.jwk])).verify(token)).toEqual({
      ok: false,
      reason: 'algorithm-not-allowed',
    });
  });

  it('reports no-key-set when the cache holds nothing', async () => {
    const key = await generateTestKey('RS256', 'k1');
    expect(await verifier(keySet(null)).verify(await signed(key, claims()))).toEqual({
      ok: false,
      reason: 'no-key-set',
    });
  });

  it('forces one refresh for an unknown kid and accepts the rotated key', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const rotated = await generateTestKey('RS256', 'k2');
    const reader = keySet([key.jwk]);
    const token = await signed(rotated, claims());
    // The first read misses; the forced read finds the rotated key.
    const first = await new JwtVerifier({
      keySet: {
        keys(force?: boolean) {
          return Promise.resolve(force === true ? [key.jwk, rotated.jwk] : [key.jwk]);
        },
      },
      runtime: createFakeRuntime(NOW),
      algorithms: new Set(['RS256']),
      audience: 'api',
      clockToleranceSec: 0,
    }).verify(token);
    expect(first.ok).toBe(true);
    expect(reader.forces).toBe(0);
  });

  it('reports no-key-set when the forced refresh drops the set', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const outcome = await new JwtVerifier({
      keySet: {
        keys(force?: boolean) {
          return Promise.resolve(force === true ? null : [key.jwk]);
        },
      },
      runtime: createFakeRuntime(NOW),
      algorithms: new Set(['RS256']),
      audience: 'api',
      clockToleranceSec: 0,
    }).verify(rawToken({ alg: 'RS256', kid: 'unknown' }, claims()));
    expect(outcome).toEqual({ ok: false, reason: 'no-key-set' });
  });

  it('refuses an ambiguous kid-less token rather than guessing', async () => {
    const a = await generateTestKey('RS256', 'a');
    const b = await generateTestKey('RS256', 'b');
    const token = await signToken(a, claims(), { kid: undefined });
    expect(await verifier(keySet([a.jwk, b.jwk])).verify(token)).toEqual({
      ok: false,
      reason: 'ambiguous-key',
    });
  });

  it('refuses a malformed and a bad signature', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const token = await signed(key, claims());
    const v = verifier(keySet([key.jwk]));
    expect(await v.verify(`${token.slice(0, token.lastIndexOf('.'))}.!!!`)).toEqual({
      ok: false,
      reason: 'malformed-signature',
    });
    expect(await v.verify(`${token.slice(0, token.lastIndexOf('.'))}.AAAA`)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a payload that is not a JSON object', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const head = rawToken({ alg: 'RS256', kid: 'k1' }, { x: 1 }).split('.')[0];
    // A JSON array is valid base64url JSON but not an object. Named reason, and
    // reachable without a valid signature because the payload is decoded up front.
    const arrayPayload = btoa(JSON.stringify([1, 2])).replace(/\+/g, '-').replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifier(keySet([key.jwk])).verify(`${head}.${arrayPayload}.AA`)).toEqual({
      ok: false,
      reason: 'malformed-payload',
    });
  });

  it('checks the audience, accepting one of several', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const multi = await signed(key, claims({ aud: ['other', 'api'] }));
    expect((await verifier(keySet([key.jwk])).verify(multi)).ok).toBe(true);
    const wrong = await signed(key, claims({ aud: 'other' }));
    expect(await verifier(keySet([key.jwk])).verify(wrong)).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
  });

  it('requires exp, and honours the clock tolerance for exp/nbf/iat', async () => {
    const key = await generateTestKey('RS256', 'k1');
    const nowSec = Math.floor(NOW / 1000);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ exp: undefined }, 'exp-missing'],
      [{ exp: '300' }, 'exp-missing'],
      [{ exp: nowSec - 31 }, 'expired'],
      [{ exp: nowSec - 10, nbf: nowSec + 31 }, 'not-yet-valid'],
      [{ exp: nowSec + 300, iat: nowSec + 31 }, 'issued-in-future'],
    ];
    for (const [override, reason] of cases) {
      const payload = { ...claims(), ...override };
      const token = await signed(key, payload);
      expect(await verifier(keySet([key.jwk])).verify(token)).toEqual({ ok: false, reason });
    }
    // Inside the tolerance, the same claims pass.
    const inside = await signed(key, claims({ exp: nowSec - 10 }));
    expect((await verifier(keySet([key.jwk])).verify(inside)).ok).toBe(true);
  });

  it('decodeJsonSegment returns null for anything that is not a JSON object', () => {
    expect(decodeJsonSegment('!!!')).toBeNull();
    expect(decodeJsonSegment(btoa('7').replace(/=+$/, ''))).toBeNull();
    expect(decodeJsonSegment(btoa(JSON.stringify({ a: 1 })).replace(/=+$/, ''))).toEqual({ a: 1 });
  });
});
