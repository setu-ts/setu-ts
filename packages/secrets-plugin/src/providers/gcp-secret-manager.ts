/**
 * GcpSecretManagerProvider — retrieves and rotates secrets in GCP Secret
 * Manager. The `@google-cloud/secret-manager` SDK is never a hard dependency:
 * inject an {@linkcode IGcpSecretsClient} facade, or the provider lazily
 * imports and adapts the SDK.
 *
 * @module
 */
import type { IGcpSecretsClient, SecretProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

/** Methods an injected GCP client facade must expose. */
const REQUIRED_METHODS = ['accessSecretVersion', 'addSecretVersion'] as const;

/** gRPC status code signalling an absent resource. */
const GRPC_NOT_FOUND = 5;

/** A GCP access response. */
interface GcpAccessResponse {
  payload?: { data?: string | Uint8Array | null | undefined } | undefined;
}

/** The subset of the GCP SDK the adapter uses. */
export interface GcpSdkModule {
  SecretManagerServiceClient: new (options?: Record<string, unknown>) => {
    accessSecretVersion(request: { name: string }): Promise<[GcpAccessResponse]>;
    addSecretVersion(
      request: { parent: string; payload: { data: Uint8Array } },
    ): Promise<unknown>;
  };
}

/**
 * Options for {@linkcode GcpSecretManagerProvider}.
 *
 * @since 0.1.0
 */
export interface GcpSecretManagerProviderOptions {
  /** GCP project id used to build secret resource paths. */
  projectId?: string | undefined;
  /**
   * Endpoint for the lazily-loaded client — a private or regional endpoint,
   * written as `host` or `host:port` (`[::1]:8443` for IPv6), with NO URL
   * scheme. The host is passed to the SDK as `apiEndpoint`, the member its
   * `ClientOptions` declares, and a port as `port` (default 443). The SDK
   * always speaks TLS through this option, so a plaintext emulator is not
   * reachable with it — inject a `client` for that. Ignored when a `client`
   * is injected.
   *
   * @since 0.8.0
   */
  endpoint?: string | undefined;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IGcpSecretsClient | undefined;
}

/**
 * Validates that an injected object matches {@linkcode IGcpSecretsClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 */
export function validateGcpClient(client: unknown): client is IGcpSecretsClient {
  return hasMethods(client, REQUIRED_METHODS);
}

/** Reports whether a caught error is a gRPC NOT_FOUND. */
export function isGcpNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === GRPC_NOT_FOUND;
}

/**
 * Adapts the GCP SDK module to the facade. Pure — unit-tested with a fake
 * module.
 *
 * The `endpoint` option is TRANSLATED, not forwarded: google-gax's
 * `ClientOptions` declares `apiEndpoint` and has no `endpoint` member, and its
 * `ClientStubOptions` index signature would let a verbatim `endpoint`
 * type-check and be ignored at runtime — the client would then talk to the
 * production endpoint with no diagnostic.
 *
 * @param mod - The GCP SDK module (real or fake)
 * @param options - GCP connection options
 * @returns The facade wrapping a `SecretManagerServiceClient`
 * @throws {Error} If the project id is missing, or the endpoint is malformed
 */
export function adaptGcpModule(
  mod: GcpSdkModule,
  options: GcpSecretManagerProviderOptions,
): IGcpSecretsClient {
  const projectId = options.projectId;
  if (projectId === undefined || projectId === '') {
    throw new Error('GcpSecretManagerProvider requires options.projectId');
  }
  const client = new mod.SecretManagerServiceClient(
    buildGcpClientOptions(options.endpoint),
  );
  return {
    async accessSecretVersion(name: string): Promise<string | null> {
      try {
        const [res] = await client.accessSecretVersion({
          name: `projects/${projectId}/secrets/${name}/versions/latest`,
        });
        const data = res.payload?.data;
        if (data === null || data === undefined) {
          return null;
        }
        return typeof data === 'string' ? data : new TextDecoder().decode(data);
      } catch (error) {
        if (isGcpNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async addSecretVersion(name: string, value: string): Promise<void> {
      await client.addSecretVersion({
        parent: `projects/${projectId}/secrets/${name}`,
        payload: { data: new TextEncoder().encode(value) },
      });
    },
  };
}

/** `host`, `host:port`, `[v6]` or `[v6]:port` — nothing else. */
const GCP_ENDPOINT = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/?#[\]@]+)(?::(\d{1,5}))?$/;

/**
 * Builds the `SecretManagerServiceClient` constructor argument without
 * assigning `undefined` to optional fields (required by `exactOptionalPropertyTypes`).
 *
 * The endpoint is SPLIT, not forwarded whole: google-gax builds the address
 * as `servicePath + ':' + port`, so a verbatim `localhost:8085` becomes
 * `localhost:8085:443` and a URL becomes `http://…:443` — neither reachable,
 * and neither reported until the first call. A scheme, path or malformed port
 * is refused here instead, naming the value.
 *
 * @throws {Error} If the endpoint is not `host` or `host:port`
 */
function buildGcpClientOptions(endpoint?: string): Record<string, unknown> | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  const match = GCP_ENDPOINT.exec(endpoint);
  const port = match?.[2] === undefined ? undefined : Number(match[2]);
  if (match === null || (port !== undefined && (port < 1 || port > 65535))) {
    throw new Error(
      `GcpSecretManagerProvider options.endpoint must be 'host' or 'host:port' with no URL ` +
        `scheme; got '${endpoint}'`,
    );
  }
  return port === undefined ? { apiEndpoint: match[1] } : { apiEndpoint: match[1], port };
}

/**
 * Lazily imports the GCP Secret Manager SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If `npm:@google-cloud/secret-manager` cannot be resolved
 */
export async function loadGcpModule(): Promise<GcpSdkModule> {
  return await import('npm:@google-cloud/secret-manager@^5') as unknown as GcpSdkModule;
}

/**
 * GCP Secret Manager provider.
 *
 * @since 0.1.0
 */
export class GcpSecretManagerProvider implements SecretProvider {
  #client: IGcpSecretsClient | null = null;
  readonly #options: GcpSecretManagerProviderOptions;
  /**
   * Reachability probe, present only when the resolved client supplies one
   * (M90b). The GCP SDK facade has no non-mutating probe of its own, so the
   * adapted (lazy) path stays `undefined` and the indicator reports
   * `reachable: 'unknown'`; an injected facade that exposes `isHealthy`
   * publishes real reachability.
   *
   * @since 0.5.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - GCP connection/injection options
   */
  constructor(options?: GcpSecretManagerProviderOptions) {
    this.#options = options ?? {};
  }

  async connect(): Promise<void> {
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateGcpClient(injected)) {
        throw new Error(
          'Injected GCP client is missing required methods (accessSecretVersion, addSecretVersion)',
        );
      }
      this.#client = injected;
      this.#attachProbe(injected);
      return;
    }
    this.#client = adaptGcpModule(await loadGcpModule(), this.#options);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Exposes the injected facade's optional probe, called through its OWNER
   * so a facade reading instance state still resolves.
   *
   * @param client - The validated injected facade
   */
  #attachProbe(client: IGcpSecretsClient): void {
    // Captured into a local before the guard so the closure keeps the
    // narrowed function type and still calls through the owner.
    const probe = client.isHealthy;
    if (typeof probe === 'function') {
      this.isHealthy = (): Promise<boolean> => probe.call(client);
    }
  }

  /**
   * Reads a secret from GCP Secret Manager.
   *
   * @param name - The secret short name
   * @returns The value, or `null` when absent
   */
  get(name: string): Promise<string | null> {
    if (this.#client === null) {
      return Promise.reject(new Error('GcpSecretManagerProvider is not connected'));
    }
    return this.#client.accessSecretVersion(name);
  }

  /**
   * Adds a new secret version.
   *
   * @param name - The secret short name
   * @param value - The new value
   */
  set(name: string, value: string): Promise<void> {
    if (this.#client === null) {
      return Promise.reject(new Error('GcpSecretManagerProvider is not connected'));
    }
    return this.#client.addSecretVersion(name, value);
  }
}
