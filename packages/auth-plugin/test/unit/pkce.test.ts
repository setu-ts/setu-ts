/**
 * PKCE verifier and S256 challenge.
 *
 * The S256 case is the RFC 7636 Appendix B worked example, so the implementation
 * is checked against the standard's own numbers rather than against itself.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { challengeForVerifier, createPkcePair } from '../../src/sign-in/pkce.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('pkce', () => {
  it('reproduces the RFC 7636 Appendix B S256 vector', async () => {
    const runtime = createFakeRuntime();
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await challengeForVerifier(runtime, verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates a pair whose challenge matches its own verifier', async () => {
    const runtime = createFakeRuntime();
    const pair = await createPkcePair(runtime);
    expect(pair.method).toBe('S256');
    expect(await challengeForVerifier(runtime, pair.verifier)).toBe(pair.challenge);
    // 32 random bytes base64url-encoded without padding: 43 characters, inside
    // RFC 7636 §4.1's 43–128 range and safe to place in a query string.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a fresh pair every call', async () => {
    const runtime = createFakeRuntime();
    const a = await createPkcePair(runtime);
    const b = await createPkcePair(runtime);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
