/**
 * Optional dependency injection container contract, fulfilled by the
 * DiPlugin. The service registry remains the primary resolution mechanism;
 * this container is a convenience layer for constructor injection and
 * lifecycle management. No plugin may require it.
 *
 * @module
 */

/**
 * A constructable class reference.
 *
 * @typeParam T - The instance type
 * @since 0.1.0
 */
export type Constructor<T = unknown> = new (...args: never[]) => T;

/**
 * Service lifecycle scopes.
 *
 * - `singleton` — one instance for the application lifetime (default)
 * - `scoped` — one instance per request scope
 * - `transient` — a new instance per resolution
 *
 * @since 0.1.0
 */
export type ServiceScope = 'singleton' | 'scoped' | 'transient';

/**
 * Provides a service by constructing a class, injecting the listed tokens
 * as constructor arguments.
 *
 * @typeParam T - The service type
 * @since 0.1.0
 */
export interface ClassProvider<T> {
  /** The class to instantiate. */
  readonly useClass: Constructor<T>;
  /** Tokens resolved and passed as constructor arguments, in order. */
  readonly inject?: readonly string[];
}

/**
 * Provides a service via a factory function.
 *
 * @typeParam T - The service type
 * @since 0.1.0
 */
export interface FactoryProvider<T> {
  /** Factory invoked to produce the instance. */
  readonly useFactory: () => T;
}

/**
 * Provides a pre-built value.
 *
 * @typeParam T - The service type
 * @since 0.1.0
 */
export interface ValueProvider<T> {
  /** The value to provide. */
  readonly useValue: T;
}

/**
 * Any provider form accepted by {@linkcode IContainer.register}.
 *
 * @typeParam T - The service type
 * @since 0.1.0
 */
export type Provider<T> = ClassProvider<T> | FactoryProvider<T> | ValueProvider<T>;

/**
 * Options accepted when registering a provider.
 *
 * @since 0.1.0
 */
export interface ProviderOptions {
  /** Lifecycle scope (defaults to the container's default scope). */
  readonly scope?: ServiceScope;
}

/**
 * Dependency injection container.
 *
 * @example
 * ```typescript
 * const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
 * container.register('UserService', {
 *   useClass: UserService,
 *   inject: [CAPABILITIES.DATABASE, CAPABILITIES.LOGGER],
 * });
 * const users = container.resolve<UserService>('UserService');
 * ```
 * @since 0.1.0
 */
export interface IContainer {
  /**
   * Registers a provider under a token.
   *
   * @typeParam T - The service type
   * @param token - The token to register under
   * @param provider - Class, factory, or value provider
   * @param options - Lifecycle scope
   * @throws {Error} If the token is already registered
   */
  register<T>(token: string, provider: Provider<T>, options?: ProviderOptions): void;
  /**
   * Resolves an instance, constructing it (and its dependencies) as needed.
   *
   * @typeParam T - The expected service type
   * @param token - The token to resolve
   * @returns The resolved instance
   * @throws {Error} If the token is unregistered or a dependency cycle is detected
   */
  resolve<T>(token: string): T;
  /**
   * Reports whether a token is registered.
   *
   * @param token - The token to look up
   * @returns `true` if registered
   */
  has(token: string): boolean;
  /**
   * Creates a child scope. Scoped services resolve to one instance per
   * scope; singletons are shared with the parent.
   *
   * @returns A child container
   */
  createScope(): IContainer;
}
