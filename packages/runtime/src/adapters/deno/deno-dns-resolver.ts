/**
 * DNS resolver over `Deno.resolveDns`, reached through the {@linkcode DenoHost}
 * seam so it is unit-testable without real DNS or `--allow-net`.
 *
 * @module
 */

import type { IDnsResolver, SrvRecord } from '@hono-enterprise/common';

/**
 * One SRV record as `Deno.resolveDns` returns it.
 *
 * The target field is named **`target`** here; Node spells the identical field
 * `name`. Normalizing both onto {@linkcode SrvRecord.host} is the whole reason
 * these two resolvers exist separately — a port that passed either shape
 * through unchanged would type-check on both runtimes and produce `undefined`
 * hostnames on one of them.
 *
 * @since 0.2.0
 */
export interface DenoSrvRecord {
  /** Target hostname. */
  target: string;
  /** TCP port. */
  port: number;
  /** RFC 2782 priority. */
  priority: number;
  /** RFC 2782 weight. */
  weight: number;
}

/**
 * The `Deno.resolveDns` surface this resolver needs.
 *
 * Declared as two call signatures rather than a generic because the real API
 * is an overload set keyed on the record type: `'SRV'` yields records, the
 * address families yield strings.
 *
 * @since 0.2.0
 */
export interface DenoDnsHost {
  /** Resolves SRV records. */
  resolveDns(query: string, recordType: 'SRV'): Promise<DenoSrvRecord[]>;
  /** Resolves address records. */
  resolveDns(query: string, recordType: 'A' | 'AAAA'): Promise<string[]>;
}

/**
 * Creates an {@linkcode IDnsResolver} backed by `Deno.resolveDns`.
 *
 * @param host - The Deno DNS host (the real `Deno` global in production)
 * @returns A resolver normalizing Deno's record shapes onto {@linkcode SrvRecord}
 * @since 0.2.0
 */
export function createDenoDnsResolver(host: DenoDnsHost): IDnsResolver {
  return {
    async resolveSrv(hostname: string): Promise<readonly SrvRecord[]> {
      const records = await host.resolveDns(hostname, 'SRV');
      return records.map((record) => ({
        host: record.target,
        port: record.port,
        priority: record.priority,
        weight: record.weight,
      }));
    },
    async resolveHost(hostname: string): Promise<readonly string[]> {
      const results = await Promise.allSettled([
        host.resolveDns(hostname, 'A'),
        host.resolveDns(hostname, 'AAAA'),
      ]);
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
    },
  };
}
