# @setu-ts/feature-flags-plugin

Feature flags with pluggable backends. Registers the **synchronous** `IFeatureFlags` under
`CAPABILITIES.FEATURE_FLAGS` (`'feature-flags'`).

Zero dependencies. Providers own a cached snapshot plus an async `start()`/`stop()` lifecycle the
plugin drives, which is what lets `isEnabled` stay synchronous at the call site.

## Installation

```typescript
import { createFlagGuard, FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';
```

## Usage

```typescript
import { createFlagGuard, FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';
import { CAPABILITIES, type IFeatureFlags } from '@setu-ts/common';

app.register(FeatureFlagsPlugin({
  provider: 'config',
  options: {
    flags: {
      'new-checkout': { enabled: false, users: ['user-1', 'user-2'] },
      'dark-mode': { enabled: true, percentage: 25 },
    },
  },
}));

const flags = app.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
if (flags.isEnabled('new-checkout', { userId: 'user-1' })) { /* … */ }

// Route guard — short-circuits without calling next()
app.router.get('/beta', {
  middleware: [createFlagGuard('new-checkout', { fallback: '/' })],
  handler: betaHandler,
});
```

## Options

`FeatureFlagsPluginOptions` is a union discriminated on `provider`, so a missing per-arm field is a
compile error rather than a startup throw:

| Option     | Type                                                               | Description                 |
| ---------- | ------------------------------------------------------------------ | --------------------------- |
| `provider` | `'config' \| 'memory' \| 'database' \| 'launchdarkly' \| 'custom'` | Selects the arm.            |
| `options`  | per-arm shape                                                      | Configuration for that arm. |

`options` is required for `'config'` (`{ flags }`), `'database'`, `'launchdarkly'` and `'custom'`
(`{ instance }`), and optional for `'memory'`. See [Providers](#providers) for behaviour and
[LaunchDarkly](#launchdarkly) for that arm's fields.

## Providers

| `provider`       | Behaviour                                                                     |
| ---------------- | ----------------------------------------------------------------------------- |
| `'config'`       | Immutable inline flags.                                                       |
| `'memory'`       | Mutable map — `setFlag` / `removeFlag` / `replaceFlags`.                      |
| `'database'`     | Polls an injected `IFlagStore` on one interval; keeps the last good snapshot. |
| `'launchdarkly'` | LaunchDarkly, via the SDK's one synchronous read — see below.                 |
| `'custom'`       | Any `FlagProvider` you supply.                                                |

`DatabaseProvider` arms a single poll timer in `start()`. On a poll failure it retains the previous
snapshot and reports the degradation rather than flipping every flag off.

## Evaluation precedence

**Allowlist first, then `enabled`, then percentage.** A `users` entry overrides `enabled: false`, so
`{ enabled: false, users: ['user-1'] }` turns the flag on for those users only.

The rollout bucket is a deterministic FNV-1a-32 hash of `(flag, userId) % 100`, so a user's bucket
is stable across processes and restarts. A partial rollout with **no `userId` evaluates to
`false`**.

## Guard behaviour

`createFlagGuard(flag, options?)` redirects with `302` when `fallback` is set, otherwise responds
with `statusCode ?? 404`. It never calls `next()`. An unregistered feature-flags capability is
allowed to propagate rather than silently opening the route.

## LaunchDarkly

Supported through the `'launchdarkly'` arm. The Node server SDK's `variation`/`allFlagsState` are
**async**, which no provider can reconcile with the synchronous committed `isEnabled` directly — the
bridge is `LDFlagsState.getFlagValue`, the SDK's one synchronous read, behind a per-context snapshot
cache.

A context whose snapshot has not loaded yet returns `fallbackValue` and schedules a background
refill, coalesced per key so a hot loop over uncached users does not stampede. `isEnabledAsync`
carries no such caveat — it awaits the SDK and is the accurate entry point when a cold read matters.

| Option               | Type                      | Default | Description                                                                                  |
| -------------------- | ------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `sdkKey`             | `string`                  | —       | Required unless `client` is injected.                                                        |
| `client`             | `ILaunchDarklyClient`     | —       | Prebuilt client; the SDK module is never loaded.                                             |
| `fallbackValue`      | `boolean`                 | `false` | Value for an unloaded context; also the SDK default in `isEnabledAsync`.                     |
| `initTimeoutSeconds` | `number`                  | `5`     | Initial connection wait. A timeout leaves the provider degraded rather than failing startup. |
| `ldOptions`          | `Record<string, unknown>` | —       | Forwarded verbatim as the SDK `init()` second argument.                                      |

## Exports

| Export                        | Kind      |
| ----------------------------- | --------- |
| `adaptLaunchDarklyModule`     | function  |
| `createFlagGuard`             | function  |
| `createProvider`              | function  |
| `FeatureFlagsPlugin`          | function  |
| `loadLaunchDarklyModule`      | function  |
| `toLaunchDarklyContext`       | function  |
| `ConfigProvider`              | class     |
| `DatabaseProvider`            | class     |
| `FeatureFlagService`          | class     |
| `LaunchDarklyModuleError`     | class     |
| `LaunchDarklyProvider`        | class     |
| `MemoryProvider`              | class     |
| `ConfigProviderOptions`       | interface |
| `CustomProviderOptions`       | interface |
| `DatabaseProviderOptions`     | interface |
| `FlagContext`                 | interface |
| `FlagDefinition`              | interface |
| `FlagGuardOptions`            | interface |
| `FlagProvider`                | interface |
| `FlagProviderStatus`          | interface |
| `IFeatureFlags`               | interface |
| `IFlagStore`                  | interface |
| `ILaunchDarklyClient`         | interface |
| `ILaunchDarklyFlagsState`     | interface |
| `ILaunchDarklyModule`         | interface |
| `LaunchDarklyContext`         | interface |
| `LaunchDarklyProviderConfig`  | interface |
| `LaunchDarklyProviderOptions` | interface |
| `MemoryProviderOptions`       | interface |
| `FeatureFlagsPluginOptions`   | type      |
| `FlagProviderType`            | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#feature-flags-setu-tsfeature-flags-plugin).
