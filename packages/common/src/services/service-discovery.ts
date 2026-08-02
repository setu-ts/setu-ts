/**
 * Service discovery contracts, consumed by the ServiceDiscoveryPlugin.
 *
 * Turning a logical service name into a reachable address is the one piece
 * direct service-to-service HTTP needs and brokered messaging does not: a
 * broker caller addresses a topic, an HTTP caller needs a host and a port.
 * These types are the vocabulary a consumer uses after resolving
 * `CAPABILITIES.SERVICE_DISCOVERY` — they live here rather than in the plugin
 * so nothing has to import a plugin to type the capability it resolved.
 *
 * @module
 */
import type { Unsubscribe } from './events.ts';

/**
 * One reachable instance of a service.
 *
 * Providers normalize their backend's own shape into this — a Consul health
 * entry, a Kubernetes EndpointSlice endpoint, a DNS SRV record, and a literal
 * static entry all arrive here identically.
 *
 * @since 0.2.0
 */
export interface ServiceInstance {
  /**
   * Instance identity, unique within the service.
   *
   * Used as the ejection tracker's key, so it must be stable across resolves
   * for ejection to survive a cache refresh.
   */
  readonly id: string;
  /** The logical service this instance belongs to. */
  readonly serviceName: string;
  /** Hostname or IP literal. IPv6 literals arrive unbracketed. */
  readonly host: string;
  /** TCP port. */
  readonly port: number;
  /** Whether the instance speaks TLS, deciding the `https` scheme. */
  readonly secure?: boolean;
  /**
   * Relative selection weight for the `'weighted-random'` strategy.
   *
   * Absent means `1`. A non-positive weight is never selected unless every
   * instance is non-positive, in which case selection falls back to uniform.
   */
  readonly weight?: number;
  /** Free-form labels the backend carries (Consul tags, for example). */
  readonly tags?: readonly string[];
  /** Free-form key/value metadata the backend carries. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * How {@linkcode IServiceDiscovery.pick} chooses among healthy instances.
 *
 * - `round-robin` — a per-service cursor, taken modulo the current count.
 * - `random` — uniform.
 * - `weighted-random` — proportional to {@linkcode ServiceInstance.weight}.
 *
 * @since 0.2.0
 */
export type LoadBalanceStrategy = 'round-robin' | 'random' | 'weighted-random';

/**
 * Per-call overrides for {@linkcode IServiceDiscovery.pick}.
 *
 * @since 0.2.0
 */
export interface PickOptions {
  /** Overrides the plugin-configured strategy for this call only. */
  readonly strategy?: LoadBalanceStrategy;
}

/**
 * How a call to an instance went, as reported by the caller.
 *
 * @since 0.2.0
 */
export type ServiceOutcome = 'success' | 'failure';

/**
 * Resolves logical service names to reachable instances, balances across them,
 * and learns from reported call outcomes.
 *
 * Registered under `CAPABILITIES.SERVICE_DISCOVERY`.
 *
 * @example Calling a service, with failover
 * ```typescript
 * const discovery = ctx.services.get<IServiceDiscovery>(
 *   CAPABILITIES.SERVICE_DISCOVERY,
 * );
 *
 * const instance = await discovery.pick('billing');
 * if (instance === null) throw new Error('no billing instance');
 *
 * try {
 *   const url = await discovery.resolveUrl('billing', '/invoices');
 *   const response = await fetch(url!);
 *   discovery.report(instance, response.ok ? 'success' : 'failure');
 * } catch (error) {
 *   discovery.report(instance, 'failure');
 *   throw error;
 * }
 * ```
 * @since 0.2.0
 */
export interface IServiceDiscovery {
  /**
   * Lists every instance discovery knows for a service.
   *
   * Reports what the backend says, so ejected instances are **included** —
   * ejection is a {@linkcode IServiceDiscovery.pick} concern, not a knowledge
   * one. An unknown service name resolves to an empty list rather than
   * throwing.
   *
   * @param serviceName - Logical service name
   * @returns Every known instance, possibly empty
   * @throws {Error} If the backend fails and nothing is cached
   */
  resolve(serviceName: string): Promise<readonly ServiceInstance[]>;

  /**
   * Chooses one instance, skipping ejected ones.
   *
   * @param serviceName - Logical service name
   * @param options - Per-call strategy override
   * @returns The chosen instance, or `null` when the service has none
   */
  pick(serviceName: string, options?: PickOptions): Promise<ServiceInstance | null>;

  /**
   * Formats {@linkcode IServiceDiscovery.pick}'s choice as an absolute URL.
   *
   * @param serviceName - Logical service name
   * @param path - Path appended to the instance's origin
   * @param options - Per-call strategy override
   * @returns The URL, or `null` when the service has no instance
   */
  resolveUrl(
    serviceName: string,
    path?: string,
    options?: PickOptions,
  ): Promise<string | null>;

  /**
   * Reports how a call to an instance went.
   *
   * Enough failures inside the configured window eject the instance from
   * {@linkcode IServiceDiscovery.pick}'s pool; a success clears its window and
   * un-ejects it immediately. Ejection state is per-process.
   *
   * @param instance - The instance that was called
   * @param outcome - Whether the call succeeded
   */
  report(instance: ServiceInstance, outcome: ServiceOutcome): void;

  /**
   * Subscribes to instance-list changes for a service.
   *
   * Push-based where the backend supports it (Consul blocking queries,
   * Kubernetes watch streams) and interval-polled where it does not (DNS,
   * static). The listener receives the full current list, never a delta.
   *
   * @param serviceName - Logical service name
   * @param listener - Called with the full instance list on every change
   * @returns Unsubscribe function that also stops the underlying watch
   */
  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe>;
}
