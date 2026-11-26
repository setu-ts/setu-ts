/**
 * GcpSecretManagerProvider — retrieves and rotates secrets in GCP Secret
 * Manager. The `@google-cloud/secret-manager` SDK is never a hard dependency:
 * inject an {@linkcode IGcpSecretsClient} facade, or the provider lazily
 * imports and adapts the SDK.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { IGcpSecretsClient, SecretProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';
import type { SecretsDeadline } from './bounded-call.ts';
import {
  answered,
  resolveSecretsDeadline,
  runSecretsCall,
  toSecretsError,
} from './bounded-call.ts';

/** Provider name carried on its errors. */
const PROVIDER_NAME = 'GcpSecretManagerProvider';

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
    accessSecretVersion(
      request: { name: string },
      options?: { timeout?: number },
    ): Promise<[GcpAccessResponse]>;
    addSecretVersion(
      request: { parent: string; payload: { data: Uint8Array } },
      options?: { timeout?: number },
    ): Promise<unknown>;
    listSecrets(
      request: { parent: string; pageSize: number },
      options?: { timeout?: number; autoPaginate?: boolean },
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
  /**
   * Bound on each Secret Manager call, in milliseconds, including gax's own
   * retries; also passed to gax as the call `timeout`. A call that fails on
   * the network, is `UNAVAILABLE` or `DEADLINE_EXCEEDED`, or does not answer in
   * time rejects with `SecretProviderUnavailableError` (`503`). `0` disables
   * the bound; anything outside `0`–`2147483647` throws `RangeError` at
   * construction.
   *
   * @default 5000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /**
   * Timer surface the bound runs on. `SecretsPlugin` supplies the runtime's
   * timers; a directly constructed provider falls back to the ambient ones.
   *
   * @since 0.14.0
   */
  timing?: DeadlineOptions['timing'];
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
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === GRPC_NOT_FOUND
  );
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
  deadline: SecretsDeadline = resolveSecretsDeadline(options.requestTimeoutMs, options.timing),
): IGcpSecretsClient {
  const projectId = options.projectId;
  if (projectId === undefined || projectId === '') {
    throw new Error('GcpSecretManagerProvider requires options.projectId');
  }
  const client = new mod.SecretManagerServiceClient(buildGcpClientOptions(options.endpoint));
  // gax takes no abort signal: it gets the bound as its own call `timeout`
  // (which cancels the gRPC call), and the deadline races the call as well.
  const callOptions = deadline.timeoutMs === 0 ? {} : { timeout: deadline.timeoutMs };
  const bounded = <T>(run: () => Promise<T>): Promise<T> =>
    runSecretsCall(deadline, PROVIDER_NAME, run);
  return {
    async accessSecretVersion(name: string): Promise<string | null> {
      try {
        const [res] = await bounded(() =>
          client.accessSecretVersion(
            { name: `projects/${projectId}/secrets/${name}/versions/latest` },
            callOptions,
          ),
        );
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
      await bounded(() =>
        client.addSecretVersion(
          {
            parent: `projects/${projectId}/secrets/${name}`,
            payload: { data: new TextEncoder().encode(value) },
          },
          callOptions,
        ),
      );
    },
    // Non-mutating: lists at most one secret's metadata, never a value.
    isHealthy(): Promise<boolean> {
      return answered(() =>
        bounded(() =>
          client.listSecrets(
            { parent: `projects/${projectId}`, pageSize: 1 },
            { ...callOptions, autoPaginate: false },
          ),
        ),
      );
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
 * @throws {Error} If `@google-cloud/secret-manager` cannot be resolved
 */
export async function loadGcpModule(): Promise<GcpSdkModule> {
  try {
    return (await import('@google-cloud/secret-manager')) as unknown as GcpSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@google-cloud/secret-manager', {
      requiredBy: '@setu-ts/secrets-plugin',
      cause: error,
    });
  }
}

/**
 * GCP Secret Manager provider.
 *
 * @since 0.1.0
 */
export class GcpSecretManagerProvider implements SecretProvider {
  #client: IGcpSecretsClient | null = null;
  /** `true` when the client was injected: its calls are bounded here, by race. */
  #injected = false;
  readonly #options: GcpSecretManagerProviderOptions;
  readonly #deadline: SecretsDeadline;
  /**
   * Reachability probe. The lazily adapted client lists at most one secret's
   * metadata (`listSecrets`, non-mutating) and reads reachable when Secret
   * Manager answers at all; an injected facade publishes its own `isHealthy`
   * when it has one, and the indicator reports `reachable: 'unknown'` when it
   * does not.
   *
   * @since 0.5.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - GCP connection/injection options
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(options?: GcpSecretManagerProviderOptions) {
    this.#options = options ?? {};
    this.#deadline = resolveSecretsDeadline(this.#options.requestTimeoutMs, this.#options.timing);
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
      this.#injected = true;
    } else {
      this.#client = adaptGcpModule(await loadGcpModule(), this.#options, this.#deadline);
      this.#injected = false;
    }
    this.#attachProbe(this.#client);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Exposes the client's optional probe, called through its OWNER so a facade
   * reading instance state still resolves.
   *
   * @param client - The resolved client
   */
  #attachProbe(client: IGcpSecretsClient): void {
    // Captured into a local before the guard so the closure keeps the
    // narrowed function type and still calls through the owner.
    const probe = client.isHealthy;
    if (typeof probe === 'function') {
      this.isHealthy = (): Promise<boolean> => probe.call(client);
    }
  }

  /** Runs one client call, bounded here for an injected client, and classifies it. */
  async #call<T>(operation: string, run: (client: IGcpSecretsClient) => Promise<T>): Promise<T> {
    const client = this.#client;
    if (client === null) throw new Error('GcpSecretManagerProvider is not connected');
    try {
      return this.#injected
        ? await runSecretsCall(this.#deadline, PROVIDER_NAME, () => run(client))
        : await run(client);
    } catch (error) {
      throw toSecretsError(error, PROVIDER_NAME, operation);
    }
  }

  /**
   * Reads the latest version of a secret.
   *
   * @param name - The secret name
   * @returns The value, or `null` when absent
   * @throws {SecretProviderUnavailableError} When Secret Manager cannot be
   *   reached or does not answer within `requestTimeoutMs`
   */
  get(name: string): Promise<string | null> {
    return this.#call('get', (client) => client.accessSecretVersion(name));
  }

  /**
   * Adds a new version to a secret.
   *
   * @param name - The secret name
   * @param value - The new value
   * @throws {SecretProviderUnavailableError} When Secret Manager cannot be
   *   reached or does not answer within `requestTimeoutMs`
   */
  set(name: string, value: string): Promise<void> {
    return this.#call('set', (client) => client.addSecretVersion(name, value));
  }
}
