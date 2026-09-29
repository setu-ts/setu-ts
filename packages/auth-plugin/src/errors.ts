/**
 * Configuration errors raised by the authentication plugin.
 *
 * @module
 */

/**
 * Thrown when AuthPlugin is configured without a usable passive
 * authentication strategy or with an invalid middleware priority.
 *
 * The error is exported so startup code can distinguish an authentication
 * configuration failure from an unrelated application boot failure.
 *
 * @since 0.9.0
 */
export class AuthPluginConfigurationError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'AuthPluginConfigurationError';

  /**
   * @param message - The invalid configuration and how to correct it
   */
  constructor(message: string) {
    super(message);
  }
}
