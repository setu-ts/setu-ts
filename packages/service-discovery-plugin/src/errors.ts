/**
 * Errors the service discovery plugin throws.
 *
 * @module
 */

/**
 * Discovery could not answer.
 *
 * Thrown when a backend read fails with nothing cached to fall back on, when
 * the DNS provider is configured on a runtime with no resolver, and when a
 * Kubernetes service exposes several ports and none was named.
 *
 * @since 0.2.0
 */
export class DiscoveryUnavailableError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'DiscoveryUnavailableError';

  /**
   * @param message - What could not be answered, and why
   * @param options - Standard error options; pass the backend failure as `cause`
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * `selfRegistration` was configured against a provider that cannot register.
 *
 * Only Consul has an agent API to register against. A static list has nothing
 * to register with, the Kubernetes control plane owns Endpoint membership, and
 * DNS records are zone data — honoring the option on any of them would be a
 * silent no-op, so it fails at `register()` instead.
 *
 * @since 0.2.0
 */
export class SelfRegistrationNotSupportedError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'SelfRegistrationNotSupportedError';

  /**
   * @param provider - The configured provider arm
   */
  constructor(provider: string) {
    super(
      `selfRegistration is not supported by the '${provider}' discovery provider. ` +
        "Only 'consul' can register this instance; the other providers have no " +
        'registration API, so the option would be silently ignored.',
    );
  }
}
