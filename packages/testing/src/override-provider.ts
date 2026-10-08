import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type {
  IContainer,
  IPlugin,
  IPluginContext,
  Provider,
  ProviderOptions,
} from '@setu-ts/common';

import manifest from '../deno.json' with { type: 'json' };

/**
 * The container the overriding plugin publishes in place of the real one.
 *
 * Every call reaches the real container except a `register` for the overridden
 * token, which is swallowed: the double is already registered under it, and the
 * application's own registration of the real provider is the one being replaced.
 * `has` and `register` for that token are recorded as evidence that the
 * application really does provide it, so a mistyped token can be refused.
 *
 * A child scope is wrapped the same way and shares the record. Without that, a
 * child that registered the token itself would resolve its own provider before
 * the inherited double.
 */
class OverridingContainer implements IContainer {
  readonly #inner: IContainer;
  readonly #token: string;
  readonly #claim: { claimed: boolean };

  constructor(inner: IContainer, token: string, claim: { claimed: boolean } = { claimed: false }) {
    this.#inner = inner;
    this.#token = token;
    this.#claim = claim;
  }

  /** Whether anything asked for, or tried to register, the overridden token. */
  get claimed(): boolean {
    return this.#claim.claimed;
  }

  register<T>(token: string, provider: Provider<T>, options?: ProviderOptions): void {
    if (token === this.#token) {
      this.#claim.claimed = true;
      return;
    }
    this.#inner.register(token, provider, options);
  }

  resolve<T>(token: string): T {
    if (token === this.#token) {
      this.#claim.claimed = true;
    }
    return this.#inner.resolve<T>(token);
  }

  has(token: string): boolean {
    if (token === this.#token) {
      this.#claim.claimed = true;
    }
    return this.#inner.has(token);
  }

  createScope(): IContainer {
    return new OverridingContainer(this.#inner.createScope(), this.#token, this.#claim);
  }
}

/**
 * Replaces a provider in the application's dependency-injection container with
 * a test double, before anything is constructed from it.
 *
 * {@linkcode overrideCapability} replaces a capability in the kernel's service
 * registry. With `DiPlugin` registered, `DecoratorPlugin` puts each
 * `@Injectable` class into the CONTAINER instead, where that cannot reach it,
 * and the container refuses a second registration of a token. This plugin
 * registers the double on the container first and stands in for the container
 * while the rest of the application registers, so the application's own
 * registration of the real provider is skipped and every class that injects the
 * token — a controller included — is constructed with the double.
 *
 * The plugin depends on `CAPABILITIES.DI_CONTAINER`, so the kernel orders it
 * after `DiPlugin`, and registers at `PLUGIN_PRIORITY.NORMAL`, ahead of
 * `DecoratorPlugin` (`PLUGIN_PRIORITY.LOW`).
 *
 * @param token - The container token to replace: an `@Injectable({ token })`
 * value, or the token the decorator derived for the class.
 * @param provider - The double: `{ useValue }`, `{ useFactory }` or `{ useClass }`
 * @param options - Lifecycle scope for the double
 * @returns A plugin to append to `createTestApp`'s `overrides`, or to pass to
 * `app.register()` on an un-started application
 * @throws {Error} During `start()`. From `register()` if the application has no
 * DI container, or if the real provider was registered first (the double would
 * never be resolved). From an `onInit` hook if nothing in the application
 * registered or asked for `token`, which is how a mistyped token surfaces.
 * @example
 * ```typescript
 * import { createTestApp, overrideProvider } from '@setu-ts/testing';
 * import { createApp } from '../setu.config.ts';
 *
 * const app = await createTestApp({
 *   app: createApp(),
 *   overrides: [overrideProvider('pricing-service', { useValue: { price: () => 0 } })],
 * });
 * ```
 * @since 0.9.0
 */
export function overrideProvider<T>(
  token: string,
  provider: Provider<T>,
  options?: ProviderOptions,
): IPlugin {
  return {
    name: `test-provider-override.${token}`,
    version: manifest.version,
    dependencies: [CAPABILITIES.DI_CONTAINER],
    priority: PLUGIN_PRIORITY.NORMAL,
    register(ctx: IPluginContext): void {
      const container = ctx.container;
      if (container === undefined) {
        throw new Error(
          `Cannot override provider '${token}': the application has no DI container. ` +
            `overrideProvider() replaces a DiPlugin provider; use overrideCapability() for a ` +
            `capability in the service registry.`,
        );
      }
      try {
        container.register(token, provider, options);
      } catch (cause) {
        throw new Error(
          `Cannot override provider '${token}': it was registered on the container before ` +
            `the override ran, so the application has already been built with the real ` +
            `provider. Register overrideProvider() after DiPlugin and before the plugin that ` +
            `registers '${token}'.`,
          { cause },
        );
      }
      const overriding = new OverridingContainer(container, token);
      ctx.services.register<IContainer>(CAPABILITIES.DI_CONTAINER, overriding, { override: true });

      ctx.lifecycle.onInit(() => {
        if (!overriding.claimed) {
          throw new Error(
            `Cannot override provider '${token}': nothing in the application registers or ` +
              `injects it. Check the token for a typo — an @Injectable class's token is its ` +
              `@Injectable({ token }) value, or the one the decorator derived from its name.`,
          );
        }
      });
    },
  };
}
