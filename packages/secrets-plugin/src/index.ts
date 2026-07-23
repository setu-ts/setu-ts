/**
 * @module
 *
 * Secret management plugin with environment, AWS Secrets Manager (KMS-backed),
 * GCP Secret Manager, Azure Key Vault, and HashiCorp Vault providers.
 *
 * Exports the plugin factory, service, provider implementations, structural
 * client interfaces, and option types.
 */

// ── Plugin factory ──────────────────────────────────────────────────────────

/**
 * SecretsPlugin factory — registers an {@linkcode ISecretManager} under
 * `CAPABILITIES.SECRETS`.
 */
export { SecretsPlugin } from './plugin/secrets-plugin.ts';

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * SecretsService — wraps a provider with a monotonic-clock read cache.
 */
export { SecretsService } from './services/secrets-service.ts';

/** Options for {@linkcode SecretsService}. */
export type { SecretsServiceOptions } from './services/secrets-service.ts';

// ── Provider implementations ────────────────────────────────────────────────

/** Environment-variable provider (default). */
export { EnvProvider } from './providers/env-provider.ts';

/** AWS Secrets Manager (KMS-backed) provider. */
export { AwsKmsProvider } from './providers/aws-kms.ts';

/** GCP Secret Manager provider. */
export { GcpSecretManagerProvider } from './providers/gcp-secret-manager.ts';

/** Azure Key Vault provider. */
export { AzureKeyVaultProvider } from './providers/azure-key-vault.ts';

/** HashiCorp Vault (KV v2) provider. */
export { HashiCorpVaultProvider } from './providers/vault.ts';

// ── Provider option types ───────────────────────────────────────────────────

/** Options for {@linkcode AwsKmsProvider}. */
export type { AwsKmsProviderOptions } from './providers/aws-kms.ts';

/** Options for {@linkcode GcpSecretManagerProvider}. */
export type { GcpSecretManagerProviderOptions } from './providers/gcp-secret-manager.ts';

/** Options for {@linkcode AzureKeyVaultProvider}. */
export type { AzureKeyVaultProviderOptions } from './providers/azure-key-vault.ts';

/** Options for {@linkcode HashiCorpVaultProvider}. */
export type { HashiCorpVaultProviderOptions } from './providers/vault.ts';

// ── Public types ────────────────────────────────────────────────────────────

/** Options for the SecretsPlugin factory. */
export type { SecretsPluginOptions } from './interfaces/index.ts';

/** Supported provider backend types. */
export type { SecretsProviderType } from './interfaces/index.ts';

/** Provider-specific options. */
export type { SecretsProviderOptions } from './interfaces/index.ts';

/** Structural shape of an injected AWS Secrets Manager client facade. */
export type { IAwsSecretsClient } from './interfaces/index.ts';

/** Structural shape of an injected GCP Secret Manager client facade. */
export type { IGcpSecretsClient } from './interfaces/index.ts';

/** Structural shape of an injected Azure Key Vault client facade. */
export type { IAzureSecretsClient } from './interfaces/index.ts';

/** A `fetch`-shaped function for the HashiCorp Vault provider. */
export type { IVaultHttp } from './interfaces/index.ts';

// ── Re-exported from @hono-enterprise/common ────────────────────────────────

/**
 * The committed secret manager contract (get, has, rotate).
 */
export type { ISecretManager } from '@hono-enterprise/common';
