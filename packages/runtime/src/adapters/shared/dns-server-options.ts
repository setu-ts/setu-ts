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
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 0 ||
    options.timeoutMs > 2_147_483_647
  ) {
    throw new RangeError('timeoutMs must be an integer from 0 to 2147483647');
  }
  if (!Array.isArray(options.servers) || options.servers.length === 0) {
    throw new RangeError('servers must be a non-empty array');
  }
  const servers = options.servers.map((entry: string, index: number): IDnsServer => {
    const invalid = (): never => {
      throw new RangeError(
        `servers[${index}] '${entry}' must be an IP literal with an optional decimal port (1..65535); a port needs brackets for IPv6`,
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
  return { servers, timeoutMs: options.timeoutMs };
}
