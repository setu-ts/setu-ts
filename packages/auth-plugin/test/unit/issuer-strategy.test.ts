import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal } from '@setu-ts/common';
import { encodeBase64Url } from '../../src/utils/base64url.ts';
import { generateTestKey, rawToken, signToken } from '../fixtures/issuer-tokens.ts';
import { request, setupStrategy, valid } from '../fixtures/issuer-strategy-setup.ts';

describe('IssuerStrategy routing', () => {
  it('authenticates a token from the configured issuer', async () => {
    const t = await setupStrategy();
    const token = await signToken(t.key, valid());
    const principal = await t.strategy.authenticate(request(`Bearer ${token}`));
    expect(principal).toEqual({ id: 'u1' } satisfies IPrincipal);
    expect(t.strategy.name).toBe('issuers');
  });

  it('continues the chain for an unknown issuer without fetching', async () => {
    const t = await setupStrategy();
    const token = await signToken(t.key, valid({ iss: 'https://other.test' }));
    expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toBeNull();
    expect(t.calls).toEqual([]);
    expect(t.refusals).toEqual([]);
  });

  it('returns null for absent, wrong-scheme and malformed tokens', async () => {
    const t = await setupStrategy();
    for (
      const value of [
        undefined,
        '',
        'Basic abc',
        'Bearer',
        'Bearer a b',
        'Bearer a.b',
        'Bearer a.b.c',
        `Bearer x.${encodeBase64Url(new TextEncoder().encode('[1]'))}.c`,
        `Bearer x.${encodeBase64Url(new TextEncoder().encode('{"iss":7}'))}.c`,
      ]
    ) {
      expect(await t.strategy.authenticate(request(value))).toBeNull();
    }
    expect(t.calls).toEqual([]);
  });

  it('reads a custom header and scheme', async () => {
    const t = await setupStrategy({ header: 'x-token', scheme: 'Token' });
    const token = await signToken(t.key, valid());
    expect(await t.strategy.authenticate(request(`token ${token}`, 'x-token'))).toEqual({
      id: 'u1',
    });
    expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toBeNull();
  });
});

describe('IssuerStrategy refusals', () => {
  async function refusal(
    token: (t: Awaited<ReturnType<typeof setupStrategy>>) => Promise<string> | string,
    options: Parameters<typeof setupStrategy>[0] = {},
  ): Promise<string[]> {
    const t = await setupStrategy(options);
    expect(await t.strategy.authenticate(request(`Bearer ${await token(t)}`))).toBeNull();
    return t.refusals;
  }

  it('refuses a Keycloak ID token (typ ID) presented as a bearer (M100c F7)', async () => {
    expect(await refusal((t) => signToken(t.key, valid({ typ: 'ID' })))).toEqual([
      'id-token-as-bearer',
    ]);
    // The control: the same token typed as an access token authenticates.
    const t = await setupStrategy();
    const token = await signToken(t.key, valid({ typ: 'Bearer' }));
    expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toEqual({ id: 'u1' });
  });

  it('refuses alg none and HS256 before any key is fetched', async () => {
    const t = await setupStrategy();
    for (const alg of ['none', 'HS256']) {
      const token = rawToken({ alg, kid: 'k1' }, valid());
      expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toBeNull();
    }
    expect(t.refusals).toEqual(['algorithm-refused', 'algorithm-refused']);
    expect(t.calls).toEqual([]);
  });

  it('refuses an HS256 token signed with the public key bytes (algorithm confusion)', async () => {
    const t = await setupStrategy();
    const secret = new TextEncoder().encode(JSON.stringify(t.key.jwk));
    const hmac = await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const head = encodeBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: 'HS256', kid: 'k1' })),
    );
    const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(valid())));
    const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${head}.${body}`));
    const token = `${head}.${body}.${encodeBase64Url(new Uint8Array(sig))}`;
    expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toBeNull();
    expect(t.refusals).toEqual(['algorithm-refused']);
  });

  it('refuses an algorithm outside the allowlist', async () => {
    expect(
      await refusal((t) => signToken(t.key, valid()), { issuer: { algorithms: ['ES256'] } }),
    ).toEqual(['algorithm-not-allowed']);
  });

  it('refuses malformed headers and crit', async () => {
    expect(await refusal(() => `@@.${rawToken({}, valid()).split('.')[1]}.AA`)).toEqual([
      'malformed-header',
    ]);
    expect(await refusal(() => rawToken({ alg: 'RS256', kid: 7 }, valid()))).toEqual([
      'malformed-header',
    ]);
    expect(await refusal(() => rawToken({ alg: 'RS256', crit: ['x'] }, valid()))).toEqual([
      'crit-unsupported',
    ]);
  });

  it('refuses when no key set could be fetched', async () => {
    expect(
      await refusal((t) => signToken(t.key, valid()), { jwks: () => ({ status: 500, body: '' }) }),
    ).toEqual(['no-key-set']);
  });

  it('refetches once for an unknown kid and picks up a rotated key', async () => {
    const t = await setupStrategy();
    await t.strategy.authenticate(request(`Bearer ${await signToken(t.key, valid())}`));
    const rotated = await generateTestKey('RS256', 'k2');
    t.setJwks(() => ({ body: { keys: [t.key.jwk, rotated.jwk] } }));
    t.runtime.setHrtime(60_000);
    const token = await signToken(rotated, valid({ sub: 'u2' }));
    expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toEqual({ id: 'u2' });
    expect(t.calls.length).toBe(2);
  });

  it('refuses a forged kid and does not refetch inside the cooldown', async () => {
    const t = await setupStrategy();
    await t.strategy.authenticate(request(`Bearer ${await signToken(t.key, valid())}`));
    for (let i = 0; i < 10; i++) {
      const token = rawToken({ alg: 'RS256', kid: `forged-${i}` }, valid());
      expect(await t.strategy.authenticate(request(`Bearer ${token}`))).toBeNull();
    }
    expect(t.calls.length).toBe(1);
    expect(new Set(t.refusals)).toEqual(new Set(['no-matching-key']));
  });

  it('reports no-key-set when a forced refresh drops an expired set', async () => {
    const t = await setupStrategy({ issuer: { keySet: { ttlMs: 60_000, maxStaleMs: 100_000 } } });
    await t.strategy.authenticate(request(`Bearer ${await signToken(t.key, valid())}`));
    t.setJwks(() => ({ status: 500, body: '' }));
    t.runtime.setHrtime(100_000);
    const token = rawToken({ alg: 'RS256', kid: 'unknown' }, valid());
    await t.strategy.authenticate(request(`Bearer ${token}`));
    t.runtime.setHrtime(100_001);
    await t.strategy.authenticate(request(`Bearer ${token}`));
    expect(t.refusals).toEqual(['no-matching-key', 'no-key-set']);
  });

  it('refuses an ambiguous kid-less token', async () => {
    const a = await generateTestKey('RS256', 'a');
    const b = await generateTestKey('RS256', 'b');
    expect(
      await refusal(() => signToken(a, valid(), { kid: undefined }), { keys: [a, b] }),
    ).toEqual(['ambiguous-key']);
  });

  it('refuses a bad signature and a malformed signature segment', async () => {
    expect(
      await refusal(async (t) => {
        const token = await signToken(t.key, valid());
        return `${token.slice(0, token.lastIndexOf('.'))}.AAAA`;
      }),
    ).toEqual(['bad-signature']);
    expect(
      await refusal(async (t) => {
        const token = await signToken(t.key, valid());
        return `${token.slice(0, token.lastIndexOf('.'))}.!!!`;
      }),
    ).toEqual(['malformed-signature']);
  });

  it('reports a throwing toPrincipal and a null mapping', async () => {
    expect(
      await refusal((t) => signToken(t.key, valid()), {
        issuer: {
          toPrincipal: () => {
            throw new Error('boom');
          },
        },
      }),
    ).toEqual(['verification-error']);
    const t = await setupStrategy({ issuer: { toPrincipal: () => null } });
    expect(await t.strategy.authenticate(request(`Bearer ${await signToken(t.key, valid())}`)))
      .toBeNull();
  });

  it('hands toPrincipal a frozen copy of the full claims', async () => {
    let seen: Readonly<Record<string, unknown>> | undefined;
    const t = await setupStrategy({
      issuer: {
        toPrincipal: (claims) => {
          seen = claims;
          return { id: 'x' };
        },
      },
    });
    await t.strategy.authenticate(
      request(`Bearer ${await signToken(t.key, valid({ roles: ['a'] }))}`),
    );
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen?.roles).toEqual(['a']);
  });
});
