/**
 * Secret management contract, fulfilled by the SecretsPlugin under
 * `CAPABILITIES.SECRETS`.
 *
 * @module
 */

/**
 * Secret manager backed by a provider (AWS KMS, GCP Secret Manager, Azure
 * Key Vault, HashiCorp Vault, or environment variables in development).
 *
 * Secrets must never be logged; the logger redacts known secret fields
 * (AI_GUIDELINES §13.3).
 *
 * @example
 * ```typescript
 * const secrets = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
 * const dbPassword = await secrets.get('database/password');
 * ```
 * @since 0.1.0
 */
export interface ISecretManager {
  /**
   * Retrieves a secret.
   *
   * @param name - Secret name (provider-specific path syntax)
   * @returns The secret value
   * @throws {Error} If the secret does not exist or access is denied
   */
  get(name: string): Promise<string>;
  /**
   * Reports whether a secret exists.
   *
   * @param name - Secret name
   * @returns `true` if the secret exists and is accessible
   */
  has(name: string): Promise<boolean>;
  /**
   * Rotates a secret to a new value.
   *
   * @param name - Secret name
   * @param value - The new secret value
   */
  rotate(name: string, value: string): Promise<void>;
}
