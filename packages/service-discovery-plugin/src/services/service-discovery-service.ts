/**
 * `ServiceDiscoveryService` — the {@linkcode IServiceDiscovery} implementation
 * registered under `CAPABILITIES.SERVICE_DISCOVERY`.
 *
 * Owns the read-through cache, the in-flight coalescing, the balancer, and the
 * ejection filter, so a provider only answers "who is running this service".
 *
 * @module
 */
import type {
  IRuntimeServices,
  IServiceDiscovery,
  PickOptions,
  ServiceInstance,
  ServiceOutcome,
  Unsubscribe,
} from '@setu-ts/common';
import type { DiscoveryProvider } from '../interfaces/index.ts';
import type { ResolvedDiscoveryOptions } from '../options.ts';
import { createLoadBalancer, type LoadBalancer } from '../balancer/load-balancer.ts';
import { EjectionTracker } from './ejection-tracker.ts';
import { instanceUrl } from '../url/instance-url.ts';
import { DiscoveryUnavailableError } from '../errors.ts';

/** One cached instance list with the monotonic reading it was taken at. */
interface CacheEntry {
  instances: readonly ServiceInstance[];
  stampMs: number;
}

/**
 * Resolves, balances, and learns from reported outcomes.
 *
 * @since 0.2.0
 */
export class ServiceDiscoveryService implements IServiceDiscovery {
  readonly #provider: DiscoveryProvider;
  readonly #runtime: IRuntimeServices;
  readonly #options: ResolvedDiscoveryOptions;
  readonly #balancer: LoadBalancer;
  readonly #ejection: EjectionTracker | null;

  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<readonly ServiceInstance[]>>();
  readonly #watches = new Set<Unsubscribe>();
  #degraded = false;

  /**
   * @param provider - The discovery backend
   * @param runtime - Supplies the monotonic clock and randomness
   * @param options - Options after defaults
   */
  constructor(
    provider: DiscoveryProvider,
    runtime: IRuntimeServices,
    options: ResolvedDiscoveryOptions,
  ) {
    this.#provider = provider;
    this.#runtime = runtime;
    this.#options = options;
    this.#balancer = createLoadBalancer(options.strategy, runtime);
    this.#ejection = options.ejection === false
      ? null
      : new EjectionTracker(runtime, options.ejection);
  }

  /** The backend id, for the health indicator. */
  get providerKind(): string {
    return this.#provider.kind;
  }

  /** Whether the last refresh failed and a stale snapshot is being served. */
  get degraded(): boolean {
    return this.#degraded;
  }

  /** Number of service names currently cached. */
  get cachedServices(): number {
    return this.#cache.size;
  }

  /** Number of active watches. */
  get watchedServices(): number {
    return this.#watches.size;
  }

  /** Number of instances currently ejected. */
  get ejectedInstances(): number {
    return this.#ejection?.ejectedCount ?? 0;
  }

  async resolve(serviceName: string): Promise<readonly ServiceInstance[]> {
    const cached = this.#cache.get(serviceName);
    if (
      cached !== undefined &&
      this.#options.cacheTtlMs > 0 &&
      this.#runtime.hrtime() - cached.stampMs < this.#options.cacheTtlMs
    ) {
      return cached.instances;
    }

    // Coalesced per name: a burst of concurrent picks for one cold service
    // issues ONE backend read, not one per caller.
    const existing = this.#inFlight.get(serviceName);
    if (existing !== undefined) {
      return await existing;
    }

    const read = this.#read(serviceName, cached);
    this.#inFlight.set(serviceName, read);
    try {
      return await read;
    } finally {
      this.#inFlight.delete(serviceName);
    }
  }

  async pick(serviceName: string, options?: PickOptions): Promise<ServiceInstance | null> {
    const instances = await this.resolve(serviceName);
    const usable = this.#ejection?.filter(serviceName, instances) ?? instances;
    return this.#balancer.pick(serviceName, usable, options?.strategy);
  }

  async resolveUrl(
    serviceName: string,
    path?: string,
    options?: PickOptions,
  ): Promise<string | null> {
    // Funnels through pick() rather than re-resolving: one cache read, one
    // ejection filter, one strategy resolution. Two entry points honoring two
    // different configurations is the split this deliberately avoids.
    const instance = await this.pick(serviceName, options);
    return instance === null ? null : instanceUrl(instance, path);
  }

  report(instance: ServiceInstance, outcome: ServiceOutcome): void {
    if (this.#ejection === null) {
      return;
    }
    const known = this.#cache.get(instance.serviceName)?.instances.length ?? 0;
    this.#ejection.record(instance.serviceName, instance, outcome, known);
  }

  async watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe> {
    const unsubscribe = await this.#provider.watch(serviceName, (instances) => {
      // A change makes the cached entry wrong immediately, so the TTL is a
      // safety net for unwatched services rather than the freshness mechanism
      // for watched ones.
      this.#cache.set(serviceName, { instances, stampMs: this.#runtime.hrtime() });
      this.#degraded = false;
      listener(instances);
    });

    const wrapped = (): void => {
      this.#watches.delete(wrapped);
      unsubscribe();
    };
    this.#watches.add(wrapped);
    return wrapped;
  }

  /** Stops every active watch and drops ejection state. */
  close(): void {
    for (const unsubscribe of [...this.#watches]) {
      unsubscribe();
    }
    this.#watches.clear();
    this.#ejection?.clear();
  }

  /** Reads the backend, falling back to a stale entry when one exists. */
  async #read(
    serviceName: string,
    stale: CacheEntry | undefined,
  ): Promise<readonly ServiceInstance[]> {
    try {
      const instances = await this.#provider.resolve(serviceName);
      this.#cache.set(serviceName, { instances, stampMs: this.#runtime.hrtime() });
      this.#degraded = false;
      return instances;
    } catch (error) {
      if (stale !== undefined) {
        // Serving a slightly old address list beats serving none: the
        // instances in it are overwhelmingly still up, and the alternative is
        // failing every call while the backend is unreachable.
        this.#degraded = true;
        return stale.instances;
      }
      throw new DiscoveryUnavailableError(
        `Service discovery could not resolve '${serviceName}' and has nothing cached`,
        { cause: error },
      );
    }
  }
}
