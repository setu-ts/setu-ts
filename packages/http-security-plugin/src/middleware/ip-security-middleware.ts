/**
 * IP security middleware factory.
 *
 * Resolves the client IP address and publishes it to
 * `ctx.state.set(CLIENT_IP_STATE_KEY, ip)`. Does not short-circuit.
 *
 * **`trustProxy` is the only working source since M23.** The web-standard
 * `fetch` mapping the HTTP adapters use cannot populate `IRequest.ip` — a web
 * `Request` carries no peer address — so the `request.ip` fallback below is
 * vestigial and `clientIp` is `undefined` unless `trustProxy` is on and the
 * configured header is present. The fallback is retained for a custom adapter
 * that does set `IRequest.ip`.
 *
 * @module
 */
import { CLIENT_IP_STATE_KEY } from '@setu-ts/common';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';

/** Options for IP security middleware. */
export interface IpSecurityOptions {
  /** Enable/disable IP resolution. Defaults to `true` when present. */
  readonly enabled?: boolean;
  /**
   * When `true`, read the client IP from the proxy header instead of
   * `request.ip`. Requires a trusted reverse proxy. Default: `false`.
   *
   * WARNING: on its own this trusts the header's LEFTMOST entry, which is safe
   * only behind a proxy that OVERWRITES the header. The standard nginx idiom
   * appends instead, in which case the leftmost entry is whatever the client
   * sent — set {@linkcode IpSecurityOptions.trustedProxies} or
   * {@linkcode IpSecurityOptions.proxyHops} so the client is resolved from the
   * right. Note that with `false`, `clientIp` is `undefined` on all
   * first-party adapters (see the module note).
   */
  readonly trustProxy?: boolean;
  /**
   * The header name to read when `trustProxy` is `true`. Default: `X-Forwarded-For`.
   *
   * With neither {@linkcode IpSecurityOptions.trustedProxies} nor
   * {@linkcode IpSecurityOptions.proxyHops} supplied, the LEFTMOST address is
   * taken — which is the entry a client controls under an appending proxy (see
   * those two options).
   */
  readonly ipHeader?: string;
  /**
   * Addresses of the proxies in front of this application, as literal
   * addresses or CIDR blocks. When supplied, the header is walked RIGHT to
   * LEFT and the first entry that is not one of these is the client.
   *
   * This is the standard algorithm, and what Express `trust proxy` and Fastify
   * `trustProxy` offer. It matters because the common nginx idiom
   * (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) APPENDS the
   * peer address rather than overwriting the header — so with a request sent as
   * `X-Forwarded-For: 7.7.7.7` the proxy forwards
   * `7.7.7.7, 198.51.100.9`, and the leftmost default resolves the value the
   * caller chose. Rate limits and IP allowlists keyed on that are keyed on
   * attacker input.
   *
   * Mutually exclusive with {@linkcode IpSecurityOptions.proxyHops}; supplying
   * both throws at middleware construction. Omitted, resolution stays leftmost,
   * unchanged from before 0.5.0.
   *
   * @since 0.5.0
   */
  readonly trustedProxies?: readonly string[];
  /**
   * The number of proxies in front of this application, when they cannot be
   * addressed by IP (a managed load balancer on a rotating address). The nth
   * entry FROM THE RIGHT is the client: `1` skips the immediate peer's
   * contribution, `2` skips two, and so on.
   *
   * A header carrying fewer entries than `proxyHops` resolves to `undefined`
   * rather than to whatever entry happens to be leftmost — a short header means
   * the request did not traverse the expected chain, and guessing would
   * reintroduce the spoof this option exists to close.
   *
   * `0` is the rightmost entry (no hop skipped). A value that is not a
   * non-negative integer **throws at middleware construction** rather than
   * silently resolving `undefined` on every request, which is what a negative,
   * a fraction, or the `NaN` that `Number()` yields for an unset environment
   * variable would otherwise do.
   *
   * Mutually exclusive with {@linkcode IpSecurityOptions.trustedProxies}.
   *
   * @since 0.5.0
   */
  readonly proxyHops?: number;
}

/**
 * Splits a proxy header into its non-empty, trimmed entries, in wire order
 * (leftmost first).
 */
function parseForwardedChain(headerValue: string): readonly string[] {
  const entries: string[] = [];
  for (const raw of headerValue.split(',')) {
    const entry = raw.trim();
    if (entry !== '') {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Parses a literal address or CIDR block into a matcher.
 *
 * Only IPv4 CIDR is expanded numerically; every other form (a bare address, an
 * IPv6 literal, an IPv6 CIDR) is compared as a case-insensitive string. That is
 * a deliberate floor rather than an oversight: a wrong CIDR expansion would
 * silently TRUST an untrusted hop, which is worse than requiring the operator to
 * list IPv6 proxies individually.
 */
function compileTrustedProxy(entry: string): (candidate: string) => boolean {
  const slash = entry.indexOf('/');
  if (slash !== -1) {
    const network = entry.slice(0, slash);
    const width = entry.slice(slash + 1);
    // The digits are checked explicitly rather than inferred from `Number`,
    // for the same reason `ipv4ToNumber` checks octets that way — and here it
    // is a security requirement rather than tidiness. `Number('')` is `0`, so
    // a trailing-slash entry (`'10.0.0.1/'`) would otherwise compile to a `/0`
    // matcher that TRUSTS EVERY IPv4 address: an all-IPv4 chain then resolves
    // no client at all, and a chain whose leftmost entry is IPv6 returns that
    // caller-supplied value as the client — X32-3 reintroduced by a typo in
    // configuration. `Number` also accepts `'0x20'` as 32, which silently
    // applies a mask the text does not say. An unparseable width falls through
    // to the literal comparison below, which is what this function's own
    // contract promises and which trusts nothing.
    // A width that is not plain digits is refused outright rather than falling
    // through: EVERY legitimate CIDR width is plain digits, in either family, so
    // this can reject no valid entry — while silently falling through would trust
    // nothing and degrade an IP-keyed limiter to one shared bucket with no
    // signal. The range is deliberately NOT checked here: an IPv6 CIDR such as
    // `2001:db8::/64` has a digit width above 32 and must keep its documented
    // literal-comparison path.
    if (!/^[0-9]+$/.test(width)) {
      throw new Error(
        `ipSecurityMiddleware: trustedProxies entry '${entry}' has a malformed ` +
          `CIDR width. Use plain digits (e.g. '10.0.0.0/8'), or omit the slash ` +
          `to compare the entry literally.`,
      );
    }
    const bits = width.length <= 2 ? Number(width) : Number.NaN;
    const networkValue = ipv4ToNumber(network);
    if (
      networkValue !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32
    ) {
      // `>>> 0` keeps the mask unsigned; a /0 shift of 32 is undefined in JS,
      // so it is handled as "match everything".
      const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
      const base = (networkValue & mask) >>> 0;
      return (candidate: string): boolean => {
        const value = ipv4ToNumber(candidate);
        return value !== null && ((value & mask) >>> 0) === base;
      };
    }
  }
  const literal = entry.toLowerCase();
  return (candidate: string): boolean => candidate.toLowerCase() === literal;
}

/** Converts a dotted-quad IPv4 literal to its numeric value, or `null`. */
function ipv4ToNumber(address: string): number | null {
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

/**
 * IP security middleware factory.
 *
 * @param options - IP security configuration
 * @returns A middleware function that resolves and publishes the client IP
 */
export function ipSecurityMiddleware(options: IpSecurityOptions = {}): MiddlewareFunction {
  const enabled = options.enabled ?? true;

  if (!enabled) {
    return (_ctx, next) => next();
  }

  const trustProxy = options.trustProxy ?? false;
  const ipHeader = options.ipHeader ?? 'X-Forwarded-For';
  const trustedProxies = options.trustedProxies;
  const proxyHops = options.proxyHops;

  if (trustedProxies !== undefined && proxyHops !== undefined) {
    throw new Error(
      'ipSecurityMiddleware: `trustedProxies` and `proxyHops` are mutually ' +
        'exclusive — they are two different answers to the same question ' +
        '(which entry in the forwarded chain is the client). Supply one.',
    );
  }

  // Refused here rather than per request: an out-of-domain hop count resolves
  // `undefined` for every caller, which degrades the rate limiter to one shared
  // `'anonymous'` bucket with no signal anywhere. `Number()` of an unset
  // environment variable is `NaN`, so this is a plausible input rather than a
  // hypothetical one.
  if (
    proxyHops !== undefined &&
    (!Number.isSafeInteger(proxyHops) || proxyHops < 0)
  ) {
    throw new Error(
      `ipSecurityMiddleware: proxyHops must be a non-negative integer, ` +
        `received ${String(proxyHops)}. 0 selects the rightmost entry.`,
    );
  }

  // Compiled once at registration, never per request.
  const trustedMatchers = trustedProxies?.map(compileTrustedProxy);

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void> => {
    let ip: string | undefined;

    if (trustProxy) {
      const headerValue = ctx.request.headers.get(ipHeader);
      if (headerValue) {
        ip = resolveForwardedIp(headerValue, trustedMatchers, proxyHops);
      }
    }

    // Fallback to request.ip when trustProxy is false or the header is absent
    // or empty. The first-party adapters never set it (see the module note), so
    // this resolves to `undefined` there.
    if (!ip) {
      ip = ctx.request.ip;
    }

    // Publish the resolved IP to state (even if undefined)
    ctx.state.set(CLIENT_IP_STATE_KEY, ip);

    // Never short-circuit
    await next();
  };
}

/**
 * Picks the client address out of a proxy header.
 *
 * Three modes, in the order the options declare them:
 *
 * - `trustedMatchers` — walk right to left and return the first entry that is
 *   not a trusted proxy. Every entry to the right of it was added by
 *   infrastructure this deployment controls; the one returned is the furthest
 *   address that could not have been forged past a trusted hop.
 * - `proxyHops` — return the nth entry from the right. Used when the proxies
 *   cannot be addressed by IP. A header too short for the declared chain
 *   resolves to `undefined`.
 * - neither — return the leftmost entry, the released behaviour.
 *
 * @param headerValue - The raw header value
 * @param trustedMatchers - Compiled trusted-proxy predicates, when configured
 * @param proxyHops - Declared proxy count, when configured
 * @returns The resolved address, or `undefined` when none can be resolved
 */
function resolveForwardedIp(
  headerValue: string,
  trustedMatchers: readonly ((candidate: string) => boolean)[] | undefined,
  proxyHops: number | undefined,
): string | undefined {
  const chain = parseForwardedChain(headerValue);
  if (chain.length === 0) {
    return undefined;
  }

  if (trustedMatchers !== undefined) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i] as string;
      if (!trustedMatchers.some((matches) => matches(entry))) {
        return entry;
      }
    }
    // Every entry is a trusted proxy: the client address was never recorded,
    // so there is nothing honest to return.
    return undefined;
  }

  if (proxyHops !== undefined) {
    const index = chain.length - 1 - proxyHops;
    if (index < 0) {
      return undefined;
    }
    return chain[index];
  }

  return chain[0];
}
