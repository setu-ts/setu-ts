/**
 * AzureKeyVaultProvider — retrieves and rotates secrets in Azure Key Vault.
 * The `@azure/keyvault-secrets` / `@azure/identity` SDKs are never hard
 * dependencies: inject an {@linkcode IAzureSecretsClient} facade, or the
 * provider lazily imports and adapts the SDK.
 *
 * @module
 */
import type { IAzureSecretsClient, SecretProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

/** Methods an injected Azure client facade must expose. */
const REQUIRED_METHODS = ['getSecret', 'setSecret'] as const;

/** HTTP status signalling an absent secret. */
const HTTP_NOT_FOUND = 404;

/** A minimal token credential. */
type AzureCredential = object;

/** The subset of the Azure SDKs the adapter uses. */
export interface AzureSdkModule {
  SecretClient: new (vaultUrl: string, credential: AzureCredential) => {
    getSecret(name: string): Promise<{ value?: string | undefined }>;
    setSecret(name: string, value: string): Promise<unknown>;
  };
  DefaultAzureCredential: new () => AzureCredential;
}

/**
 * Options for {@linkcode AzureKeyVaultProvider}.
 *
 * @since 0.1.0
 */
export interface AzureKeyVaultProviderOptions {
  /** Key Vault URL for the lazily-loaded client. */
  vaultUrl?: string | undefined;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IAzureSecretsClient | undefined;
}

/**
 * Validates that an injected object matches {@linkcode IAzureSecretsClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 */
export function validateAzureClient(client: unknown): client is IAzureSecretsClient {
  return hasMethods(client, REQUIRED_METHODS);
}

/** Reports whether a caught error is an HTTP 404. */
export function isAzureNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { statusCode?: unknown }).statusCode === HTTP_NOT_FOUND;
}

/**
 * Adapts the Azure SDK module to the facade. Pure — unit-tested with a fake
 * module.
 *
 * @param mod - The Azure SDK module (real or fake)
 * @param vaultUrl - The Key Vault URL (required)
 * @returns The facade wrapping a `SecretClient`
 * @throws {Error} If the vault URL is missing
 */
export function adaptAzureModule(
  mod: AzureSdkModule,
  vaultUrl: string | undefined,
): IAzureSecretsClient {
  if (vaultUrl === undefined || vaultUrl === '') {
    throw new Error('AzureKeyVaultProvider requires options.vaultUrl');
  }
  const client = new mod.SecretClient(vaultUrl, new mod.DefaultAzureCredential());
  return {
    async getSecret(name: string): Promise<string | null> {
      try {
        const secret = await client.getSecret(name);
        return secret.value ?? null;
      } catch (error) {
        if (isAzureNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    async setSecret(name: string, value: string): Promise<void> {
      await client.setSecret(name, value);
    },
  };
}

/**
 * Lazily imports the Azure Key Vault + Identity SDKs. Only exercised on the
 * lazy path.
 *
 * @returns The combined SDK module
 * @throws {Error} If the packages cannot be resolved
 */
export async function loadAzureModule(): Promise<AzureSdkModule> {
  const [secretsMod, identityMod] = await Promise.all([
    import('npm:@azure/keyvault-secrets@^4'),
    import('npm:@azure/identity@^4'),
  ]);
  return {
    SecretClient: secretsMod.SecretClient,
    DefaultAzureCredential: identityMod.DefaultAzureCredential,
  } as unknown as AzureSdkModule;
}

/**
 * Azure Key Vault provider.
 *
 * @since 0.1.0
 */
export class AzureKeyVaultProvider implements SecretProvider {
  #client: IAzureSecretsClient | null = null;
  readonly #options: AzureKeyVaultProviderOptions;

  /**
   * @param options - Azure connection/injection options
   */
  constructor(options?: AzureKeyVaultProviderOptions) {
    this.#options = options ?? {};
  }

  async connect(): Promise<void> {
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAzureClient(injected)) {
        throw new Error(
          'Injected Azure client is missing required methods (getSecret, setSecret)',
        );
      }
      this.#client = injected;
      return;
    }
    this.#client = adaptAzureModule(await loadAzureModule(), this.#options.vaultUrl);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Reads a secret from Azure Key Vault.
   *
   * @param name - The secret name
   * @returns The value, or `null` when absent
   */
  get(name: string): Promise<string | null> {
    if (this.#client === null) {
      return Promise.reject(new Error('AzureKeyVaultProvider is not connected'));
    }
    return this.#client.getSecret(name);
  }

  /**
   * Sets a secret's value.
   *
   * @param name - The secret name
   * @param value - The new value
   */
  set(name: string, value: string): Promise<void> {
    if (this.#client === null) {
      return Promise.reject(new Error('AzureKeyVaultProvider is not connected'));
    }
    return this.#client.setSecret(name, value);
  }
}
