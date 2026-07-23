/**
 * Public interfaces/types and the internal provider port for the secrets
 * plugin.
 *
 * @module
 */

/**
 * Supported secret provider backends.
 *
 * - `'env'` — environment variables via `IRuntimeServices.env` (default, zero
 *   dependency, works on every runtime including Cloudflare Workers).
 * - `'aws-kms'` — AWS Secrets Manager (KMS-backed encryption).
 * - `'gcp'` — GCP Secret Manager.
 * - `'azure'` — Azure Key Vault.
 * - `'vault'` — HashiCorp Vault (KV v2, over `fetch`).
 *
 * @since 0.1.0
 */
export type SecretsProviderType = 'env' | 'aws-kms' | 'gcp' | 'azure' | 'vault';

/**
 * Structural shape of an AWS Secrets Manager facade. The plugin never
 * hard-depends on `@aws-sdk/client-secrets-manager`; inject this shape, or the
 * provider lazily loads the SDK and adapts it to this facade.
 *
 * @since 0.1.0
 */
export interface IAwsSecretsClient {
  /**
   * Retrieves a secret string by id.
   *
   * @param secretId - The AWS Secrets Manager secret id
   * @returns The secret string, or `null` when it does not exist
   */
  getSecretValue(secretId: string): Promise<string | null>;
  /**
   * Stores a new value for a secret.
   *
   * @param secretId - The AWS Secrets Manager secret id
   * @param value - The new secret value
   */
  putSecretValue(secretId: string, value: string): Promise<void>;
}

/**
 * Structural shape of a GCP Secret Manager facade (injected or SDK-adapted).
 *
 * @since 0.1.0
 */
export interface IGcpSecretsClient {
  /**
   * Accesses the latest enabled version of a secret.
   *
   * @param name - The secret name (short id; the provider builds the resource path)
   * @returns The secret string, or `null` when it does not exist
   */
  accessSecretVersion(name: string): Promise<string | null>;
  /**
   * Adds a new version to a secret.
   *
   * @param name - The secret name
   * @param value - The new secret value
   */
  addSecretVersion(name: string, value: string): Promise<void>;
}

/**
 * Structural shape of an Azure Key Vault facade (injected or SDK-adapted).
 *
 * @since 0.1.0
 */
export interface IAzureSecretsClient {
  /**
   * Gets a secret's current value.
   *
   * @param name - The Key Vault secret name
   * @returns The secret string, or `null` when it does not exist
   */
  getSecret(name: string): Promise<string | null>;
  /**
   * Sets a secret's value.
   *
   * @param name - The Key Vault secret name
   * @param value - The new secret value
   */
  setSecret(name: string, value: string): Promise<void>;
}

/**
 * A `fetch`-shaped function used by {@linkcode SecretsProviderOptions.http} so
 * the HashiCorp Vault provider stays runtime-agnostic and testable.
 *
 * @since 0.1.0
 */
export type IVaultHttp = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Provider-specific options. Fields are consumed only by the matching
 * provider; unrelated fields are ignored.
 *
 * @since 0.1.0
 */
export interface SecretsProviderOptions {
  /** Read-cache TTL in seconds. `0` disables caching. Default `300`. */
  cacheTtl?: number;
  /** (`env`) Prefix prepended to the derived environment key. */
  prefix?: string;
  /** (`aws-kms`) AWS region for the lazily-loaded client. */
  region?: string;
  /** (`aws-kms`) AWS access key id for the lazily-loaded client. */
  accessKeyId?: string;
  /** (`aws-kms`) AWS secret access key for the lazily-loaded client. */
  secretAccessKey?: string;
  /** (`gcp`) GCP project id used to build secret resource paths. */
  projectId?: string;
  /** (`azure`) Key Vault URL for the lazily-loaded client. */
  vaultUrl?: string;
  /** (`vault`) Vault server address, e.g. `https://vault.example.com`. */
  address?: string;
  /** (`vault`) Vault auth token sent as `X-Vault-Token`. */
  token?: string;
  /** (`vault`) KV v2 mount path. Default `secret`. */
  mount?: string;
  /**
   * (`aws-kms` | `gcp` | `azure`) Injected client facade; bypasses the lazy
   * SDK import. Typed as the union of the three facades — each provider
   * validates the shape it needs.
   */
  client?: IAwsSecretsClient | IGcpSecretsClient | IAzureSecretsClient;
  /** (`vault`) Injected `fetch`-shaped function; defaults to global `fetch`. */
  http?: IVaultHttp;
}

/**
 * Options for the {@linkcode SecretsPlugin} factory.
 *
 * @example
 * ```typescript
 * app.register(SecretsPlugin({ provider: 'vault', options: {
 *   address: 'https://vault.example.com', token: process.env.VAULT_TOKEN,
 * } }));
 * ```
 * @since 0.1.0
 */
export interface SecretsPluginOptions {
  /** Provider backend. Defaults to `'env'`. */
  provider?: SecretsProviderType;
  /** Provider-specific options. */
  options?: SecretsProviderOptions;
}

/**
 * Internal provider port. NOT exported from `src/index.ts` — the committed
 * public contract is `ISecretManager`; providers are an internal seam behind
 * {@linkcode SecretsService}. `get` returns `null` for an absent secret; the
 * service converts `null` to the `ISecretManager.get` throw.
 */
export interface SecretProvider {
  /** Establishes any backing connection/client. No-op for stateless providers. */
  connect(): Promise<void>;
  /** Releases any backing connection/client. No-op for stateless providers. */
  disconnect(): Promise<void>;
  /** Reports whether the provider is ready to serve reads. */
  isReady(): boolean;
  /**
   * Reads a secret.
   *
   * @param name - Secret name/path
   * @returns The value, or `null` when the secret does not exist
   */
  get(name: string): Promise<string | null>;
  /**
   * Writes/rotates a secret.
   *
   * @param name - Secret name/path
   * @param value - The new value
   * @throws {Error} If the provider is read-only (e.g. `EnvProvider`)
   */
  set(name: string, value: string): Promise<void>;
}
