/**
 * DI container — the {@linkcode IContainer} implementation.
 *
 * Wires together the provider registry, scope manager, and circular
 * detector. Supports three provider forms (class, factory, value), three
 * lifecycle scopes (singleton, scoped, transient), hierarchical scopes,
 * and optional auto-registration fallback to an external resolver
 * (typically the kernel's ServiceRegistry).
 *
 * @module
 */
import type {
  Constructor,
  IContainer,
  Provider,
  ProviderOptions,
  ServiceScope,
} from '@hono-enterprise/common';

import { CircularDetector } from './circular-detector.ts';
import type { ProviderEntry } from './provider-registry.ts';
import { ProviderRegistry } from './provider-registry.ts';
import { ScopeManager } from './scope-manager.ts';

/**
 * External resolver used for auto-registration fallback. A subset of
 * {@linkcode IServiceRegistry} — when a token is not in the DI container
 * and `autoRegister` is enabled, the container delegates here.
 *
 * @since 0.1.0
 */
export interface ExternalResolver {
  /**
   * Reports whether the external source can resolve the token.
   *
   * @param token - The capability token
   * @returns `true` if the external source has the token
   */
  has(token: string): boolean;
  /**
   * Resolves a token from the external source.
   *
   * @param token - The capability token
   * @returns The resolved instance
   */
  resolve(token: string): unknown;
}

/**
 * Configuration for constructing a {@linkcode DiContainer}.
 *
 * @since 0.1.0
 */
export interface ContainerConfig {
  /** Default lifecycle scope for providers without an explicit scope. */
  readonly defaultScope: ServiceScope;
  /** Optional external resolver for auto-registration fallback. */
  readonly externalResolver?: ExternalResolver;
  /**
   * When `true`, resolving an unregistered token falls back to the
   * external resolver and caches the result as a singleton.
   */
  readonly autoRegister: boolean;
  /** Parent registry for hierarchical lookups (internal). */
  readonly parentRegistry?: ProviderRegistry;
  /** Parent scope manager sharing singletons (internal). */
  readonly parentScopes?: ScopeManager;
}

/**
 * Resolves the scope for a provider entry, falling back to the default.
 *
 * @param options - Provider options (may omit scope)
 * @param defaultScope - Container default scope
 * @returns The effective scope
 */
function resolveScope(
  options: ProviderOptions | undefined,
  defaultScope: ServiceScope,
): ServiceScope {
  return options?.scope ?? defaultScope;
}

/**
 * Dependency injection container implementing {@linkcode IContainer}.
 *
 * Resolution order for a token:
 *
 * 1. **Provider registry** — explicit DI registrations (class, factory, value).
 * 2. **External resolver** — when `autoRegister` is enabled and the token
 *    exists in the external source (ServiceRegistry), the instance is fetched
 *    and cached as a singleton for subsequent lookups.
 * 3. **Throw** — if neither source has the token.
 *
 * Circular dependencies are detected via an instance-level resolution stack
 * that persists across recursive `resolve()` calls (including factory
 * providers that call back into the container).
 *
 * @since 0.1.0
 */
export class DiContainer implements IContainer {
  readonly #defaultScope: ServiceScope;
  readonly #registry: ProviderRegistry;
  readonly #scopes: ScopeManager;
  readonly #externalResolver: ExternalResolver | undefined;
  readonly #autoRegister: boolean;
  readonly #detector = new CircularDetector();

  /**
   * @param config - Container configuration
   */
  constructor(config: ContainerConfig) {
    this.#defaultScope = config.defaultScope;
    this.#registry = config.parentRegistry?.createChild() ?? new ProviderRegistry();
    this.#scopes = config.parentScopes?.createChild() ?? new ScopeManager();
    this.#externalResolver = config.externalResolver;
    this.#autoRegister = config.autoRegister;
  }

  /** @inheritdoc */
  register<T>(token: string, provider: Provider<T>, options?: ProviderOptions): void {
    const scope = resolveScope(options, this.#defaultScope);
    this.#registry.register(token, { provider: provider as Provider<unknown>, scope });
  }

  /** @inheritdoc */
  resolve<T>(token: string): T {
    return this.#resolveToken<T>(token);
  }

  /** @inheritdoc */
  has(token: string): boolean {
    if (this.#registry.has(token)) {
      return true;
    }
    return this.#autoRegister &&
      this.#externalResolver !== undefined &&
      this.#externalResolver.has(token);
  }

  /** @inheritdoc */
  createScope(): IContainer {
    const base = {
      defaultScope: this.#defaultScope,
      autoRegister: this.#autoRegister,
      parentRegistry: this.#registry,
      parentScopes: this.#scopes,
    };
    return this.#externalResolver !== undefined
      ? new DiContainer({ ...base, externalResolver: this.#externalResolver })
      : new DiContainer(base);
  }

  /**
   * Internal recursive resolution with cycle tracking.
   *
   * Uses the instance-level {@linkcode CircularDetector} so cycles that
   * cross public `resolve()` boundaries (e.g. a factory calling
   * `container.resolve()`) are caught.
   *
   * @typeParam T - Expected instance type
   * @param token - The token to resolve
   * @returns The resolved instance
   * @throws {Error} If the token is unregistered or a cycle is detected
   */
  #resolveToken<T>(token: string): T {
    this.#detector.enter(token);
    try {
      const entry = this.#registry.get(token);
      if (entry !== undefined) {
        return this.#buildFromEntry<T>(token, entry);
      }

      if (this.#autoRegister && this.#externalResolver?.has(token)) {
        const instance = this.#externalResolver.resolve(token);
        this.#registry.register(token, {
          provider: { useValue: instance } as Provider<unknown>,
          scope: 'singleton',
        });
        this.#scopes.setSingleton(token, instance);
        return instance as T;
      }

      throw new Error(`No provider registered for DI token '${token}'.`);
    } finally {
      this.#detector.leave();
    }
  }

  /**
   * Builds (or retrieves from cache) an instance from a provider entry.
   *
   * @typeParam T - Expected instance type
   * @param token - The token being resolved (for cache key)
   * @param entry - Provider and scope
   * @returns The resolved instance
   */
  #buildFromEntry<T>(token: string, entry: ProviderEntry): T {
    switch (entry.scope) {
      case 'singleton':
        return this.#resolveSingleton<T>(token, entry);
      case 'scoped':
        return this.#resolveScoped<T>(token, entry);
      case 'transient':
      default:
        return this.#instantiate<T>(entry.provider);
    }
  }

  /**
   * Resolves a singleton: returns the cached instance or builds and caches it.
   */
  #resolveSingleton<T>(token: string, entry: ProviderEntry): T {
    if (this.#scopes.hasSingleton(token)) {
      return this.#scopes.getSingleton(token) as T;
    }
    const instance = this.#instantiate<T>(entry.provider);
    this.#scopes.setSingleton(token, instance);
    return instance;
  }

  /**
   * Resolves a scoped service: returns the per-scope cached instance or
   * builds and caches it for this scope.
   */
  #resolveScoped<T>(token: string, entry: ProviderEntry): T {
    if (this.#scopes.hasScoped(token)) {
      return this.#scopes.getScoped(token) as T;
    }
    const instance = this.#instantiate<T>(entry.provider);
    this.#scopes.setScoped(token, instance);
    return instance;
  }

  /**
   * Instantiates an instance from the provider, resolving constructor
   * dependencies recursively.
   */
  #instantiate<T>(provider: Provider<unknown>): T {
    if ('useValue' in provider) {
      return provider.useValue as T;
    }

    if ('useFactory' in provider) {
      return provider.useFactory() as T;
    }

    // ClassProvider — resolve constructor dependencies then instantiate.
    const injectTokens = provider.inject ?? [];
    const deps: unknown[] = injectTokens.map((dep) => this.#resolveToken<unknown>(dep));
    const ctor = provider.useClass as Constructor<T>;
    return new ctor(...(deps as never[]));
  }
}
