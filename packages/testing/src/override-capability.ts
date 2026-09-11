import type { CapabilityToken, IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';

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
 * Capabilities the kernel registers with `{ multi: true }`, which cannot be
 * replaced by an override.
 *
 * `ServiceRegistry.getAll` returns `[...inherited, ...single, ...multi]`, so a
 * `{ override: true }` registration lands in the SINGLE map and is *prepended*
 * to the multi list rather than replacing anything — every real provider still
 * runs, and the caller is told the capability was overridden. `has()` cannot
 * distinguish the two (`service-registry.ts:99` consults both maps) and the
 * public `IServiceRegistry` exposes no non-instantiating discriminator —
 * `get`/`getAll` both resolve a `registerFactory` registration, so probing with
 * either would construct the very service the test is replacing.
 *
 * These five are every multi registration the framework makes; each is written
 * through an `IPluginContext` facade (`ctx.health.register`,
 * `ctx.metrics.register`, `ctx.openapi.addSchema`, `ctx.decorators.register`,
 * `ctx.cli.register`), so they are the complete in-framework set. A plugin
 * calling `ctx.services.register(token, svc, { multi: true })` directly is not
 * detectable here and is documented instead.
 */
const MULTI_PROVIDER_TOKENS: ReadonlySet<CapabilityToken> = new Set([
  CAPABILITIES.HEALTH_INDICATOR,
  CAPABILITIES.METRIC_REGISTRATION,
  CAPABILITIES.OPENAPI_SCHEMA,
  CAPABILITIES.DECORATOR_HANDLER,
  CAPABILITIES.CLI_COMMAND,
]);

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
 * 3. It runs last (see `OVERRIDE_PRIORITY`), so it wins regardless of the
 *    replaced plugin's own priority band.
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
 * No ordering fixes the second case: an override placed *before* the real
 * provider is then overwritten by it — the real plugin registers without
 * `{ override: true }`, so the kernel throws `already registered` and the
 * application cannot start.
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
 * **Multi-provider capabilities cannot be overridden.** `health-indicator`,
 * `metric-registration`, `openapi-schema`, `decorator-handler` and `cli-command`
 * are registered with `{ multi: true }`, and `getAll` returns the single and
 * multi registrations *concatenated* — so an override would add a provider
 * while every real one kept running. Those five are refused by name; exclude
 * the plugin that registers the provider instead.
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
      if (MULTI_PROVIDER_TOKENS.has(token)) {
        throw new Error(
          `Cannot override capability '${token}': it is a multi-provider capability. ` +
            `Overriding one ADDS a provider rather than replacing the existing ones, so every ` +
            `real provider would still run while the test reported success. Exclude the plugin ` +
            `that registers it instead — createTestApp({ app, without: ['<plugin>'] }).`,
        );
      }
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
