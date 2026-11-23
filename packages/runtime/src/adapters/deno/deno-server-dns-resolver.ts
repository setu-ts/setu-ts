/**
 * `createDnsResolver` on Deno: `resolveDns` takes one `nameServer` per call, so
 * the servers are tried in order, moving on after any error but `NotFound`.
 * Each attempt has its own abort controller and share of the bound; the whole
 * lookup has a timer of the resolver's own.
 *
 * @module
 */

import type { DnsResolverOptions, IDnsResolver, TimerHandle } from '@setu-ts/common';
import type { DenoDnsHost } from './deno-dns-resolver.ts';
import { combineAddressFamilies } from '../shared/address-families.ts';
import { parseDnsResolverOptions } from '../shared/dns-server-options.ts';
import { crossClearTimeout, crossSetTimeout } from '../../services/cross-runtime.ts';

/** Timers are injectable so both the attempt and whole-lookup bounds can be tested. */
export interface IDenoDnsTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Creates a resolver trying IP-literal name servers in order on Deno. */
export function createDenoServerDnsResolver(
  options: DnsResolverOptions,
  host: DenoDnsHost,
  timers: IDenoDnsTimers = { setTimeout: crossSetTimeout, clearTimeout: crossClearTimeout },
): IDnsResolver {
  const { servers, timeoutMs } = parseDnsResolverOptions(options);
  const share = Math.max(1, Math.ceil(timeoutMs / servers.length));

  function lookup<T>(
    hostname: string,
    queries: readonly ((options: Parameters<DenoDnsHost['resolveDns']>[2]) => Promise<T>)[],
  ): Promise<PromiseSettledResult<T>[]> {
    return new Promise((resolve) => {
      const results: PromiseSettledResult<T>[] = [];
      const active = new Set<() => void>();
      let remaining = queries.length;
      let settled = false;
      let timedOut = false;
      let wholeTimer: TimerHandle | undefined;
      const timeoutError = (): Error =>
        Object.assign(
          new Error(`DNS lookup for ${hostname} did not finish within ${timeoutMs} ms`),
          { code: 'ETIMEOUT' },
        );
      const finish = (): void => {
        settled = true;
        if (wholeTimer !== undefined) timers.clearTimeout(wholeTimer);
        resolve(results);
      };
      if (timeoutMs > 0) {
        wholeTimer = timers.setTimeout(() => {
          if (settled) return;
          timedOut = true;
          const error = timeoutError();
          for (const cancel of active) cancel();
          for (let i = 0; i < queries.length; i++)
            results[i] ??= { status: 'rejected', reason: error };
          finish();
        }, timeoutMs);
      }

      async function queryServers(
        query: (options: Parameters<DenoDnsHost['resolveDns']>[2]) => Promise<T>,
      ): Promise<T> {
        for (let i = 0; i < servers.length; i++) {
          const server = servers[i]!;
          const controller = timeoutMs > 0 ? new AbortController() : undefined;
          let attemptTimer: TimerHandle | undefined;
          const cancel = (): void => {
            if (attemptTimer !== undefined) timers.clearTimeout(attemptTimer);
            controller?.abort(timeoutError());
          };
          active.add(cancel);
          if (controller !== undefined) {
            attemptTimer = timers.setTimeout(
              () =>
                controller.abort(
                  Object.assign(
                    new Error(
                      `DNS attempt for ${hostname} at server ${i} did not finish within its ${share} ms share`,
                    ),
                    { code: 'ETIMEOUT' },
                  ),
                ),
              share,
            );
          }
          try {
            return await query({
              nameServer: { ipAddr: server.address, port: server.port },
              ...(controller === undefined ? {} : { signal: controller.signal }),
            });
          } catch (error) {
            if (
              timedOut ||
              (error instanceof Error && error.name === 'NotFound') ||
              i === servers.length - 1
            )
              throw error;
          } finally {
            if (attemptTimer !== undefined) timers.clearTimeout(attemptTimer);
            active.delete(cancel);
          }
        }
        // Validation guarantees a nonempty server list; the final attempt returns or throws.
        throw new Error('DNS server list exhausted');
      }

      queries.forEach((query, index) => {
        const record = (result: PromiseSettledResult<T>): void => {
          if (timedOut || settled) return;
          results[index] = result;
          if (--remaining === 0) finish();
        };
        queryServers(query).then(
          (value) => record({ status: 'fulfilled', value }),
          (reason: unknown) => record({ status: 'rejected', reason }),
        );
      });
    });
  }

  return {
    async resolveSrv(hostname) {
      const [result] = await lookup(hostname, [
        (settings) => host.resolveDns(hostname, 'SRV', settings),
      ]);
      if (result!.status === 'rejected') throw result!.reason;
      // Named fields only, so nothing beyond `SrvRecord` passes through.
      return result!.value.map((record) => ({
        host: record.target,
        port: record.port,
        priority: record.priority,
        weight: record.weight,
      }));
    },
    async resolveHost(hostname) {
      return combineAddressFamilies(
        await lookup(hostname, [
          (settings) => host.resolveDns(hostname, 'A', settings),
          (settings) => host.resolveDns(hostname, 'AAAA', settings),
        ]),
        hostname,
      );
    },
  };
}
