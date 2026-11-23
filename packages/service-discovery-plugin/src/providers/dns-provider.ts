/**
 * `DnsProvider` — SRV and address-record discovery.
 *
 * This is the one mechanism that cannot be expressed over `fetch`, and it is
 * how Consul DNS, Kubernetes headless services, and ECS Service Connect are
 * actually consumed.
 *
 * @module
 */
import { withDeadline, resolveProbeTiming, deadlineRangeError } from '@setu-ts/common';
import type {
  IDnsResolver,
  IRuntimeServices,
  ServiceInstance,
  SrvRecord,
  Unsubscribe,
} from '@setu-ts/common';
import type { DiscoveryProvider } from '../interfaces/index.ts';

/** Watch teardown is cancellation by the owner, not a DNS lookup failure. */
const WATCH_STOPPED = Object.freeze({});

/** Options shared by both DNS modes. */
interface DnsProviderCommon {
  /** `{service}` is replaced with the requested name. */
  readonly domainTemplate: string;
  /** Whether resolved instances speak TLS. */
  readonly secure?: boolean;
  /** Milliseconds between watch polls. */
  readonly watchIntervalMs: number;
  /** Bound for a watch tick; default 2000, zero unbounded. */
  readonly resolveTimeoutMs?: number;
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
export function lowestPriorityTier(records: readonly SrvRecord[]): readonly SrvRecord[] {
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
   * @throws {RangeError} When resolveTimeoutMs is outside the runtime timer range
   */
  constructor(resolver: IDnsResolver, runtime: IRuntimeServices, options: DnsProviderOptions) {
    const refusal = deadlineRangeError('resolveTimeoutMs', options.resolveTimeoutMs ?? 2000);
    if (refusal !== null) throw refusal;
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

  #lastFailure: { error: unknown } | undefined;

  /** Reachability from the last lookup; absent names are successful answers. */
  isHealthy(): Promise<boolean> {
    return this.#lastFailure === undefined
      ? Promise.resolve(true)
      : Promise.reject(this.#lastFailure.error);
  }

  async resolve(serviceName: string, signal?: AbortSignal): Promise<readonly ServiceInstance[]> {
    let onAbort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      const lookup = this.#lookup(serviceName);
      const instances =
        signal === undefined
          ? await lookup
          : await Promise.race([
              lookup,
              new Promise<never>((_, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) onAbort();
              }),
            ]);
      this.#lastFailure = undefined;
      return instances;
    } catch (error) {
      if (signal?.aborted && signal.reason === WATCH_STOPPED) throw error;
      if (!signal?.aborted && isNameAbsent(error)) {
        this.#lastFailure = undefined;
        return [];
      }
      this.#lastFailure = { error };
      throw error;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  }

  async #lookup(serviceName: string): Promise<readonly ServiceInstance[]> {
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
    let inFlight = false;
    let active: AbortController | undefined;
    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      const local = new AbortController();
      active = local;
      const ms = this.#options.resolveTimeoutMs ?? 2000;
      try {
        const instances = await withDeadline(
          (signal) => this.resolve(serviceName, AbortSignal.any([signal, local.signal])),
          {
            timeoutMs: ms,
            timing: resolveProbeTiming(this.#runtime),
            onTimeout: () =>
              new Error(
                `dns discovery did not answer the read for '${serviceName}' within ${ms} ms`,
              ),
          },
        );
        const fingerprint = JSON.stringify(instances);
        if (!stopped && fingerprint !== last) {
          last = fingerprint;
          listener(instances);
        }
      } catch {
        // The lookup records its outcome for the health indicator; keep the last list.
      } finally {
        inFlight = false;
      }
    };
    const handle = this.#runtime.setInterval(() => {
      void tick();
    }, this.#options.watchIntervalMs);
    void tick();
    return Promise.resolve(() => {
      stopped = true;
      this.#runtime.clearInterval(handle);
      active?.abort(WATCH_STOPPED);
    });
  }
}

/**
 * Whether DNS says the name or record type is absent, through at most five
 * cause/member edges and 64 nodes. Every aggregate member must say absent;
 * truncation, an empty aggregate or any other failure is not absence.
 * @param error - DNS rejection, possibly wrapped by the runtime
 * @returns Whether the name is absent
 * @internal
 */
export function isNameAbsent(error: unknown): boolean {
  let remaining = 64;
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 5 || --remaining < 0) return false;
    if (current === null || typeof current !== 'object') return false;
    if (current instanceof AggregateError) {
      const members: unknown[] = current.errors;
      return (
        members.length > 0 &&
        members.length <= remaining &&
        members.every((member) => visit(member, depth + 1))
      );
    }
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    // An explicit failure code must not be hidden by an absent nested cause.
    if (record.code !== undefined) return record.code === 'ENOTFOUND' || record.code === 'ENODATA';
    if (record.name === 'NotFound') return true;
    return visit(record.cause, depth + 1);
  };
  return visit(error, 0);
}
