/**
 * Optional dependency injection container contract, fulfilled by the
 * DiPlugin. The service registry remains the primary resolution mechanism;
 * this container is a convenience layer for constructor injection and
 * lifecycle management. No plugin may require it.
 *
 * @module
 */
import type { IRequestContext } from './http.ts';

/**
 * An identity-keyed injection token carrying its service type.
 * @typeParam T - Resolved value type
 *
 * @since 0.11.0
 */
export interface InjectionToken<T> {
  /** Diagnostic name, never used as identity. */
  readonly name: string;
  /** Phantom type carrier; absent at runtime. */
  readonly __value?: T;
}

/**
 * Creates a distinct frozen injection token without process state.
 *
 * @param name - Diagnostic name
 *
 * @returns A new identity-keyed token
 * @example
 * ```typescript
 * const port = createToken<number>('port');
 * container.register(port, { useValue: 3000 });
 * const value = container.resolve(port);
 * ```
 *
 * @since 0.11.0
 */
export function createToken<T>(name: string): InjectionToken<T> {
  return Object.freeze({ name });
}

/**
 * A string, typed identity token, or class identifying a provider.
 * @typeParam T - Resolved value type
 *
 * @since 0.11.0
 */
export type ContainerToken<T = unknown> = string | InjectionToken<T> | Constructor<T>;

/**
 * A required dependency or an absent-tolerant dependency.
 *
 * @since 0.11.0
 */
export type InjectEntry =
  ContainerToken | { readonly token: ContainerToken; readonly optional: true };

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
 * - `scoped` — one instance per explicit or lazy HTTP request scope, obtained
 * through {@linkcode IContainer.forRequest}; root resolution is refused.
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
 *
 * @since 0.1.0
 */
export interface ClassProvider<T> {
  /** The class to instantiate. */
  readonly useClass: Constructor<T>;
  /**
   * Dependencies resolved in order, including absent-tolerant entries.
   * @since 0.11.0
   */
  readonly inject?: readonly InjectEntry[];
}

/**
 * Provides a service via a factory function.
 *
 * @typeParam T - The service type
 *
 * @since 0.1.0
 */
export interface FactoryProvider<T> {
  /**
   * Constructs the value from declared dependencies, in order.
   *
   * @param deps - Resolved dependency values; absent optionals are undefined
   *
   * @returns The service instance
   * @throws {Error} If provider construction fails
   *
   * @since 0.11.0
   */
  readonly useFactory: (...deps: never[]) => T;
  /**
   * Dependencies passed in order; omitted means unchecked and opaque.
   * @since 0.11.0
   */
  readonly inject?: readonly InjectEntry[];
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
export interface ProviderOptions<T = unknown> {
  /** Lifecycle scope (defaults to the container's default scope). */
  readonly scope?: ServiceScope;
  /**
   * Releases an instance once, in reverse creation order.
   *
   * @param instance - The created value
   *
   * @returns Completion, asynchronous only when needed
   *
   * @since 0.11.0
   */
  readonly dispose?: (instance: T) => void | Promise<void>;
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
 *
 * @since 0.1.0
 */
export interface IContainer {
  /**
   * Registers a provider under a token.
   *
   * @typeParam T - The service type
   *
   * @param token - The token to register under
   *
   * @param provider - Class, factory, or value provider
   *
   * @param options - Lifecycle scope
   *
   * @returns Nothing
   * @throws {Error} If closed or the token exists in this container or a parent
   *
   * @since 0.11.0
   */
  register<T>(token: ContainerToken<T>, provider: Provider<T>, options?: ProviderOptions<T>): void;
  /**
   * Resolves an instance, constructing it (and its dependencies) as needed.
   *
   * @typeParam T - The expected service type
   *
   * @param token - The token to resolve
   *
   * @returns The resolved instance
   * @throws {Error} For invalid wiring, disposed scopes, or root resolution reaching scoped
   * services or creating disposable transients outside singleton dependency graphs
   *
   * @since 0.11.0
   */
  resolve<T>(token: InjectionToken<T> | Constructor<T>): T;
  /**
   * Resolves a string token with an explicitly chosen service type.
   *
   * @param token - Registered name
   *
   * @returns The constructed or cached value
   * @throws {Error} For invalid wiring, disposed scopes, or root resolution reaching scoped
   * services or creating disposable transients outside singleton dependency graphs
   *
   * @since 0.11.0
   */
  resolve<T>(token: string): T;
  /**
   * Resolves a token held as the token union.
   *
   * @param token - Registered token
   *
   * @returns The constructed or cached value
   * @throws {Error} For invalid wiring, disposed scopes, or root resolution reaching scoped
   * services or creating disposable transients outside singleton dependency graphs
   *
   * @since 0.11.0
   */
  resolve<T>(token: ContainerToken<T>): T;
  /**
   * Reports whether a token is registered.
   *
   * @param token - The token to look up
   *
   * @returns `true` if registered or externally resolvable
   *
   * @since 0.11.0
   */
  has(token: ContainerToken): boolean;
  /**
   * Creates a child scope. Scoped services resolve to one instance per
   * scope; singletons are shared with the parent.
   *
   * @returns A child container
   */
  createScope(): IContainer;
  /**
   * Gets the lazily created scope owned by this request.
   *
   * @param ctx - A context supporting deferred cleanup
   *
   * @returns The same scope for every call on this context
   * @throws {Error} If the context cannot dispose a scope; use createTestApp
   * @example
   * ```typescript
   * const service = container.forRequest(ctx).resolve('service');
   * ```
   *
   * @since 0.11.0
   */
  forRequest(ctx: IRequestContext): IContainer;
  /**
   * Disposes owned instances in reverse creation order, once.
   *
   * @returns A promise only if a disposal is asynchronous
   * @throws {AggregateError} After all disposals run, if any failed
   *
   * @since 0.11.0
   */
  dispose(): void | Promise<void>;
}
