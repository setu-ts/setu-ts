/**
 * Refuses a backend URL that carries credentials, before any request is
 * built (V12-52).
 *
 * `fetch` refuses every URL with userinfo, and its error quotes the whole URL
 * (`Request cannot be constructed from a URL that includes credentials:
 * http://user:<password>@host/...`). So such an address never reaches the
 * backend, and the password travels in the start error and in a resolve
 * error's `cause`. Each provider that builds request URLs from a configured
 * base checks it here, with a fixed message that never holds the URL.
 *
 * @module
 */
import { DiscoveryUnavailableError } from '../errors.ts';

/**
 * Returns the URL unchanged when it carries no userinfo.
 *
 * A value that does not parse as a URL is returned unchanged too: this check
 * is about credentials, and the request path reports an unparsable address.
 *
 * @param url - The configured backend base URL
 * @param refusal - The fixed message to throw; it must not contain the URL
 * @returns The URL
 * @throws {DiscoveryUnavailableError} When the URL has a username or password
 */
export function credentialFreeUrl(url: string, refusal: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new DiscoveryUnavailableError(refusal);
  }
  return url;
}
