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
