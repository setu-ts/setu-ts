/**
 * `createDnsResolver` on Node and Bun: each record-type query tries the servers
 * in order, one attempt per server, each through a `node:dns/promises`
 * `Resolver` of its own (`tries: 1`, one server) so cancelling it touches no
 * other attempt. An attempt ends at its equal share of the bound by the
 * resolver's own timer, because c-ares does not end an attempt before about
 * 250 ms whatever `timeout` asks for. The next server is tried after any error
 * except `ENOTFOUND`/`ENODATA`. A whole-lookup timer bounds the call.
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

/** Creates a resolver that tries each server in turn, within a bound over the whole lookup. */
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

  const share = Math.max(1, Math.ceil(timeoutMs / servers.length));
  // NXDOMAIN and no-data are the zone's own answer: another server would give the same.
  const absent = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOTFOUND' || code === 'ENODATA';
  };

  function lookup<T>(
    hostname: string,
    queries: readonly ((resolver: NodeResolverLike) => Promise<T>)[],
  ): Promise<PromiseSettledResult<T>[]> {
    return new Promise((resolve) => {
      const results: PromiseSettledResult<T>[] = [];
      // Every attempt still in flight, so the whole-lookup timer can stop all of them.
      const active = new Set<() => void>();
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
          for (const stop of active) stop();
          for (let i = 0; i < queries.length; i++) {
            results[i] ??= { status: 'rejected', reason: error };
          }
          finish();
        }, timeoutMs);
      }

      // One attempt: a resolver of its own holding one server, ended at its share of the bound.
      function attempt(
        query: (resolver: NodeResolverLike) => Promise<T>,
        index: number,
      ): Promise<T> {
        const resolver = deps.createResolver({ tries: 1, timeout: timeoutMs === 0 ? -1 : share });
        resolver.setServers([serverStrings[index]!]);
        return new Promise<T>((resolveAttempt, rejectAttempt) => {
          let done = false;
          let attemptTimer: TimerHandle | undefined;
          const settle = (outcome: () => void): void => {
            if (done) return;
            done = true;
            if (attemptTimer !== undefined) deps.clearTimeout(attemptTimer);
            active.delete(stop);
            outcome();
          };
          // The `ECANCELLED` rejection `cancel()` causes arrives after `done` is set, so it is ignored.
          const stop = (): void => {
            settle(() =>
              rejectAttempt(
                Object.assign(new Error(`DNS lookup for ${hostname} was stopped`), {
                  code: 'ETIMEOUT',
                }),
              ),
            );
            resolver.cancel();
          };
          active.add(stop);
          if (timeoutMs > 0) {
            attemptTimer = deps.setTimeout(() => {
              settle(() =>
                rejectAttempt(
                  Object.assign(
                    new Error(
                      `DNS attempt for ${hostname} at server ${index} did not finish within its ${share} ms share`,
                    ),
                    { code: 'ETIMEOUT' },
                  ),
                ),
              );
              resolver.cancel();
            }, share);
          }
          Promise.resolve()
            .then(() => query(resolver))
            .then(
              (value) => settle(() => resolveAttempt(value)),
              (reason: unknown) => settle(() => rejectAttempt(reason)),
            );
        });
      }

      // Servers in order; the next one only after an error that is not the zone's own answer.
      async function queryServers(query: (resolver: NodeResolverLike) => Promise<T>): Promise<T> {
        for (let index = 0; ; index++) {
          try {
            return await attempt(query, index);
          } catch (error) {
            if (timedOut || absent(error) || index === servers.length - 1) throw error;
          }
        }
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
