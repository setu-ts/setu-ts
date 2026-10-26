# @setu-ts/service-discovery-plugin — locate and select service instances

**Add it:** `setu add service-discovery` adds it and prints the registration for `setu.config.ts`.
It provides `CAPABILITIES.SERVICE_DISCOVERY` (`IServiceDiscovery`).

## Configure a static service pool

```ts
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

export const discovery = ServiceDiscoveryPlugin({
  provider: 'static',
  services: {
    billing: [{ host: '10.0.0.1', port: 8080 }, { host: '10.0.0.2', port: 8080 }],
  },
});
```

## Resolve an upstream URL from a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IServiceDiscovery } from '@setu-ts/common';

export function registerBillingRoutes(router: IRouterApi): void {
  router.get('/billing-location', {
    handler: async (ctx) => {
      const discovery = ctx.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
      const url = await discovery.resolveUrl('billing', '/invoices');
      return url === null
        ? ctx.response.status(503).json({ error: 'No billing instance' })
        : ctx.response.json({ url });
    },
  });
}
```

## Behaviour the types do not show

- `resolveUrl` and `pick` return `null` for an empty pool. `resolve` lists all known instances,
  including ejected ones; `pick` filters ejected instances, falling back to the full pool if needed.
- Selection defaults to round-robin. A per-call `strategy` overrides the configured default.
- Resolved lists are cached for 30000 ms by default; `cacheTtlMs: 0` disables cache reuse.
  Concurrent cold reads of one service share a backend read.
- Ejection depends on application `report(instance, outcome)` calls. By default five failures within
  30000 ms eject for 30000 ms, subject to a 50% pool cap; success clears the state.
- A watch delivers the full list and refreshes the cache on change. Stop it using the returned
  unsubscribe function.

## Other options

- `provider` also selects `'consul'`, `'kubernetes'`, `'dns'` or `'custom'` with `discovery`.
- `strategy` also accepts `'random'` and `'weighted-random'`; `ejection: false` disables ejection.
- `selfRegistration` is Consul-only; other providers reject it with
  `SelfRegistrationNotSupportedError`. DNS requires the runtime DNS surface.
