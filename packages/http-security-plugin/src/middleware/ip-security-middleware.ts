/**
 * IP security middleware factory.
 *
 * Resolves the client IP address and publishes it to
 * `ctx.state.set(CLIENT_IP_STATE_KEY, ip)`. Does not short-circuit.
 *
 * Node, Deno and Bun supply the socket peer as `request.ip`. With
 * `trustedProxies`, that peer must be trusted before any forwarded entry is
 * believed. Workers and plain fetch calls have no peer. Also publishes the
 * trusted public origin for consumers through `requestOriginOf` in common.
 *
 * @module
 */
import { CLIENT_IP_STATE_KEY, REQUEST_ORIGIN_STATE_KEY, requestOriginOf } from '@setu-ts/common';
import type { RequestOrigin } from '@setu-ts/common';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { MALFORMED, parseForwarded } from './forwarded-header.ts';
import { ipv4ToNumber, normalizeIp, parseClientAddress } from './normalize-ip.ts';

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
   * right. With `false`, the client is the socket peer on Node, Deno and Bun.
   * Leftmost and `proxyHops` modes do not check the socket peer; prefer
   * `trustedProxies` when proxy addresses are stable.
   * A selected header entry must be an IP address (port stripped), or no client is resolved.
   */
  readonly trustProxy?: boolean;
  /**
   * The header name to read when `trustProxy` is `true`. Default: `X-Forwarded-For`.
   *
   * With neither {@linkcode IpSecurityOptions.trustedProxies} nor
   * {@linkcode IpSecurityOptions.proxyHops} supplied, the LEFTMOST address is
   * taken — which is the entry a client controls under an appending proxy (see
   * those two options).
   * A selected entry must be an IP address (port stripped), or no client is resolved.
   */
  readonly ipHeader?: string;
  /**
   * Header family to read. Default `'x-forwarded'`; `'forwarded'` reads only
   * RFC 7239 `Forwarded` and conflicts with `ipHeader`.
   * @since 0.10.0
   */
  readonly forwardedHeader?: 'x-forwarded' | 'forwarded';
  /**
   * Addresses of the proxies in front of this application, as literal
   * addresses or CIDR blocks. When supplied, the header is walked RIGHT to
   * LEFT, starting with the socket peer when available, and the first entry
   * that is not one of these is the client.
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
   * Each examined header entry must be an IP address (port stripped), or no client is resolved.
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
   * Does not count or check the socket peer. Prefer `trustedProxies` for
   * proxies with stable addresses.
   * The selected entry and entries to its right must be IP addresses (ports stripped), or no client is resolved.
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
    if (networkValue !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
      // `>>> 0` keeps the mask unsigned; a /0 shift of 32 is undefined in JS,
      // so it is handled as "match everything".
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      const base = (networkValue & mask) >>> 0;
      return (candidate: string): boolean => {
        // Every candidate reaches a matcher already normalized (M119d §3.3).
        const value = ipv4ToNumber(candidate);
        return value !== null && (value & mask) >>> 0 === base;
      };
    }
  }
  const literal = normalizeIp(entry);
  return (candidate: string): boolean => candidate === literal;
}

/**
 * IP security middleware factory.
 *
 * @param options - IP security configuration
 * @returns A middleware function that resolves and publishes the client IP
 */
export function ipSecurityMiddleware(options: IpSecurityOptions = {}): MiddlewareFunction {
  const forwardedHeader =
    options.forwardedHeader === undefined ? 'x-forwarded' : options.forwardedHeader;
  if (forwardedHeader !== 'x-forwarded' && forwardedHeader !== 'forwarded') {
    throw new TypeError(
      "ipSecurityMiddleware: forwardedHeader must be 'x-forwarded' or 'forwarded'.",
    );
  }
  if (forwardedHeader === 'forwarded' && options.ipHeader !== undefined) {
    throw new TypeError('ipSecurityMiddleware: forwardedHeader conflicts with ipHeader.');
  }
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
  if (proxyHops !== undefined && (!Number.isSafeInteger(proxyHops) || proxyHops < 0)) {
    throw new Error(
      `ipSecurityMiddleware: proxyHops must be a non-negative integer, ` +
        `received ${String(proxyHops)}. 0 selects the rightmost entry.`,
    );
  }

  // Compiled once at registration, never per request.
  const trustedMatchers = trustedProxies?.map(compileTrustedProxy);

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    let ip = ctx.request.ip;
    let origin = requestOriginOf(ctx);
    if (trustProxy) {
      const headerValue = ctx.request.headers.get(
        forwardedHeader === 'forwarded' ? 'Forwarded' : ipHeader,
      );
      const hasHeader =
        headerValue !== null && (forwardedHeader === 'forwarded' || headerValue !== '');
      // In `trustedProxies` mode an absent or empty header still walks the
      // socket peer: a trusted proxy that recorded no client resolves no
      // client, never its own address (M113n audit N2). Leftmost and
      // `proxyHops` modes keep the peer when the header is absent.
      if (hasHeader || trustedMatchers !== undefined) {
        const raw = headerValue ?? '';
        const elements = forwardedHeader === 'forwarded' ? parseForwarded(raw) : undefined;
        // A malformed Forwarded element is a BOUNDARY, not a void: the entries
        // to its right were written by later hops and are still read, while
        // everything left of it collapses into the one `MALFORMED` entry the
        // parser returns. The walk below never crosses that boundary, so a
        // client cannot erase its identity (V10-19) nor walk past an unreadable
        // hop into text it wrote itself (M119d §3.1).
        const chain: (string | undefined | typeof MALFORMED)[] =
          elements === undefined
            ? [...parseForwardedChain(raw)]
            : elements.map((element) => (element === MALFORMED ? MALFORMED : element.ip));
        const forwardedLength = chain.length;
        if (trustedMatchers !== undefined && ctx.request.ip !== undefined) {
          chain.push(ctx.request.ip);
        }
        const index = resolveForwardedIndex(
          chain,
          trustedMatchers,
          proxyHops,
          elements === undefined ? forwardedLength : 0,
        );
        const entry = index === undefined ? undefined : chain[index];
        // A selection never lands on the boundary: `resolveForwardedIndex`
        // refuses such an index, and the narrowing keeps the marker out of the
        // published value.
        const selected = entry === MALFORMED ? undefined : entry;
        // A header that resolves no client (a `proxyHops` chain too short, an
        // all-trusted chain, an `unknown` Forwarded hop, a boundary in the way)
        // resolves `undefined` in both families. Falling back to the socket peer
        // would key every caller behind one proxy on that proxy's address.
        ip = selected;
        // The forwarded origin is believed only when the walk itself passed a
        // trusted socket peer. Leftmost, `proxyHops`, and a deployment with no
        // peer (Workers, plain fetch) never checked who wrote the headers, so a
        // client could choose the public host and protocol (M113n audit F2).
        if (
          trustedMatchers !== undefined &&
          ctx.request.ip !== undefined &&
          selected !== undefined &&
          index !== undefined &&
          index < forwardedLength
        ) {
          if (forwardedHeader === 'forwarded') {
            const element = elements?.[index];
            const forwardedElement = element === MALFORMED ? undefined : element;
            origin = validatedForwardedOrigin(
              origin,
              forwardedElement?.proto,
              forwardedElement?.host,
            );
          } else {
            origin = xForwardedOrigin(ctx, origin);
          }
        }
      }
    }

    // Publish one normalized identity in EVERY mode, the socket peer included:
    // a mapped or non-canonical IPv6 client must not hold two keys (V10-28).
    ctx.state.set(CLIENT_IP_STATE_KEY, ip === undefined ? undefined : normalizeIp(ip));
    ctx.state.set(REQUEST_ORIGIN_STATE_KEY, origin);

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
 *   address that could not have been forged past a trusted hop. Reaching a
 *   `MALFORMED` boundary returns `undefined`: the walk never crosses it.
 * - `proxyHops` — return the nth entry from the right. Used when the proxies
 *   cannot be addressed by IP. A header too short for the declared chain, or a
 *   selection with a boundary at or to its right, resolves to `undefined`.
 * - neither — return the leftmost entry, the released behaviour. A chain
 *   carrying a boundary resolves `undefined`: index 0 is, or lies left of, it.
 *
 * @param chain - Wire-order entries, with the peer appended in trusted-proxy mode
 * @param trustedMatchers - Compiled trusted-proxy predicates, when configured
 * @param proxyHops - Declared proxy count, when configured
 * @param unvalidatedLength - Number of X-Forwarded entries; excludes the runtime peer and RFC 7239 elements
 * @returns The selected index, or `undefined` when none can be resolved
 */
function resolveForwardedIndex(
  chain: (string | undefined | typeof MALFORMED)[],
  trustedMatchers: readonly ((candidate: string) => boolean)[] | undefined,
  proxyHops: number | undefined,
  unvalidatedLength: number,
): number | undefined {
  if (chain.length === 0) {
    return undefined;
  }

  if (trustedMatchers !== undefined) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = examinedEntry(chain, i, unvalidatedLength);
      if (entry === MALFORMED) {
        return undefined;
      }
      if (entry === undefined) {
        return i;
      }
      // The runtime peer retains its normalized comparison without validation.
      const candidate = normalizeIp(entry);
      if (!trustedMatchers.some((matches) => matches(candidate))) {
        return i;
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
    // A boundary at the selected index or anywhere to its right means the walk
    // would have had to cross it, so nothing left of it may be returned.
    for (let i = index; i < chain.length; i++) {
      if (examinedEntry(chain, i, unvalidatedLength) === MALFORMED) {
        return undefined;
      }
    }
    return index;
  }

  return examinedEntry(chain, 0, unvalidatedLength) === MALFORMED ? undefined : 0;
}

/**
 * Validated and normalized lazily, only for entries the walk examines: an
 * X-Forwarded-For chain is unbounded. Cache the canonical entry for publication;
 * RFC 7239 elements are already validated and the runtime peer is out of scope.
 */
function examinedEntry(
  chain: (string | undefined | typeof MALFORMED)[],
  index: number,
  unvalidatedLength: number,
): string | undefined | typeof MALFORMED {
  const entry = chain[index];
  if (index >= unvalidatedLength || typeof entry !== 'string') return entry;
  const parsed = parseClientAddress(entry);
  chain[index] = parsed === null ? MALFORMED : parsed;
  return chain[index];
}

/**
 * Validated leftmost X-Forwarded origin candidate. IP security believes it only
 * after a trusted socket peer; CSRF uses it only for a `Sec-Fetch-Site:
 * same-origin` browser request. The function itself decides no trust.
 * @param ctx - The request carrying the headers
 * @param fallback - The URL-derived origin
 * @returns An origin with individually validated forwarded components
 * @internal
 */
export function xForwardedOrigin(ctx: IRequestContext, fallback: RequestOrigin): RequestOrigin {
  return validatedForwardedOrigin(
    fallback,
    ctx.request.headers.get('X-Forwarded-Proto')?.split(',')[0]?.trim(),
    ctx.request.headers.get('X-Forwarded-Host')?.split(',')[0]?.trim(),
  );
}

/** Validates components without deciding whether a proxy is trusted. */
function validatedForwardedOrigin(
  fallback: RequestOrigin,
  proto: string | undefined,
  forwardedHost: string | undefined,
): RequestOrigin {
  const candidate = proto?.toLowerCase();
  const protocol = candidate === 'http' || candidate === 'https' ? candidate : fallback.protocol;
  let host = fallback.host;
  // A browser's `Origin` never carries the scheme's default port, so a proxy
  // writing `$host:$server_port` would otherwise publish an origin no
  // same-origin request matches (M113n audit round 3 observation).
  const defaultPort = protocol === 'https' ? ':443' : ':80';
  const candidateHost =
    forwardedHost?.endsWith(defaultPort) === true
      ? forwardedHost.slice(0, -defaultPort.length)
      : forwardedHost;
  if (candidateHost !== undefined && isPlainHost(candidateHost)) {
    try {
      const url = new URL(`${protocol}://${candidateHost}`);
      if (
        url.host === candidateHost.toLowerCase() &&
        url.pathname === '/' &&
        !/[/?#@\\]/.test(candidateHost) &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      ) {
        host = url.host;
      }
    } catch {
      // A rejected host keeps the URL host; never repair attacker input.
    }
  }
  return { protocol, host, origin: `${protocol}://${host}` };
}

/** Longest host accepted: a 253-character name plus `:` and a five-digit port. */
const MAX_HOST_LENGTH = 259;

/** One DNS label: letters, digits and inner hyphens. Linear to match. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Restricts a forwarded host to a DNS name or bracketed IPv6 literal with an
 * optional numeric port. The WHATWG URL parser admits quotes, backticks, braces
 * and a trailing dot, and this value reaches loader URLs and markup through
 * `publicRequestUrl` (M113n audit F3). The URL check in
 * {@linkcode validatedForwardedOrigin} still applies afterwards.
 */
function isPlainHost(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_HOST_LENGTH) {
    return false;
  }
  const value = candidate.toLowerCase();
  let name = value;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1 || !/^\[[0-9a-f:.]+\]$/.test(value.slice(0, close + 1))) {
      return false;
    }
    const rest = value.slice(close + 1);
    return rest === '' || /^:[0-9]{1,5}$/.test(rest);
  }
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    if (!/^[0-9]{1,5}$/.test(value.slice(colon + 1))) {
      return false;
    }
    name = value.slice(0, colon);
  }
  return name.split('.').every((label) => DNS_LABEL.test(label));
}
