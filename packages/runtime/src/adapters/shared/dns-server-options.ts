/**
 * Validation of {@linkcode DnsResolverOptions}, shared by every runtime that
 * serves `createDnsResolver`, so one rule and one message apply everywhere.
 *
 * `node:net` is a namespace import read at call time: this module is reachable
 * from the barrel Workers apps load, and a named import of a member workerd
 * might lack would fail module linking in every Worker.
 *
 * @module
 */

import * as nodeNet from 'node:net';
import type { DnsResolverOptions } from '@setu-ts/common';

/** Validated name server; no host resolution is needed to reach it. */
export interface IDnsServer {
  readonly address: string;
  readonly port: number;
  readonly family: 4 | 6;
}

/** Validates the same IP-literal and timeout grammar on every runtime. */
export function parseDnsResolverOptions(options: DnsResolverOptions): {
  servers: readonly IDnsServer[];
  timeoutMs: number;
} {
  // Each option is read once, so the value checked is the value returned.
  const timeoutMs = options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs must be an integer from 0 to 2147483647');
  }
  const list = options.servers;
  // `length` is read once, so the check and the loop see the same count.
  const count: unknown = Array.isArray(list) ? list.length : 0;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    throw new RangeError('servers must be a non-empty array');
  }
  // Read by index over `length`: `map` skips holes and `Array.from` follows a replaced iterator.
  const servers = Array.from({ length: count }, (_, index): IDnsServer => {
    const entry = list[index] as string;
    const invalid = (): never => {
      // A Symbol or a null-prototype object throws inside a template literal, so only a
      // string entry is quoted; anything else is named by its type.
      const shown = typeof entry === 'string' ? `'${entry}'` : `(${typeof entry})`;
      throw new RangeError(
        `servers[${index}] ${shown} must be an IP literal with an optional decimal port (1..65535); a port needs brackets for IPv6`,
      );
    };
    if (typeof entry !== 'string' || entry.includes('%')) return invalid();
    const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(entry);
    const ipv4Port = /^([^:]+):(\d+)$/.exec(entry);
    const parts = bracketed ?? ipv4Port;
    const address = parts ? parts[1]! : entry;
    const port = parts ? Number(parts[2]) : 53;
    const family = nodeNet.isIP(address);
    if (
      (family !== 4 && family !== 6) ||
      (bracketed && family !== 6) ||
      (ipv4Port && family !== 4) ||
      port < 1 ||
      port > 65535
    )
      return invalid();
    return { address, port, family };
  });
  return { servers, timeoutMs };
}
