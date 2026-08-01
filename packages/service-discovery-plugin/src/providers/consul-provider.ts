/**
 * `ConsulProvider` — reads the Consul agent's health endpoint and, uniquely
 * among the built-in providers, registers this instance with it.
 *
 * @module
 */
import type { IRuntimeServices, ServiceInstance, Unsubscribe } from '@hono-enterprise/common';
import type { DiscoveryProvider, IDiscoveryHttp, SelfRegistration } from '../interfaces/index.ts';
import { watchConsulService } from './consul-watch.ts';
import { instanceUrl } from '../url/instance-url.ts';

/** One entry of `GET /v1/health/service/:service`. */
interface ConsulHealthEntry {
  readonly Node?: { readonly Address?: string };
  readonly Service?: {
    readonly ID?: string;
    readonly Service?: string;
    readonly Address?: string;
    readonly Port?: number;
    readonly Tags?: readonly string[];
    readonly Meta?: Readonly<Record<string, string>>;
    readonly Weights?: { readonly Passing?: number };
  };
}

/** Constructor options. */
export interface ConsulProviderOptions {
  /** Base URL of the Consul agent. */
  readonly address: string;
  /** ACL token, sent as `X-Consul-Token`. */
  readonly token?: string;
  /** Datacenter, sent as `?dc=`. */
  readonly datacenter?: string;
  /** Blocking-query wait, in seconds. */
  readonly waitSeconds: number;
  /** Whether resolved instances speak TLS. */
  readonly secure?: boolean;
}

/**
 * Reads and registers against a Consul agent.
 *
 * @since 0.2.0
 */
export class ConsulProvider implements DiscoveryProvider {
  /** Backend id. */
  readonly kind = 'consul';

  readonly #http: IDiscoveryHttp;
  readonly #runtime: IRuntimeServices;
  readonly #options: ConsulProviderOptions;
  readonly #base: string;

  /**
   * @param options - Agent address, ACL token, datacenter, and wait
   * @param http - The HTTP seam
   * @param runtime - Supplies timers and `uuid()` for the default instance id
   */
  constructor(
    options: ConsulProviderOptions,
    http: IDiscoveryHttp,
    runtime: IRuntimeServices,
  ) {
    this.#options = options;
    this.#http = http;
    this.#runtime = runtime;
    this.#base = options.address.replace(/\/+$/, '');
  }

  /**
   * Builds the health-read URL.
   *
   * Always sends `passing=true`: self-registration advertises the instance
   * before its socket is bound, and filtering on passing checks is what makes
   * that window harmless for every consumer.
   *
   * @param serviceName - Logical service name
   * @param index - Blocking-query index, omitted for a plain read
   * @returns The absolute URL
   */
  healthUrl(serviceName: string, index?: number): string {
    const params = new URLSearchParams({ passing: 'true' });
    if (this.#options.datacenter !== undefined) {
      params.set('dc', this.#options.datacenter);
    }
    if (index !== undefined) {
      params.set('index', String(index));
      params.set('wait', `${this.#options.waitSeconds}s`);
    }
    return `${this.#base}/v1/health/service/${encodeURIComponent(serviceName)}?${params}`;
  }

  /** Headers every request carries; the ACL header is omitted when unset. */
  headers(): Record<string, string> {
    return this.#options.token !== undefined ? { 'X-Consul-Token': this.#options.token } : {};
  }

  /**
   * Maps a health response body onto instances.
   *
   * @param body - The parsed JSON array
   * @param serviceName - Fallback service name when the entry omits one
   * @returns The mapped instances
   */
  mapEntries(body: unknown, serviceName: string): readonly ServiceInstance[] {
    if (!Array.isArray(body)) {
      return [];
    }
    const instances: ServiceInstance[] = [];
    for (const raw of body as readonly ConsulHealthEntry[]) {
      const service = raw.Service;
      if (service === undefined || service.Port === undefined) {
        continue;
      }
      // Consul returns an EMPTY STRING for a service registered without an
      // explicit address; the node address is the real one. Omitting this
      // fallback yields `http://:8080`.
      const host = service.Address !== undefined && service.Address !== ''
        ? service.Address
        : (raw.Node?.Address ?? '');
      if (host === '') {
        continue;
      }
      instances.push({
        id: service.ID ?? `${host}:${service.Port}`,
        serviceName: service.Service ?? serviceName,
        host,
        port: service.Port,
        secure: this.#options.secure ?? false,
        ...(service.Weights?.Passing !== undefined ? { weight: service.Weights.Passing } : {}),
        ...(service.Tags !== undefined ? { tags: service.Tags } : {}),
        ...(service.Meta !== undefined ? { metadata: service.Meta } : {}),
      });
    }
    return instances;
  }

  async resolve(serviceName: string): Promise<readonly ServiceInstance[]> {
    const response = await this.#http.request(this.healthUrl(serviceName), {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(
        `Consul health read for '${serviceName}' failed with HTTP ${response.status}`,
      );
    }
    return this.mapEntries(JSON.parse(response.text), serviceName);
  }

  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe> {
    return watchConsulService({
      serviceName,
      listener,
      http: this.#http,
      runtime: this.#runtime,
      url: (index) => this.healthUrl(serviceName, index),
      headers: this.headers(),
      map: (body) => this.mapEntries(body, serviceName),
    });
  }

  /**
   * Advertises this instance to the agent.
   *
   * @param registration - What to advertise, with its check already defaulted
   */
  async registerSelf(registration: SelfRegistration): Promise<void> {
    const check = registration.check;
    const body: Record<string, unknown> = {
      ID: this.selfId(registration),
      Name: registration.serviceName,
      Address: registration.address,
      Port: registration.port,
    };
    if (registration.tags !== undefined) {
      body.Tags = registration.tags;
    }
    if (registration.metadata !== undefined) {
      body.Meta = registration.metadata;
    }
    if (check !== undefined) {
      body.Check = {
        HTTP: instanceUrl(
          {
            id: '',
            serviceName: registration.serviceName,
            host: registration.address,
            port: registration.port,
            secure: this.#options.secure ?? false,
          },
          check.httpPath,
        ),
        Interval: `${check.intervalSeconds}s`,
        DeregisterCriticalServiceAfter: `${check.deregisterAfterSeconds}s`,
      };
    }

    const response = await this.#http.request(`${this.#base}/v1/agent/service/register`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Consul registration failed with HTTP ${response.status}`);
    }
  }

  /**
   * Removes this instance from the agent.
   *
   * @param registration - The registration to remove
   */
  async deregisterSelf(registration: SelfRegistration): Promise<void> {
    const id = encodeURIComponent(this.selfId(registration));
    const response = await this.#http.request(
      `${this.#base}/v1/agent/service/deregister/${id}`,
      { method: 'PUT', headers: this.headers() },
    );
    if (!response.ok) {
      throw new Error(`Consul deregistration failed with HTTP ${response.status}`);
    }
  }

  /**
   * The instance id used for both register and deregister.
   *
   * Generated once per registration object rather than per call, because a
   * fresh uuid on deregistration would target an id that was never registered.
   *
   * @param registration - The registration
   * @returns Its stable instance id
   */
  selfId(registration: SelfRegistration): string {
    const existing = this.#selfIds.get(registration);
    if (existing !== undefined) {
      return existing;
    }
    const id = registration.id ?? `${registration.serviceName}-${this.#runtime.uuid()}`;
    this.#selfIds.set(registration, id);
    return id;
  }

  readonly #selfIds = new WeakMap<SelfRegistration, string>();
}
