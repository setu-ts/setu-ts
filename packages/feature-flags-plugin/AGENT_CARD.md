# @setu-ts/feature-flags-plugin — feature flags with a route guard

`setu add feature-flags` adds the dependency and prints the registration line — it does not rewrite
the config. Add `FeatureFlagsPlugin(...)` to the `plugins` array in `setu.config.ts`; the built-in
providers need no npm package. It registers `CAPABILITIES.FEATURE_FLAGS`.

```ts
import { createFlagGuard, FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';

export const flags = FeatureFlagsPlugin({
  provider: 'config',
  options: {
    flags: {
      'new-checkout': { enabled: false, users: ['user-1'] },
      'dark-mode': { enabled: true, percentage: 25 },
    },
  },
});

export const betaOnly = createFlagGuard('new-checkout', { fallback: '/waitlist' });
```

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IFeatureFlags, IRequestContext } from '@setu-ts/common';

export function darkModeFor(context: IRequestContext): boolean {
  const flags = context.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
  return flags.isEnabled('dark-mode', { userId: context.params.id });
}
```

- `provider` is `'config'`, `'memory'`, `'database'`, `'launchdarkly'` or `'custom'`. The options
  type is discriminated on it, so a missing per-arm field is a compile error.
- `options` is required for `config`, `database`, `launchdarkly` and `custom`, and optional for
  `memory`. Only the memory provider is mutable: `setFlag`, `removeFlag`, `replaceFlags`.
- Evaluation order is a `tenants` restriction, then a `users` allowlist, then `enabled`, then
  `percentage`. A partial rollout with no `userId` evaluates to `false`.
- `isEnabled` is synchronous. The optional `isEnabledAsync` awaits the SDK — use it where a cold
  context's fallback answer would matter.
- `createFlagGuard` never calls next: it redirects `302` to `fallback`, else answers `statusCode`
  (default `404`). Put it in a route's `middleware` array.
- LaunchDarkly takes `sdkKey` or an injected `client`, plus `fallbackValue`, `initTimeoutSeconds`
  (default `5`) and `ldOptions`, forwarded to the SDK's `init`.
