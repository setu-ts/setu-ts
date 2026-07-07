/**
 * Container builder — fluent API for configuring and creating a
 * {@linkcode DiContainer} before it is registered with the service
 * registry.
 *
 * @module
 */
import type { IContainer, Provider, ProviderOptions, ServiceScope } from '@hono-enterprise/common';

import type { ExternalResolver } from './container.ts';
import { DiContainer } from './container.ts';

/**
 * A pending provider registration collected by the builder.
 *
 * @internal
 */
interface PendingEntry {
  readonly token: string;
  readonly provider: Provider<unknown>;
  readonly options: ProviderOptions | undefined;
}

/**
 * Fluent builder for {@linkcode IContainer} instances.
 *
 * Collects configuration and provider registrations, then produces a
 * ready-to-use container via {@linkcode build}.
 *
 * @example
 * ```typescript
 * const container = new ContainerBuilder()
 *   .setDefaultScope('singleton')
 *   .register('db', { useFactory: () => createDb() })
 *   .register('users', { useClass: UserService, inject: ['db'] })
 *   .build();
 * ```
 * @since 0.1.0
 */
export class ContainerBuilder {
  #defaultScope: ServiceScope = 'singleton';
  #autoRegister = false;
  #externalResolver: ExternalResolver | undefined;
  readonly #entries: PendingEntry[] = [];

  /**
   * Sets the default lifecycle scope for providers registered without an
   * explicit scope.
   *
   * @param scope - The default scope
   * @returns This builder for chaining
   */
  setDefaultScope(scope: ServiceScope): this {
    this.#defaultScope = scope;
    return this;
  }

  /**
   * Enables or disables auto-registration fallback to the external resolver.
   *
   * @param enabled - `true` to enable fallback (defaults to `false`)
   * @returns This builder for chaining
   */
  setAutoRegister(enabled: boolean): this {
    this.#autoRegister = enabled;
    return this;
  }

  /**
   * Sets the external resolver used when auto-registration is enabled.
   *
   * @param resolver - The external resolver (e.g. the service registry)
   * @returns This builder for chaining
   */
  setExternalResolver(resolver: ExternalResolver): this {
    this.#externalResolver = resolver;
    return this;
  }

  /**
   * Queues a provider registration to be applied at {@linkcode build} time.
   *
   * @typeParam T - The service type
   * @param token - The capability token
   * @param provider - Class, factory, or value provider
   * @param options - Lifecycle scope
   * @returns This builder for chaining
   */
  register<T>(token: string, provider: Provider<T>, options?: ProviderOptions): this {
    this.#entries.push({
      token,
      provider: provider as Provider<unknown>,
      options,
    });
    return this;
  }

  /**
   * Creates the container with all queued registrations applied.
   *
   * @returns A new {@linkcode IContainer}
   */
  build(): IContainer {
    const base = {
      defaultScope: this.#defaultScope,
      autoRegister: this.#autoRegister,
    };
    const container = this.#externalResolver !== undefined
      ? new DiContainer({ ...base, externalResolver: this.#externalResolver })
      : new DiContainer(base);
    for (const entry of this.#entries) {
      container.register(entry.token, entry.provider, entry.options);
    }
    return container;
  }
}

/**
 * Convenience factory for creating a standalone DI container.
 *
 * @example
 * ```typescript
 * const container = createContainer({ defaultScope: 'singleton' });
 * container.register('svc', { useValue: new MyService() });
 * ```
 * @param config - Optional configuration
 * @returns A new {@linkcode IContainer}
 * @since 0.1.0
 */
export function createContainer(config?: {
  readonly defaultScope?: ServiceScope;
  readonly autoRegister?: boolean;
  readonly externalResolver?: ExternalResolver;
}): IContainer {
  const builder = new ContainerBuilder()
    .setDefaultScope(config?.defaultScope ?? 'singleton')
    .setAutoRegister(config?.autoRegister ?? false);
  if (config?.externalResolver !== undefined) {
    builder.setExternalResolver(config.externalResolver);
  }
  return builder.build();
}
