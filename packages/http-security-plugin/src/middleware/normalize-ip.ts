/**
 * One canonical form for every address IP security publishes or compares.
 *
 * Before M119d the socket peer was unmapped while a forwarded hop was not, so
 * one client could hold two identities (V10-28). Normalizing on publish and on
 * compare means a trusted literal and a forwarded hop can never disagree on form.
 *
 * @module
 */

/**
 * An IPv4-mapped IPv6 address as `new URL` canonicalizes it: the embedded
 * IPv4 address is always rendered as two hexadecimal groups, whether the input
 * was written `::ffff:192.0.2.1`, `::ffff:c000:201` or `0:0:0:0:0:ffff:c000:201`.
 */
const CANONICAL_MAPPED_IPV4 = /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/;

/** The characters an IPv6 literal (including an embedded dotted quad) may contain. */
const IPV6_CHARS = /^[0-9A-Fa-f:.]{2,45}$/;

const IPV4_PART = /^(0|[1-9][0-9]{0,2})$/;
const PORT = /^[0-9]{1,5}$/;

/**
 * Validates a port-free IP literal using the same spellings for both header families.
 * @param address - An IPv4 or unbracketed IPv6 address without a port
 * @returns The normalized address, or `null` when invalid
 * @internal
 */
export function parseIpLiteral(address: string): string | null {
  if (address.includes(':')) {
    if (!IPV6_CHARS.test(address)) return null;
    try {
      new URL(`http://[${address}]`);
    } catch {
      return null;
    }
  } else {
    const parts = address.split('.');
    if (parts.length !== 4 || !parts.every((part) => IPV4_PART.test(part) && Number(part) <= 255)) {
      return null;
    }
  }
  return normalizeIp(address);
}

/**
 * Validates one forwarded address, stripping an optional numeric port.
 * @param entry - An IPv4 or IPv6 entry; IPv6 ports require brackets
 * @returns The normalized address without a port, or `null` when invalid
 * @internal
 */
export function parseClientAddress(entry: string): string | null {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close === -1) return null;
    const address = entry.slice(1, close);
    const suffix = entry.slice(close + 1);
    if (!address.includes(':')) return null;
    if (suffix !== '' && (!suffix.startsWith(':') || !isPort(suffix.slice(1)))) return null;
    return parseIpLiteral(address);
  }
  const colon = entry.indexOf(':');
  if (colon !== -1 && colon === entry.lastIndexOf(':')) {
    if (!isPort(entry.slice(colon + 1))) return null;
    return parseIpLiteral(entry.slice(0, colon));
  }
  return parseIpLiteral(entry);
}

/** Ports use ASCII decimal only, including zero, and fit an unsigned 16-bit value. */
function isPort(value: string): boolean {
  return PORT.test(value) && Number(value) <= 65535;
}

/**
 * Normalizes an address to the form IP security publishes and compares.
 *
 * 1. Any value containing `:` and only IPv6 characters is parsed as a bracketed
 *    IPv6 URL host, giving the canonical lowercase compressed form
 *    (`2001:DB8:0:0::1` → `2001:db8::1`).
 * 2. When that canonical form is IPv4-mapped (`::ffff:<hex>:<hex>`), it becomes
 *    the dotted IPv4 address, as the runtime adapters already emit for a mapped
 *    socket peer. Every spelling of one mapped address — dotted tail
 *    (`::ffff:192.0.2.1`), hexadecimal tail (`::ffff:c000:201`) or uncompressed
 *    — therefore yields one identity, `192.0.2.1`.
 * 3. Everything else — a dotted quad, a zone id such as `fe80::1%eth0`, an
 *    invalid literal such as `::ffff:999.1.1.1`, or garbage — is returned
 *    unchanged.
 *
 * @param value - An address as written by a runtime or a proxy
 * @returns The canonical form, or the input unchanged when it is not an address
 * @internal
 */
export function normalizeIp(value: string): string {
  // Only IPv6 characters reach the URL parser: an attacker-written entry such as
  // `::1]@host/[x` must stay as written, never be rewritten into another value.
  if (!value.includes(':') || !IPV6_CHARS.test(value)) return value;
  let canonical: string;
  try {
    // With only IPv6 characters inside the brackets the parser either throws or
    // returns a bracketed IPv6 host, so stripping the brackets is always safe.
    canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  } catch {
    // A zone id or a non-address stays exactly as written.
    return value;
  }
  if (!CANONICAL_MAPPED_IPV4.test(canonical)) return canonical;
  let address = 0;
  for (const group of canonical.slice('::ffff:'.length).split(':')) {
    address = address * 0x10000 + Number.parseInt(group, 16);
  }
  return [address >>> 24, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff].join(
    '.',
  );
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
