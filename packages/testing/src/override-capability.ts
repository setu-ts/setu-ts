import type { CapabilityToken, IPlugin, IPluginContext } from '@setu-ts/common';
import { PLUGIN_PRIORITY } from '@setu-ts/common';

/**
 * Creates a plugin that REPLACES an already-provided capability with a test
 * double, leaving the rest of the application's composition intact.
 *
 * It is ordered after the provider and before ordinary consumers, so it reaches
 * a consumer that resolves the capability during its own `register()` as well as
 * one that resolves it per request.
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
 * 3. It is ordered **after the provider and before ordinary consumers**, which
 *    is what lets it reach a consumer that resolves the capability during its
 *    OWN `register()` — `NotificationPlugin` does exactly that. Ordering comes
 *    from an `optionalDependencies` edge on the token (the resolver visits a
 *    dependency first, whatever its priority band) plus an early priority, so
 *    the depth-first sort reaches this plugin, and through the edge its
 *    provider, before a `PLUGIN_PRIORITY.NORMAL` consumer.
 *
 * **What it still cannot do: undo the provider's eager side effects.** The real
 * plugin's `register()` has run by the time this one replaces its service, so a
 * database adapter's `connect()` or a broker's dial has already happened. Only
 * removing the plugin prevents that — `createTestApp({ app, without })`, or
 * `app.unregister(name)` directly.
 *
 * **It requires the provider to declare the token in `provides`.** That is what
 * the ordering edge hangs on, and it is how a plugin is depended upon at all. A
 * plugin that registers a capability without declaring it cannot be ordered
 * against, so the override registers first and the provider's own plain
 * registration then fails the application's startup with `Capability '<token>'
 * is already registered`. Declare `provides`, or use the removal form below.
 *
 * To remove the provider instead of replacing it — which also prevents its eager
 * side effects — supply the double as a provider ahead of its consumers:
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
 * @throws {Error} During `start()` — from an `onInit` hook, not from
 * `register()` — if nothing provides `token`, or if `token` is a multi-provider
 * capability. Both checks run there because this plugin registers EARLY: at its
 * own `register()` a multi-provider capability has not accumulated its providers
 * yet, and a token it does not shadow may still be registered by a later plugin.
 * A silent no-op would leave the real service serving while the test reported
 * success.
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
    optionalDependencies: [token],
    priority: PLUGIN_PRIORITY.HIGHEST,
    register(ctx: IPluginContext): void {
      // Whether the real provider has already registered. The
      // `optionalDependencies` edge above guarantees it has, WHENEVER the
      // provider declares the token in `provides` — which is how a plugin is
      // depended upon at all. Recorded here because by `onInit` the registry
      // cannot distinguish "I replaced a provider" from "I was the only one".
      const replacedAProvider = ctx.services.has(token);

      ctx.services.register(token, service, { override: true });

      // Both refusals are verified at `onInit`, not here: this plugin registers
      // EARLY (see the priority above), so at `register()` time a multi-provider
      // capability has not accumulated its providers yet and a token this
      // override does not shadow may still be registered by a later plugin.
      // `onInit` runs once every plugin has registered, which is the first
      // moment either question has a settled answer, and a throw there fails
      // `start()` exactly as one here would.
      ctx.lifecycle.onInit(() => {
        // `getAll` returns `[...inherited, ...single, ...multi]`, so on a
        // single-provider token it returns exactly our own object. More than one
        // entry means the token is multi-registered and the write above ADDED a
        // provider rather than replacing the existing ones, which would leave
        // every real provider running while the caller was told the capability
        // was overridden. The replaced registration is never resolved, so a
        // `registerFactory` provider is not constructed by this count.
        const providers = ctx.services.getAll(token).length;
        if (providers > 1) {
          throw new Error(
            `Cannot override capability '${token}': it is a multi-provider capability ` +
              `(${providers - 1} other provider${providers === 2 ? '' : 's'}). Overriding one ` +
              `ADDS a provider rather than replacing the existing ones, so every real provider ` +
              `would still run while the test reported success. Exclude the plugin that ` +
              `registers it instead — createTestApp({ app, without: ['<plugin>'] }).`,
          );
        }
        if (!replacedAProvider) {
          throw new Error(
            `Cannot override capability '${token}': nothing provides it. ` +
              `overrideCapability() replaces a capability the application already has — ` +
              `check the token for a typo, or use createMockPlugin() to provide one it lacks.`,
          );
        }
      });
    },
  };
}
