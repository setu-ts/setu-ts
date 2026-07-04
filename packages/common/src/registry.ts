/**
 * Service registry contract — the primary service resolution mechanism.
 * Plugins publish capabilities into the registry and resolve capabilities
 * provided by other plugins, without ever importing each other.
 *
 * @module
 */
import type { CapabilityToken } from './tokens.ts';

/**
 * Options accepted when registering a service.
 *
 * @since 0.1.0
 */
export interface RegisterOptions {
  /**
   * Replace an existing registration. Without this flag, registering an
   * already-registered token throws.
   */
  readonly override?: boolean;
  /**
   * Allow multiple providers for the same token; consumers retrieve them
   * with {@linkcode IServiceRegistry.getAll}.
   */
  readonly multi?: boolean;
}

/**
 * A factory invoked lazily on the first lookup of a token registered with
 * {@linkcode IServiceRegistry.registerFactory}.
 *
 * @typeParam T - The service type produced
 * @since 0.1.0
 */
export type ServiceFactory<T> = () => T;

/**
 * Maps capability tokens to service instances.
 *
 * The registry is the framework's primary service resolution mechanism; the
 * optional DI container is a convenience layer on top of it. Registration
 * must happen during the bootstrap phase — never during request processing
 * (request-scoped services are registered on the request context instead).
 *
 * @example
 * ```typescript
 * // Provider plugin
 * ctx.services.register(CAPABILITIES.CACHE, new RedisCacheStore(options));
 *
 * // Consumer plugin
 * const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
 * ```
 * @since 0.1.0
 */
export interface IServiceRegistry {
  /**
   * Registers a service instance under a capability token.
   *
   * @typeParam T - The service type
   * @param token - The capability token to register under
   * @param service - The service instance
   * @param options - Override and multi-provider behavior
   * @throws {Error} If the token is already registered and neither
   * `override` nor `multi` is set
   */
  register<T extends object>(token: CapabilityToken, service: T, options?: RegisterOptions): void;

  /**
   * Registers a lazy factory: the service is instantiated on first
   * {@linkcode get} and cached for subsequent lookups.
   *
   * @typeParam T - The service type
   * @param token - The capability token to register under
   * @param factory - Factory invoked once, on first lookup
   * @param options - Override and multi-provider behavior
   * @throws {Error} If the token is already registered and neither
   * `override` nor `multi` is set
   */
  registerFactory<T extends object>(
    token: CapabilityToken,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void;

  /**
   * Resolves a service by capability token.
   *
   * @typeParam T - The expected service type
   * @param token - The capability token to resolve
   * @returns The registered service
   * @throws {Error} If no service is registered for the token
   */
  get<T extends object>(token: CapabilityToken): T;

  /**
   * Resolves every provider registered for a multi-provider token.
   *
   * @typeParam T - The expected service type
   * @param token - The capability token to resolve
   * @returns All registered providers, in registration order; empty when none
   */
  getAll<T extends object>(token: CapabilityToken): readonly T[];

  /**
   * Reports whether a capability is available.
   *
   * @param token - The capability token to look up
   * @returns `true` if at least one provider is registered
   */
  has(token: CapabilityToken): boolean;

  /**
   * Removes a registration.
   *
   * @param token - The capability token to remove
   * @returns `true` if a registration was removed
   */
  unregister(token: CapabilityToken): boolean;
}
