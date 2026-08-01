/**
 * `StaticProvider` — a literal instance list, with no backend at all.
 *
 * The zero-dependency default: useful in tests, in a compose stack, and
 * wherever addresses are known at deploy time. It has no health signal of its
 * own, which is exactly why outlier ejection matters here — reported failures
 * are the only way a static deployment gets failover.
 *
 * @module
 */
import type { IRuntimeServices, ServiceInstance, Unsubscribe } from '@hono-enterprise/common';
import type { DiscoveryProvider, StaticServiceDefinition } from '../interfaces/index.ts';

/**
 * Serves a configured instance list.
 *
 * @since 0.2.0
 */
export class StaticProvider implements DiscoveryProvider {
  /** Backend id. */
  readonly kind = 'static';

  readonly #services: Readonly<Record<string, readonly StaticServiceDefinition[]>>;
  readonly #runtime: IRuntimeServices;

  /**
   * @param services - Service name to its instances
   * @param runtime - Supplies the timer used to deliver the first watch event
   */
  constructor(
    services: Readonly<Record<string, readonly StaticServiceDefinition[]>>,
    runtime: IRuntimeServices,
  ) {
    this.#services = services;
    this.#runtime = runtime;
  }

  resolve(serviceName: string): Promise<readonly ServiceInstance[]> {
    return Promise.resolve(this.#instances(serviceName));
  }

  /**
   * Fires once with the configured list and never again.
   *
   * The list is immutable by construction, so there is nothing further to
   * report. Delivering it on a timer rather than synchronously means a caller
   * that subscribes and then reads has the same ordering it would get from a
   * real backend.
   */
  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe> {
    let cancelled = false;
    const handle = this.#runtime.setTimeout(() => {
      if (!cancelled) {
        listener(this.#instances(serviceName));
      }
    }, 0);

    return Promise.resolve(() => {
      cancelled = true;
      this.#runtime.clearTimeout(handle);
    });
  }

  #instances(serviceName: string): readonly ServiceInstance[] {
    const definitions = this.#services[serviceName];
    if (definitions === undefined) {
      return [];
    }
    return definitions.map((definition) => ({
      id: definition.id ?? `${definition.host}:${definition.port}`,
      serviceName,
      host: definition.host,
      port: definition.port,
      ...(definition.secure !== undefined ? { secure: definition.secure } : {}),
      ...(definition.weight !== undefined ? { weight: definition.weight } : {}),
      ...(definition.tags !== undefined ? { tags: definition.tags } : {}),
      ...(definition.metadata !== undefined ? { metadata: definition.metadata } : {}),
    }));
  }
}
