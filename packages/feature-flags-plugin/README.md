# @hono-enterprise/feature-flags-plugin

Feature flags with pluggable backends. Registers the **synchronous** `IFeatureFlags` under
`CAPABILITIES.FEATURE_FLAGS` (`'feature-flags'`).

Zero dependencies. Providers own a cached snapshot plus an async `start()`/`stop()` lifecycle the
plugin drives, which is what lets `isEnabled` stay synchronous at the call site.

## Installation

```typescript
import { createFlagGuard, FeatureFlagsPlugin } from '@hono-enterprise/feature-flags-plugin';
```

## Usage

```typescript
import { createFlagGuard, FeatureFlagsPlugin } from '@hono-enterprise/feature-flags-plugin';
import { CAPABILITIES, type IFeatureFlags } from '@hono-enterprise/common';

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

## Providers

| `provider`   | Behaviour                                                                     |
| ------------ | ----------------------------------------------------------------------------- |
| `'config'`   | Immutable inline flags.                                                       |
| `'memory'`   | Mutable map — `setFlag` / `removeFlag` / `replaceFlags`.                      |
| `'database'` | Polls an injected `IFlagStore` on one interval; keeps the last good snapshot. |
| `'custom'`   | Any `FlagProvider` you supply.                                                |

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

Not supported. The LaunchDarkly Node server SDK's `variation`/`allFlagsState` are **async**, which
no provider can reconcile with the synchronous committed `isEnabled` contract. Use the `'custom'`
arm as a bridge.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
