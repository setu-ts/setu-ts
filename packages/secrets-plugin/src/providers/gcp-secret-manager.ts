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
  SecretManagerServiceClient: new () => {
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
 * @param mod - The GCP SDK module (real or fake)
 * @param projectId - GCP project id (required for resource paths)
 * @returns The facade wrapping a `SecretManagerServiceClient`
 * @throws {Error} If the project id is missing
 */
export function adaptGcpModule(
  mod: GcpSdkModule,
  projectId: string | undefined,
): IGcpSecretsClient {
  if (projectId === undefined || projectId === '') {
    throw new Error('GcpSecretManagerProvider requires options.projectId');
  }
  const client = new mod.SecretManagerServiceClient();
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
      return;
    }
    this.#client = adaptGcpModule(await loadGcpModule(), this.#options.projectId);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
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
