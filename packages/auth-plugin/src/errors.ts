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
 * @since 0.8.0
 */
export class AuthPluginConfigurationError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'AuthPluginConfigurationError';

  /**
   * Creates an authentication plugin configuration error.
   *
   * @param message - The invalid configuration and how to correct it
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown from `register()` when a `saml` sign-in provider is configured and
 * the SAML library cannot be loaded — at startup, never at the first login.
 *
 * The message names the specifier and, because neither SAML library bundles
 * without it, the Cloudflare Workers `nodejs_compat` compatibility flag. The
 * underlying failure is attached as `cause`.
 *
 * @since 0.8.0
 */
export class SamlRuntimeLoadError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'SamlRuntimeLoadError';

  /**
   * Creates a SAML library load error.
   *
   * @param specifier - The module specifier that failed to load
   * @param cause - The underlying failure
   */
  constructor(specifier: string, cause?: unknown) {
    super(
      `auth-plugin: a saml sign-in provider needs '${specifier}', which could not be loaded. ` +
        "Install it, or inject it through the provider's module option. On Cloudflare Workers " +
        'enable the nodejs_compat compatibility flag, without which it cannot bundle.',
      cause === undefined ? undefined : { cause },
    );
  }
}
