/**
 * DNS resolver over `node:dns/promises`, shared by the Node and Bun adapters.
 *
 * Bun implements the Node built-ins the adapter already relies on (`node:os`,
 * `node:process`, `node:fs`), so one resolver serves both rather than two
 * copies drifting apart. The static `node:` import is deliberate: Deno, Node,
 * and Bun all support it, and a smuggled `require` is banned.
 *
 * @module
 */

import type { IDnsResolver, SrvRecord } from '@hono-enterprise/common';
import * as nodeDns from 'node:dns/promises';

/**
 * The `node:dns/promises` surface this resolver needs, injectable so every
 * branch is unit-testable without real DNS or network permission.
 *
 * Note `resolveSrv` yields records whose target field is named **`name`** —
 * Deno spells the same field `target`, which is why neither shape escapes
 * this package.
 *
 * @since 0.2.0
 */
export interface NodeDnsModule {
  /** Resolves SRV records. */
  resolveSrv(
    hostname: string,
  ): Promise<{ name: string; port: number; priority: number; weight: number }[]>;
  /** Resolves IPv4 addresses. */
  resolve4(hostname: string): Promise<string[]>;
  /** Resolves IPv6 addresses. */
  resolve6(hostname: string): Promise<string[]>;
}

/**
 * Concatenates the fulfilled halves of the `A`/`AAAA` pair, rejecting only
 * when both failed.
 *
 * An IPv4-only host has no `AAAA` record at all and the resolver rejects
 * rather than returning an empty list, so tolerating one failed family is what
 * makes `resolveHost` usable against an ordinary host.
 */
function combineAddressFamilies(
  results: readonly PromiseSettledResult<string[]>[],
  hostname: string,
): readonly string[] {
  const addresses: string[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      addresses.push(...result.value);
    } else {
      failures.push(result.reason);
    }
  }
  if (failures.length === results.length) {
    throw new Error(`DNS lookup failed for ${hostname}`, { cause: failures[0] });
  }
  return addresses;
}

/**
 * Creates an {@linkcode IDnsResolver} backed by `node:dns/promises`.
 *
 * @param dns - Injected DNS module (defaults to the real `node:dns/promises`)
 * @returns A resolver normalizing Node's record shapes onto {@linkcode SrvRecord}
 * @since 0.2.0
 */
export function createNodeDnsResolver(dns: NodeDnsModule = nodeDns): IDnsResolver {
  return {
    async resolveSrv(hostname: string): Promise<readonly SrvRecord[]> {
      const records = await dns.resolveSrv(hostname);
      return records.map((record) => ({
        host: record.name,
        port: record.port,
        priority: record.priority,
        weight: record.weight,
      }));
    },
    async resolveHost(hostname: string): Promise<readonly string[]> {
      const results = await Promise.allSettled([
        dns.resolve4(hostname),
        dns.resolve6(hostname),
      ]);
      return combineAddressFamilies(results, hostname);
    },
  };
}
