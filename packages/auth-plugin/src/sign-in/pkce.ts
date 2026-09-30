/**
 * PKCE (RFC 7636) verifier and S256 challenge for the authorization-code flow.
 * Internal: built by the sign-in login route.
 *
 * S256 is sent for EVERY provider, including confidential clients. PKCE is not
 * only a public-client mechanism: it binds an authorization code to the one
 * exchange that requested it, so a code intercepted on the front channel cannot
 * be redeemed elsewhere. A provider that advertises only `plain` is refused at
 * configuration time rather than silently downgraded.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { encodeBase64Url } from '../utils/base64url.ts';
import { toBuffer } from '../utils/buffer.ts';

/** Verifier entropy in bytes (RFC 7636 §4.1 allows 43–128 base64url characters). */
const VERIFIER_BYTES = 32;

/**
 * A PKCE pair for one authorization request.
 *
 * The verifier is kept by the plugin (in the pending session entry) and the
 * challenge is what the provider sees, so capturing the challenge does not let
 * an attacker redeem a code.
 */
export interface PkcePair {
  /** The secret sent to the token endpoint. */
  readonly verifier: string;
  /** The `code_challenge` sent to the authorization endpoint. */
  readonly challenge: string;
  /** Always `S256`; `plain` is never produced. */
  readonly method: 'S256';
}

/**
 * Computes the S256 challenge for a verifier: `BASE64URL(SHA256(verifier))`.
 *
 * @param runtime - Runtime services, for `subtle`
 * @param verifier - The verifier, ASCII
 * @returns The challenge
 */
export async function challengeForVerifier(
  runtime: IRuntimeServices,
  verifier: string,
): Promise<string> {
  const digest = await runtime.subtle.digest('SHA-256', toBuffer(new TextEncoder().encode(verifier)));
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * Creates a fresh PKCE pair: 32 random bytes for the verifier, S256 challenge.
 *
 * @param runtime - Runtime services, for `randomBytes` and `subtle`
 * @returns The pair for one authorization request
 */
export async function createPkcePair(runtime: IRuntimeServices): Promise<PkcePair> {
  const verifier = encodeBase64Url(runtime.randomBytes(VERIFIER_BYTES));
  const challenge = await challengeForVerifier(runtime, verifier);
  return { verifier, challenge, method: 'S256' };
}
