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
 * This is a convention rather than an enforced ceiling — the testing package
 * cannot bound what a plugin declares — but the failure mode is loud rather
 * than silent. A provider declaring a HIGHER number runs after the override, so
 * the override reaches its presence check with nothing yet providing the token
 * and refuses by name; the application does not start. You therefore get either
 * the override or a startup refusal naming the token, never a silently wrong
 * service. No first-party plugin declares above `PLUGIN_PRIORITY.LOWEST`.
 */
const OVERRIDE_PRIORITY = PLUGIN_PRIORITY.LOWEST + 1;

/**
 * Creates a plugin that REPLACES an already-provided capability with a test
 * double, leaving the rest of the application's composition intact.
 *
 * It replaces what every resolution *after it registers* sees. A consumer that
 * captured the service during its own `register()` keeps the original — see
 * "post-hoc" below for the case and the remedy.
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
 * 3. It runs after every first-party priority band (see `OVERRIDE_PRIORITY`),
 *    so it wins against a provider in any of them — including
 *    `PLUGIN_PRIORITY.LOW`, which a default-priority plugin would lose to. A
 *    provider declaring a number above the sentinel is refused at startup
 *    rather than silently winning.
 *
 * **The override is post-hoc, and that bounds what it can reach.** It runs after
 * every other plugin, so it replaces what every resolution *from then on* sees —
 * but two things have already happened by that point:
 *
 * - **Eager side effects.** The real plugin's `register()` has run, so a
 *   database adapter's `connect()` or a broker's dial has already occurred.
 * - **Eagerly captured references.** A consumer that resolved this capability
 *   during its OWN `register()` holds the original object and keeps using it.
 *   `NotificationPlugin` does exactly this — `createProvider` calls
 *   `ctx.services.get(CAPABILITIES.MAIL)` while registering — so overriding
 *   `mail` beneath it replaces the registry entry while every notification
 *   still reaches the real mailer, with no error and no signal.
 *
 * No ordering fixes the second case. An override placed *before* the real
 * provider registers the token FIRST; the provider's own registration then
 * fails, because it registers without `{ override: true }` and the kernel
 * refuses a second registration of a live token — so the application does not
 * start at all. The provider never overwrites the override; it throws.
 *
 * For either case, remove the provider instead of replacing it, and supply the
 * double as a provider ahead of its consumers:
 *
 * ```typescript
 * await createTestApp({
 *   app: createApp(),
 *   without: ['mail-plugin'],
 *   overrides: [createMockPlugin({
 *     name: 'mail-plugin',
 *     provides: CAPABILITIES.MAIL,
 *     service: fakeMailer,
 *     priority: PLUGIN_PRIORITY.HIGH,   // ahead of the consumer that captures it
 *   })],
 * });
 * ```
 *
 * @param token - The capability token to replace. Must already be provided.
 * @param service - The test double to register under it
 * @returns A plugin to append to `createTestApp`'s `overrides`, or to pass to
 * `app.register()` on an un-started application
 * **Multi-provider capabilities cannot be overridden**, and are refused. A token
 * registered with `{ multi: true }` — the kernel's `health-indicator`,
 * `metric-registration`, `openapi-schema`, `decorator-handler` and
 * `cli-command`, and any an application registers itself — has no single
 * provider to replace: `getAll` returns the single and multi registrations
 * *concatenated*, so an override would add a provider while every real one kept
 * running. Detection is generic rather than a list of known tokens, so an
 * application's own multi capability is refused too. Exclude the plugin that
 * registers the provider instead.
 *
 * @throws {Error} At `register()` time, if nothing provides `token`, or if
 * `token` is a multi-provider capability. A silent no-op would leave the real
 * service serving while the test reported success.
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

      // Multi-provider detection, AFTER the write and generically — there is no
      // non-instantiating way to ask the registry beforehand (`has()` consults
      // both the single and multi maps, so it cannot tell them apart).
      //
      // `getAll` returns `[...inherited, ...single, ...multi]`, so on a single-
      // provider token it now returns exactly our own object: length 1, and the
      // replaced registration is never resolved — a `registerFactory` provider
      // is NOT constructed by this check. More than one entry means the token is
      // multi-registered and the write above ADDED a provider rather than
      // replacing the existing ones, which would leave every real provider
      // running while the caller was told the capability was overridden.
      //
      // The stale write is not undone: `IServiceRegistry.unregister` deletes both
      // maps and would destroy the real providers, and throwing here fails
      // `start()`, so the application is discarded either way.
      const providers = ctx.services.getAll(token).length;
      if (providers > 1) {
        throw new Error(
          `Cannot override capability '${token}': it is a multi-provider capability ` +
            `(${providers - 1} other provider${providers === 2 ? '' : 's'}). Overriding one ADDS ` +
            `a provider rather than replacing the existing ones, so every real provider would ` +
            `still run while the test reported success. Exclude the plugin that registers it ` +
            `instead — createTestApp({ app, without: ['<plugin>'] }).`,
        );
      }
    },
  };
}
