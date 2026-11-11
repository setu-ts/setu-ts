/**
 * Refuses a credential that an HTTP header cannot carry, before any request
 * is built (M139f audit M1, N1).
 *
 * `fetch` refuses a header value with a control character by quoting the
 * whole value in its error (`Headers.append: "<value>" is an invalid header
 * value`). That error reaches the readiness log and the cold-resolve message,
 * so the credential would travel with it. Every provider that writes a token
 * into a header checks it here instead, with a message that never holds it.
 *
 * @module
 */
import { DiscoveryUnavailableError } from '../errors.ts';

/** Visible ASCII: every JWT, Kubernetes token and Consul ACL token. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]*$/;

/**
 * Returns the token unchanged when a header can carry it.
 *
 * @param token - The configured or projected credential
 * @param refusal - The fixed message to throw; it must not contain the token
 * @returns The token
 * @throws {DiscoveryUnavailableError} When the token holds a character outside
 *   visible ASCII
 */
export function headerSafeToken(token: string, refusal: string): string {
  if (!TOKEN_CHARACTERS.test(token)) {
    throw new DiscoveryUnavailableError(refusal);
  }
  return token;
}
