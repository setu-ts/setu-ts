/**
 * The memory SAML request store and the browser-binding cookie (M100f plan
 * §3.4–§3.5).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MemorySamlRequestStore } from '../../src/stores/saml-request-store.ts';
import type { SamlPendingRequest } from '../../src/stores/saml-request-store.ts';
import {
  bindingMatches,
  clearBindingCookie,
  readBindingCookie,
  SAML_BINDING_COOKIE,
  setBindingCookie,
} from '../../src/saml/binding-cookie.ts';
import type { IRequestContext } from '@setu-ts/common';

const request = (id: string, expiresAt = 1_000): SamlPendingRequest => ({
  requestId: id,
  provider: 'corp',
  returnTo: '/',
  binding: 'b',
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt,
});

describe('MemorySamlRequestStore', () => {
  it('peeks without consuming, then consumes once', async () => {
    const store = new MemorySamlRequestStore();
    await store.saveRequest(request('r1'), 0);
    expect(await store.peekRequest('r1', 10)).toEqual(request('r1'));
    expect(await store.peekRequest('r1', 10)).not.toBeNull();
    expect(await store.consumeRequest('r1', 10)).toEqual(request('r1'));
    expect(await store.consumeRequest('r1', 10)).toBeNull();
    expect(await store.peekRequest('r1', 10)).toBeNull();
  });

  it('gives exactly one of two concurrent consumers the record', async () => {
    const store = new MemorySamlRequestStore();
    await store.saveRequest(request('r1'), 0);
    const results = await Promise.all([
      store.consumeRequest('r1', 10),
      store.consumeRequest('r1', 10),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('treats an expired request as absent and sweeps it on the next save', async () => {
    const store = new MemorySamlRequestStore();
    await store.saveRequest(request('old', 100), 0);
    expect(await store.peekRequest('old', 100)).toBeNull();
    await store.saveRequest(request('new', 900), 200);
    // Swept: even a consumer passing an earlier clock no longer finds it.
    expect(await store.consumeRequest('old', 0)).toBeNull();
    expect(await store.consumeRequest('new', 300)).not.toBeNull();
  });

  it('refuses an expired request at consumption', async () => {
    const store = new MemorySamlRequestStore();
    await store.saveRequest(request('r1', 100), 0);
    expect(await store.consumeRequest('r1', 100)).toBeNull();
  });

  it('claims an assertion id once until it ages out', async () => {
    const store = new MemorySamlRequestStore();
    expect(await store.claimAssertionId('a1', 100, 0)).toBe(true);
    expect(await store.claimAssertionId('a1', 100, 50)).toBe(false);
    // Aged out: swept, and claimable again.
    expect(await store.claimAssertionId('a1', 300, 100)).toBe(true);
    expect(await store.claimAssertionId('a2', 300, 100)).toBe(true);
  });
});

function fakeContext(cookie?: string): IRequestContext & { setCookies: string[] } {
  const setCookies: string[] = [];
  const headers = new Headers(cookie === undefined ? {} : { cookie });
  const ctx = {
    request: { headers },
    response: {
      appendHeader: (name: string, value: string) => {
        if (name === 'Set-Cookie') {
          setCookies.push(value);
        }
        return ctx.response;
      },
    },
    setCookies,
  };
  return ctx as unknown as IRequestContext & { setCookies: string[] };
}

describe('binding cookie', () => {
  it('sets __Host-setu-saml with exact attributes', () => {
    const ctx = fakeContext();
    setBindingCookie(ctx, 'abc');
    expect(ctx.setCookies).toEqual([
      `${SAML_BINDING_COOKIE}=abc; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None`,
    ]);
  });

  it('clears it with the same attributes and Max-Age=0', () => {
    const ctx = fakeContext();
    clearBindingCookie(ctx);
    expect(ctx.setCookies).toEqual([
      `${SAML_BINDING_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`,
    ]);
  });

  it('reads the value, or null when absent or empty', () => {
    expect(readBindingCookie(fakeContext(`a=1; ${SAML_BINDING_COOKIE}=xyz`))).toBe('xyz');
    expect(readBindingCookie(fakeContext('a=1'))).toBeNull();
    expect(readBindingCookie(fakeContext(`${SAML_BINDING_COOKIE}=`))).toBeNull();
    expect(readBindingCookie(fakeContext())).toBeNull();
  });

  it('compares values exactly', () => {
    expect(bindingMatches('abc', 'abc')).toBe(true);
    expect(bindingMatches('abc', 'abd')).toBe(false);
    expect(bindingMatches('abc', 'abcd')).toBe(false);
  });
});
