/**
 * React Router context keys the plugin populates on every SSR request.
 *
 * A key is a plain object used purely by identity — structurally identical to
 * React Router's `RouterContext<T>` (`{ defaultValue?: T }`), so these keys are
 * accepted by a real `RouterContextProvider` without this module importing
 * `react-router` at all. App code reads them with `context.get(servicesContext)`
 * inside a loader, action, or middleware.
 *
 * @module
 * @since 0.2.0
 */

import type { IPrincipal, IServiceRegistry } from '@hono-enterprise/common';
import type { RouterContextKey } from '../interfaces/index.ts';

/**
 * Key holding the kernel {@linkcode IServiceRegistry} for the current request.
 *
 * Always set by the plugin, so `context.get(servicesContext)` never returns the
 * `null` default on a request served through the SSR catch-all. The `| null` in
 * the type exists only because the key needs a default at all — React Router's
 * `get()` throws for an unset key that has none.
 *
 * @example
 * ```typescript
 * import { servicesContext } from '@hono-enterprise/react-router-plugin';
 * import { CAPABILITIES, type ILogger } from '@hono-enterprise/common';
 *
 * export async function loader({ context }: Route.LoaderArgs) {
 *   const services = context.get(servicesContext);
 *   services?.get<ILogger>(CAPABILITIES.LOGGER).info('ssr loader');
 *   return { ok: true };
 * }
 * ```
 * @since 0.2.0
 */
export const servicesContext: RouterContextKey<IServiceRegistry | null> = {
  defaultValue: null,
};

/**
 * Key holding the authenticated principal, or `null` on an anonymous request.
 *
 * The `null` default means `context.get(userContext)` resolves to `null` rather
 * than throwing when no principal is attached — React Router's `get()` throws
 * `No value found for context` for an unset key that has no default.
 *
 * @since 0.2.0
 */
export const userContext: RouterContextKey<IPrincipal | null> = {
  defaultValue: null,
};

/**
 * Context keys created by name, memoised so the same name always yields the
 * same object.
 *
 * A key is matched by identity, which breaks the moment two copies of the
 * declaring module exist — and in a React Router application that is the normal
 * case, not an edge case: the server build is produced by Vite, which INLINES
 * application modules, while the application's own configuration file is loaded
 * from source by the runtime. Both then hold a `{ defaultValue }` object that
 * looks identical and matches nothing.
 */
const namedKeys = new Map<string, RouterContextKey<unknown>>();

/**
 * Returns the context key for a name, creating it on first use.
 *
 * Use this instead of writing `{ defaultValue: … }` by hand whenever a key is
 * SET in one module and READ in another that a bundler may duplicate — which,
 * in a framework-mode application, is every key an application declares for
 * itself. Both sides resolve the name through this module, so they receive the
 * identical object however many times their own modules are copied.
 *
 * That only holds while this package is a single module instance. In a
 * scaffolded project it is: the server build treats `@hono-enterprise/*` as
 * external, so the bundle imports this module at runtime rather than inlining
 * a second copy of it.
 *
 * @example An application-declared key, set in `honoe.config.ts` and read in a loader
 * ```typescript
 * import { contextKeyFor } from '@hono-enterprise/react-router-plugin';
 * import type { ISession } from '@hono-enterprise/common';
 *
 * export const sessionContext = contextKeyFor<ISession | null>('session', null);
 * ```
 * @typeParam T - The value the key carries
 * @param name - A stable, application-wide unique name for the key
 * @param defaultValue - Returned by `context.get()` before anything sets the
 * key. Required, because React Router throws for an unset key that has none.
 * @returns The key for that name — the same object on every call
 * @since 0.2.0
 */
export function contextKeyFor<T>(name: string, defaultValue: T): RouterContextKey<T> {
  const existing = namedKeys.get(name);
  if (existing !== undefined) {
    // First call wins: a later different default would silently change what
    // every earlier holder of this key reads before it is set.
    return existing as RouterContextKey<T>;
  }

  const key: RouterContextKey<T> = { defaultValue };
  namedKeys.set(name, key as RouterContextKey<unknown>);
  return key;
}
