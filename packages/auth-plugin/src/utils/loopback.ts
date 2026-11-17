/** Loopback rules for browser names, server fetches and passkeys. @module */

/**
 * Recognizes loopback names a browser treats as trustworthy.
 * @param hostname - Lowercased URL hostname
 * @returns Whether it is localhost, a localhost subdomain or a loopback address
 * @since 0.13.0
 */
export function isLoopbackName(hostname: string): boolean {
  return isLoopbackAddress(hostname) || hostname.endsWith('.localhost');
}

/**
 * Recognizes hosts a server may fetch without relying on wildcard DNS.
 * @param hostname - Lowercased URL hostname
 * @returns Whether it is localhost or an exact loopback address
 * @since 0.13.0
 */
export function isLoopbackAddress(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Recognizes loopback names usable for passkeys; an RP ID cannot contain a colon.
 * @param hostname - Lowercased URL hostname
 * @returns Whether it is a loopback name other than the IPv6 literal
 * @since 0.13.0
 */
export function isPasskeyLoopbackName(hostname: string): boolean {
  return hostname !== '[::1]' && isLoopbackName(hostname);
}
