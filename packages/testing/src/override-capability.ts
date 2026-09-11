import type { CapabilityToken, IPlugin, IPluginContext } from '@setu-ts/common';
import { PLUGIN_PRIORITY } from '@setu-ts/common';

/**
 * Priority carried by every plugin {@linkcode overrideCapability} emits.
 *
 * One above {@linkcode PLUGIN_PRIORITY.LOWEST}, so an override registers after
 * every plugin that could claim the token — including one at
 * `PLUGIN_PRIORITY.LOW` (900), which a default-priority (500) plugin would
 * otherwise lose to. The kernel orders by `(priority, registration order)`,
 * so two overrides of different tokens are unaffected by each other.
 *
 * This is a convention rather than an enforced ceiling: a plugin declaring a
 * still higher number would run later and win. No first-party plugin does.
 */
const OVERRIDE_PRIORITY = PLUGIN_PRIORITY.LOWEST + 1;

/**
 * Creates a plugin that REPLACES an already-provided capability with a test
 * double, leaving the rest of the application's composition intact.
 *
 * This is the replacement mechanism AI_GUIDELINES §3.4 describes — "a
 * replacement plugin registers the same capability token with
 * `override: true`" — with the three constraints that make it work applied for
 * you:
 *
 * 1. It declares **no** `provides`. A second plugin declaring a token the real
 *    one already declares is refused by the kernel before any of them runs
 *    (`Capability 'x' is provided by both 'a' and 'b'`), which is why
 *    {@linkcode createMockPlugin} cannot be used to override.
 * 2. It registers with `{ override: true }`, without which the kernel refuses a
 *    second registration of a live token.
 * 3. It runs last (see `OVERRIDE_PRIORITY`), so it wins regardless of the
 *    replaced plugin's own priority band.
 *
 * **The override is post-hoc.** The real plugin's `register()` has already run
 * by the time this one replaces its service, so any eager side effect inside it
 * — a database adapter's `connect()`, a broker's dial — has already happened.
 * To prevent those, drop the plugin instead: `createTestApp({ app, without })`,
 * or `app.unregister(name)` directly.
 *
 * @param token - The capability token to replace. Must already be provided.
 * @param service - The test double to register under it
 * @returns A plugin to append to `createTestApp`'s `overrides`, or to pass to
 * `app.register()` on an un-started application
 * @throws {Error} At `register()` time, if nothing provides `token`. A silent
 * no-op would leave the real service serving while the test reported success.
 * @example
 * ```typescript
 * import { createTestApp, overrideCapability } from '@setu-ts/testing';
 * import { CAPABILITIES } from '@setu-ts/common';
 * import { createApp } from '../setu.config.ts';
 *
 * const app = await createTestApp({
 *   app: createApp(),
 *   overrides: [overrideCapability(CAPABILITIES.MAIL, { send: () => Promise.resolve() })],
 * });
 * ```
 * @since 0.6.0
 */
export function overrideCapability(token: CapabilityToken, service: object): IPlugin {
  return {
    name: `test-override.${token}`,
    version: '0.6.0',
    priority: OVERRIDE_PRIORITY,
    register(ctx: IPluginContext): void {
      if (!ctx.services.has(token)) {
        throw new Error(
          `Cannot override capability '${token}': nothing provides it. ` +
            `overrideCapability() replaces a capability the application already has — ` +
            `check the token for a typo, or use createMockPlugin() to provide one it lacks.`,
        );
      }
      ctx.services.register(token, service, { override: true });
    },
  };
}
