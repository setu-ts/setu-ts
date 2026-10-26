# @setu-ts/feature-flags-plugin — control feature rollout and route access

**Add it:** `setu add feature-flags` adds it and prints the registration for `setu.config.ts`; add
`FeatureFlagsPlugin` with a provider. It provides `CAPABILITIES.FEATURE_FLAGS` (`IFeatureFlags`).

## Define a targeted rollout

```ts
import { FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';

export const flags = FeatureFlagsPlugin({
  provider: 'config',
  options: {
    flags: {
      'new-checkout': { enabled: false, users: ['user-1'] },
      'dark-mode': { enabled: true, percentage: 25 },
    },
  },
});
```

## Guard a route and evaluate a flag

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IFeatureFlags, IRouterApi } from '@setu-ts/common';
import { createFlagGuard } from '@setu-ts/feature-flags-plugin';

export function registerCheckoutRoutes(router: IRouterApi): void {
  router.get('/checkout', {
    middleware: [createFlagGuard('new-checkout', { fallback: '/waitlist' })],
    handler: (ctx) => {
      const flags = ctx.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
      const dark = flags.isEnabled('dark-mode', ctx.request.user ? { userId: ctx.request.user.id } : undefined);
      return ctx.response.json({ dark });
    },
  });
}
```

## Behaviour the types do not show

- For local definitions, unknown flags are false. A non-empty `tenants` list restricts first, then a
  matching `users` entry overrides even `enabled: false`.
- Partial percentage rollouts need `userId`; their bucket is deterministic for flag plus user.
  `percentage: 100` does not require a user id.
- The guard derives user and tenant ids from the request unless `context` overrides them. An enabled
  flag calls the handler; disabled redirects to `fallback` or returns 404 by default.
- Missing `CAPABILITIES.FEATURE_FLAGS` propagates the registry error instead of silently allowing.
- `isEnabled` is synchronous. `isEnabledAsync` awaits an asynchronous provider when available,
  otherwise resolves the synchronous result.

## Other options

- `provider` also selects `'memory'`, `'database'`, `'launchdarkly'` or `'custom'`.
- `MemoryProvider` supports `setFlag`, `removeFlag` and `replaceFlags`; config flags stay fixed.
- `statusCode` overrides the guard's refusal status; `fallback` takes precedence.
- LaunchDarkly accepts `sdkKey` or injected `client`, `fallbackValue`, `initTimeoutSeconds` and
  `ldOptions` in `options`.
