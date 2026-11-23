/**
 * `createDnsResolver` on Node and Bun: one `node:dns/promises` `Resolver` per
 * lookup (its `cancel()` would otherwise cancel other lookups), `tries: 1`,
 * each server given an equal share of the bound, and a whole-lookup timer of
 * the resolver's own.
 *
 * `Resolver` is read from a namespace import at call time, never named, so a
 * Worker that loads the runtime barrel links even where the member is absent.
 *
 * @module
 */

import * as nodeDns from 'node:dns/promises';
import type { DnsResolverOptions, IDnsResolver, TimerHandle } from '@setu-ts/common';
import type { NodeDnsModule } from './node-dns-resolver.ts';
import { combineAddressFamilies } from './address-families.ts';
import { parseDnsResolverOptions } from './dns-server-options.ts';
import { crossClearTimeout, crossSetTimeout } from '../../services/cross-runtime.ts';

/** Per-lookup cancellation must never affect another lookup. */
export interface NodeResolverLike extends NodeDnsModule {
  setServers(servers: string[]): void;
  cancel(): void;
}

/** Injectable c-ares constructor and timers. */
export interface INodeDnsDependencies {
  createResolver(options: { timeout: number; tries: number }): NodeResolverLike;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Creates an independent resolver with a bound over each complete lookup. */
export function createNodeServerDnsResolver(
  options: DnsResolverOptions,
  deps: INodeDnsDependencies = {
    createResolver: (settings) => new nodeDns.Resolver(settings),
    setTimeout: crossSetTimeout,
    clearTimeout: crossClearTimeout,
  },
): IDnsResolver {
  const { servers, timeoutMs } = parseDnsResolverOptions(options);
  const serverStrings = servers.map(({ address, port, family }) =>
    family === 6 ? `[${address}]:${port}` : port === 53 ? address : `${address}:${port}`,
  );

  function lookup<T>(
    hostname: string,
    queries: readonly ((resolver: NodeResolverLike) => Promise<T>)[],
  ): Promise<PromiseSettledResult<T>[]> {
    const resolver = deps.createResolver({
      tries: 1,
      timeout: timeoutMs === 0 ? -1 : Math.max(1, Math.ceil(timeoutMs / servers.length)),
    });
    resolver.setServers(serverStrings);
    return new Promise((resolve) => {
      const results: PromiseSettledResult<T>[] = [];
      let remaining = queries.length;
      let settled = false;
      let timedOut = false;
      let timer: TimerHandle | undefined;
      const finish = (): void => {
        settled = true;
        if (timer !== undefined) deps.clearTimeout(timer);
        resolve(results);
      };
      if (timeoutMs > 0) {
        timer = deps.setTimeout(() => {
          if (settled) return;
          timedOut = true;
          const error = Object.assign(
            new Error(`DNS lookup for ${hostname} did not finish within ${timeoutMs} ms`),
            { code: 'ETIMEOUT' },
          );
          resolver.cancel();
          for (let i = 0; i < queries.length; i++) {
            results[i] ??= { status: 'rejected', reason: error };
          }
          finish();
        }, timeoutMs);
      }
      queries.forEach((query, index) => {
        const record = (result: PromiseSettledResult<T>): void => {
          if (timedOut || settled) return;
          results[index] = result;
          if (--remaining === 0) finish();
        };
        Promise.resolve()
          .then(() => query(resolver))
          .then(
            (value) => record({ status: 'fulfilled', value }),
            (reason: unknown) => record({ status: 'rejected', reason }),
          );
      });
    });
  }

  return {
    async resolveSrv(hostname) {
      const [result] = await lookup(hostname, [(resolver) => resolver.resolveSrv(hostname)]);
      if (result!.status === 'rejected') throw result!.reason;
      // Named fields only: Node adds `type: 'SRV'`, which `SrvRecord` does not carry.
      return result!.value.map((record) => ({
        host: record.name,
        port: record.port,
        priority: record.priority,
        weight: record.weight,
      }));
    },
    async resolveHost(hostname) {
      return combineAddressFamilies(
        await lookup(hostname, [
          (resolver) => resolver.resolve4(hostname),
          (resolver) => resolver.resolve6(hostname),
        ]),
        hostname,
      );
    },
  };
}
