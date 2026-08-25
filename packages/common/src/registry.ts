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
 * No-argument: the registry holds the factory and calls it with nothing when
 * the token is first resolved. Do not confuse with {@linkcode RegistryFactory},
 * which takes the {@linkcode IServiceRegistry} as its one argument — the two
 * differ in arity and are not interchangeable.
 *
 * @typeParam T - The service type produced
 * @since 0.1.0
 */
export type ServiceFactory<T> = () => T;

/**
 * A factory that constructs a registry entry from the service registry.
 *
 * This is the "factory arm" of a registration option: an entry that is a
 * function is called — once, at the `onInit` phase — with the application's
 * {@linkcode IServiceRegistry}, and its return value is the instance the
 * option would have accepted. It exists so a generated artifact (a command
 * handler, event handler, or health indicator) can reach a capability — the
 * event bus, the logger, the database — that its contract's single message
 * parameter cannot carry.
 *
 * The argument is named `services` at every call site. It is deliberately the
 * registry and nothing narrower: everything a generated artifact could want is
 * reachable through it under a `CAPABILITIES` token, and a narrower context
 * would ship with no in-repo reader.
 *
 * Do not confuse with {@linkcode ServiceFactory}: that is a no-argument lazy
 * factory the registry invokes on first lookup, whereas this takes the
 * registry as its one argument and is invoked by a plugin's `onInit` hook.
 *
 * @typeParam T - The instance type produced
 * @since 0.1.0
 */
export type RegistryFactory<T> = (services: IServiceRegistry) => T;

/**
 * Maps capability tokens to service instances.
 *
 * The registry is the framework's primary service resolution mechanism; the
 * optional DI container is a convenience layer on top of it. The application
 * registry is sealed after `runBootstrap()`; request-scoped services are
 * registered on the request context instead.
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
   * @throws {Error} If called after the application has run `runBootstrap()`
   * @remarks `override: true` is reported through the logger capability.
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
   * @throws {Error} If called after the application has run `runBootstrap()`
   * @remarks `override: true` is reported through the logger capability.
   */
  registerFactory<T extends object>(
    token: CapabilityToken,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void;

  /**
   * Resolves a service by capability token.
   *
   * On a multi-provider token this returns the FIRST registered provider; use
   * {@linkcode IServiceRegistry.getAll} to reach all of them.
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
   * Removes a registration. On a multi-provider token this removes EVERY
   * provider registered under it, not just the first.
   *
   * @param token - The capability token to remove
   * @returns `true` if a registration was removed
   * @throws {Error} If called after the application has run `runBootstrap()`
   * @remarks A successful unregister is reported through the logger
   * capability. Prefer `register(token, service, { override: true })` for a
   * replacement during bootstrap.
   */
  unregister(token: CapabilityToken): boolean;
}

/**
 * Resolves one entry of a registration option that accepts either an instance
 * or a {@linkcode RegistryFactory}.
 *
 * A non-function entry is returned unchanged — the instance arm is
 * byte-identical to the pre-factory behaviour. A function entry is called
 * once with `services`, and its return value is the result. A throw from the
 * factory is wrapped in an `Error` whose message names `label` and whose
 * `cause` is the original, so a factory that resolves a capability the
 * application forgot to register fails `start()` naming the option and the
 * entry rather than escaping with a bare registry message.
 *
 * The discrimination is `typeof entry === 'function'`: no instance of any
 * registration contract is callable, and a class — the one shape that is a
 * function and not a factory — is not assignable to `RegistryFactory<T>`, so
 * passing one is a compile error rather than a runtime `TypeError`.
 *
 * @typeParam T - The instance type the option accepts
 * @param entry - An instance or a factory producing one
 * @param services - The registry handed to a factory
 * @param label - A human-readable name of the option and entry, for error attribution
 * @returns The resolved instance
 * @throws {Error} If a factory entry throws; the message names `label` and the
 * `cause` is the original error
 * @since 0.1.0
 */
export function resolveRegistryEntry<T>(
  entry: T | RegistryFactory<T>,
  services: IServiceRegistry,
  label: string,
): T {
  if (typeof entry === 'function') {
    try {
      return (entry as RegistryFactory<T>)(services);
    } catch (cause) {
      throw new Error(`Failed to resolve ${label}: ${causeMessage(cause)}`, { cause });
    }
  }
  return entry;
}

/**
 * Extracts a message from an unknown thrown value.
 *
 * @param cause - The value a factory threw
 * @returns The message, or a stable fallback when the value is not an `Error`
 */
function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
