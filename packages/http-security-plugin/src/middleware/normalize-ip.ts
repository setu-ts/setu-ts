/**
 * One canonical form for every address IP security publishes or compares.
 *
 * Before M119d the socket peer was unmapped while a forwarded hop was not, so
 * one client could hold two identities (V10-28). Normalizing on publish and on
 * compare means a trusted literal and a forwarded hop can never disagree on form.
 *
 * @module
 */

/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`). */
const MAPPED_IPV4 = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/i;

/** The characters an IPv6 literal (including an embedded dotted quad) may contain. */
const IPV6_CHARS = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Normalizes an address to the form IP security publishes and compares.
 *
 * 1. `::ffff:a.b.c.d` with a valid dotted quad becomes `a.b.c.d`, as the runtime
 *    adapters already emit for a mapped socket peer.
 * 2. Any other value containing `:` is parsed as a bracketed IPv6 URL host and
 *    returned in canonical lowercase compressed form (`2001:DB8:0:0::1` →
 *    `2001:db8::1`).
 * 3. Everything else — a dotted quad, a zone id such as `fe80::1%eth0`, or
 *    garbage — is returned unchanged.
 *
 * Rule 1 must run before rule 2: `new URL` renders `::ffff:1.2.3.4` as
 * `::ffff:102:304`, which is no longer the mapped form.
 *
 * @param value - An address as written by a runtime or a proxy
 * @returns The canonical form, or the input unchanged when it is not an address
 * @internal
 */
export function normalizeIp(value: string): string {
  const match = MAPPED_IPV4.exec(value);
  const address = match?.[1];
  if (address !== undefined && ipv4ToNumber(address) !== null) return address;
  // Only IPv6 characters reach the URL parser: an attacker-written entry such as
  // `::1]@host/[x` must stay as written, never be rewritten into another value.
  if (value.includes(':') && IPV6_CHARS.test(value)) {
    try {
      const hostname = new URL(`http://[${value}]`).hostname;
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        return hostname.slice(1, -1);
      }
    } catch {
      // A zone id or a non-address stays exactly as written.
    }
  }
  return value;
}

/** Converts a dotted-quad IPv4 literal to its numeric value, or `null`. */
export function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    // `Number('')` is 0 and `Number(' 1')` is 1, so the digits are checked
    // explicitly rather than inferred from the conversion.
    if (part.length === 0 || part.length > 3 || !/^[0-9]+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}
