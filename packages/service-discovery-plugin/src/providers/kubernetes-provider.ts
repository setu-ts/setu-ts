/**
 * `KubernetesProvider` — reads EndpointSlices from the API server.
 *
 * @module
 */
import type { IRuntimeServices, ServiceInstance, Unsubscribe } from '@setu-ts/common';
import type { DiscoveryProvider, IDiscoveryHttp } from '../interfaces/index.ts';
import { DiscoveryUnavailableError } from '../errors.ts';
import { watchKubernetesService } from './kubernetes-watch.ts';

/** Where the projected service-account token is mounted in every pod. */
const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

/**
 * How long a token read from disk is reused.
 *
 * Kubernetes rotates projected service-account tokens roughly hourly, so a
 * token read once at registration stops working while the pod is still
 * healthy — a failure that appears hours after a green deploy. Re-reading per
 * request behind this memo bounds the file I/O to one read a minute.
 */
const TOKEN_TTL_MS = 60_000;

/** One `endpoints[]` entry of an EndpointSlice. */
interface SliceEndpoint {
  readonly addresses?: readonly string[];
  readonly conditions?: { readonly ready?: boolean };
}

/** One `ports[]` entry of an EndpointSlice. */
interface SlicePort {
  readonly name?: string;
  readonly port?: number;
}

/** One EndpointSlice. */
interface EndpointSlice {
  readonly endpoints?: readonly SliceEndpoint[];
  readonly ports?: readonly SlicePort[];
}

/** An EndpointSlice list response. */
interface SliceList {
  readonly items?: readonly EndpointSlice[];
  readonly metadata?: { readonly resourceVersion?: string };
}

/** Constructor options. */
export interface KubernetesProviderOptions {
  /** Namespace the services live in. */
  readonly namespace: string;
  /** API server base URL, already resolved from options or the environment. */
  readonly apiServer: string;
  /** Bearer token used verbatim; absent means read the projected token file. */
  readonly token?: string;
  /** Selects the `ports[]` entry by name. */
  readonly portName?: string;
  /** Whether resolved instances speak TLS. */
  readonly secure?: boolean;
}

/**
 * Reads EndpointSlices for a service.
 *
 * @since 0.2.0
 */
export class KubernetesProvider implements DiscoveryProvider {
  /** Backend id. */
  readonly kind = 'kubernetes';

  readonly #options: KubernetesProviderOptions;
  readonly #http: IDiscoveryHttp;
  readonly #runtime: IRuntimeServices;
  #cachedToken: { value: string; stampMs: number } | null = null;

  /**
   * @param options - Namespace, API server, token, and port selection
   * @param http - The HTTP seam
   * @param runtime - Supplies the monotonic clock, timers, and `fs`
   */
  constructor(
    options: KubernetesProviderOptions,
    http: IDiscoveryHttp,
    runtime: IRuntimeServices,
  ) {
    this.#options = options;
    this.#http = http;
    this.#runtime = runtime;
  }

  /**
   * Builds the EndpointSlice list URL for a service.
   *
   * @param serviceName - Logical service name
   * @param extra - Extra query parameters (the watch adds its own)
   * @returns The absolute URL
   */
  listUrl(serviceName: string, extra?: Readonly<Record<string, string>>): string {
    const params = new URLSearchParams({
      labelSelector: `kubernetes.io/service-name=${serviceName}`,
      ...extra,
    });
    return `${this.#options.apiServer}/apis/discovery.k8s.io/v1/namespaces/` +
      `${encodeURIComponent(this.#options.namespace)}/endpointslices?${params}`;
  }

  /**
   * Resolves the bearer token, reading the projected file when no explicit
   * token was configured.
   *
   * @returns The `Authorization` header value
   */
  async authHeader(): Promise<string> {
    if (this.#options.token !== undefined) {
      return `Bearer ${this.#options.token}`;
    }
    const now = this.#runtime.hrtime();
    if (this.#cachedToken !== null && now - this.#cachedToken.stampMs < TOKEN_TTL_MS) {
      return `Bearer ${this.#cachedToken.value}`;
    }
    // `createProvider` refuses this configuration at startup, but this class is
    // exported, so a caller constructing it directly reaches here. Checking
    // again costs nothing and turns a bare `TypeError` on `undefined.readFile`
    // into the same typed error the factory raises.
    const fs = this.#runtime.fs;
    if (fs === undefined) {
      throw new DiscoveryUnavailableError(
        "The 'kubernetes' discovery provider needs either an explicit token option " +
          'or IRuntimeServices.fs to read the projected service-account token, and ' +
          'this runtime supplies neither.',
      );
    }
    const bytes = await fs.readFile(TOKEN_PATH);
    const value = new TextDecoder().decode(bytes).trim();
    this.#cachedToken = { value, stampMs: now };
    return `Bearer ${value}`;
  }

  /**
   * Maps an EndpointSlice list onto instances.
   *
   * @param body - The parsed list response
   * @param serviceName - The service the slices belong to
   * @returns The mapped instances
   * @throws {DiscoveryUnavailableError} If several ports exist and none was named
   */
  mapSlices(body: unknown, serviceName: string): readonly ServiceInstance[] {
    const list = body as SliceList;
    const items = list.items ?? [];
    const instances: ServiceInstance[] = [];

    for (const slice of items) {
      const port = this.#selectPort(slice.ports ?? [], serviceName);
      if (port === null) {
        continue;
      }
      for (const endpoint of slice.endpoints ?? []) {
        // The API reference states `conditions.ready` nil means TRUE, so
        // treating `undefined` as not-ready would silently discard every
        // endpoint in a slice that omits the field.
        if (endpoint.conditions?.ready === false) {
          continue;
        }
        for (const address of endpoint.addresses ?? []) {
          instances.push({
            id: `${address}:${port}`,
            serviceName,
            host: address,
            port,
            secure: this.#options.secure ?? false,
          });
        }
      }
    }
    return instances;
  }

  async resolve(serviceName: string): Promise<readonly ServiceInstance[]> {
    const response = await this.#http.request(this.listUrl(serviceName), {
      headers: { Authorization: await this.authHeader() },
    });
    if (!response.ok) {
      throw new Error(
        `Kubernetes EndpointSlice list for '${serviceName}' failed with HTTP ${response.status}`,
      );
    }
    return this.mapSlices(JSON.parse(response.text), serviceName);
  }

  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe> {
    return watchKubernetesService({
      serviceName,
      listener,
      http: this.#http,
      runtime: this.#runtime,
      listUrl: (extra) => this.listUrl(serviceName, extra),
      authHeader: () => this.authHeader(),
      map: (body) => this.mapSlices(body, serviceName),
      resourceVersionOf: (body) => (body as SliceList).metadata?.resourceVersion ?? null,
    });
  }

  /**
   * Chooses the port, refusing to guess when several exist.
   *
   * @returns The port, or `null` when the slice declares none
   * @throws {DiscoveryUnavailableError} If several exist and none was named
   */
  #selectPort(ports: readonly SlicePort[], serviceName: string): number | null {
    const declared = ports.filter((entry): entry is SlicePort & { port: number } =>
      entry.port !== undefined
    );
    if (declared.length === 0) {
      return null;
    }
    if (this.#options.portName !== undefined) {
      const named = declared.find((entry) => entry.name === this.#options.portName);
      return named?.port ?? null;
    }
    if (declared.length === 1) {
      return declared[0].port;
    }
    const names = declared.map((entry) => entry.name ?? '<unnamed>').join(', ');
    throw new DiscoveryUnavailableError(
      `Service '${serviceName}' exposes several ports (${names}); ` +
        "set the 'portName' option to choose one.",
    );
  }
}
