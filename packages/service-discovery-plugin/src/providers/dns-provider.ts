/**
 * `DnsProvider` — SRV and address-record discovery.
 *
 * This is the one mechanism that cannot be expressed over `fetch`, and it is
 * how Consul DNS, Kubernetes headless services, and ECS Service Connect are
 * actually consumed.
 *
 * @module
 */
import type {
  IDnsResolver,
  IRuntimeServices,
  ServiceInstance,
  SrvRecord,
  TimerHandle,
  Unsubscribe,
} from '@setu-ts/common';
import type { DiscoveryProvider } from '../interfaces/index.ts';

/** Options shared by both DNS modes. */
interface DnsProviderCommon {
  /** `{service}` is replaced with the requested name. */
  readonly domainTemplate: string;
  /** Whether resolved instances speak TLS. */
  readonly secure?: boolean;
  /** Milliseconds between watch polls. */
  readonly watchIntervalMs: number;
}

/**
 * Constructor options.
 *
 * A union rather than an optional `port`, so `'a'` mode cannot be constructed
 * without one and there is no runtime fallback to leave untested.
 *
 * @since 0.2.0
 */
export type DnsProviderOptions =
  | (DnsProviderCommon & {
    /** Read SRV records, honoring RFC 2782 priority tiers. */
    readonly mode: 'srv';
  })
  | (DnsProviderCommon & {
    /** Read address records. */
    readonly mode: 'a';
    /** Port every resolved address is reached on — DNS carries none. */
    readonly port: number;
  });

/**
 * Keeps only the records in the numerically lowest priority tier.
 *
 * RFC 2782 says a client contacts the lowest-priority tier first and
 * distributes across it by weight. Ignoring priority would spread traffic
 * across a primary and its designated fallback simultaneously — the opposite
 * of what the zone author asked for.
 *
 * @param records - Every SRV record returned
 * @returns The lowest-priority tier, or an empty list
 * @since 0.2.0
 */
export function lowestPriorityTier(
  records: readonly SrvRecord[],
): readonly SrvRecord[] {
  if (records.length === 0) {
    return [];
  }
  const lowest = records.reduce(
    (min, record) => (record.priority < min ? record.priority : min),
    records[0].priority,
  );
  return records.filter((record) => record.priority === lowest);
}

/**
 * Resolves services through DNS.
 *
 * @since 0.2.0
 */
export class DnsProvider implements DiscoveryProvider {
  /** Backend id. */
  readonly kind = 'dns';

  readonly #resolver: IDnsResolver;
  readonly #runtime: IRuntimeServices;
  readonly #options: DnsProviderOptions;

  /**
   * @param resolver - The DNS resolver from `IRuntimeServices.dns`
   * @param runtime - Supplies timers for the poll
   * @param options - Mode, template, port, and poll interval
   */
  constructor(
    resolver: IDnsResolver,
    runtime: IRuntimeServices,
    options: DnsProviderOptions,
  ) {
    this.#resolver = resolver;
    this.#runtime = runtime;
    this.#options = options;
  }

  /**
   * Substitutes the service name into the configured template.
   *
   * @param serviceName - Logical service name
   * @returns The hostname to query
   */
  domainFor(serviceName: string): string {
    return this.#options.domainTemplate.replaceAll('{service}', serviceName);
  }

  async resolve(serviceName: string): Promise<readonly ServiceInstance[]> {
    const domain = this.domainFor(serviceName);
    const secure = this.#options.secure ?? false;

    if (this.#options.mode === 'a') {
      const addresses = await this.#resolver.resolveHost(domain);
      const port = this.#options.port;
      return addresses.map((address) => ({
        id: `${address}:${port}`,
        serviceName,
        host: address,
        port,
        secure,
      }));
    }

    const records = await this.#resolver.resolveSrv(domain);
    return lowestPriorityTier(records).map((record) => {
      const host = record.host.replace(/\.$/, '');
      return {
        id: `${host}:${record.port}`,
        serviceName,
        host,
        port: record.port,
        secure,
        // The zone's own weighting, so `'weighted-random'` honors it with no
        // extra configuration surface.
        weight: record.weight,
      };
    });
  }

  /**
   * Polls at `watchIntervalMs`, firing only when the instance list changed.
   *
   * DNS has no push channel. Polling is the honest implementation: a `watch()`
   * that never fires would be worse than a documented interval.
   */
  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe> {
    let last = '';
    let stopped = false;
    let handle: TimerHandle | null = null;

    const tick = async (): Promise<void> => {
      try {
        const instances = await this.resolve(serviceName);
        const fingerprint = JSON.stringify(instances);
        if (!stopped && fingerprint !== last) {
          last = fingerprint;
          listener(instances);
        }
      } catch {
        // A failed lookup is a transient DNS condition, not a change: keeping
        // the last fingerprint means recovery fires the listener again.
      }
    };

    const schedule = (): void => {
      // Guarded: unsubscribing before the first lookup resolves would
      // otherwise arm an interval after the clear, leaking a timer nothing
      // holds a handle to.
      if (stopped) {
        return;
      }
      handle = this.#runtime.setInterval(() => {
        void tick();
      }, this.#options.watchIntervalMs);
    };

    void tick().then(schedule);

    return Promise.resolve(() => {
      stopped = true;
      if (handle !== null) {
        this.#runtime.clearInterval(handle);
      }
    });
  }
}
