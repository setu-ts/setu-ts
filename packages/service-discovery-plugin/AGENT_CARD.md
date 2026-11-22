# @setu-ts/service-discovery-plugin — locate service instances

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
- Selection defaults to round-robin; per-call `strategy` overrides it.
- Warm reads use cache; `cacheTtlMs` starts background refresh (30000 ms; `0` every call). Cold
  reads coalesce with `resolveTimeoutMs` (2000 ms; `0` unbounded).
- Failed refreshes retry after 1, 2, 4, 8, 16, then 30 s. `staleForMs` reports age; warm names stay
  ready.
- Reads/watches hold warm lists on empty answers for `emptyAnswerGraceMs` (30000 ms; `0` immediate).
  DNS absent names resolve `[]`; other lookup failures are unhealthy.
- Consul ids default to `<serviceName>-<address>-<port>`, stable across restarts.
- Ejection depends on application `report(instance, outcome)` calls. By default five failures within
  30000 ms eject for 30000 ms, subject to a 50% pool cap; success clears the state.
- Stop watches with the returned unsubscribe.

## Other options

- `provider` also selects `'consul'`, `'kubernetes'`, `'dns'` or `'custom'` with `discovery`.
- `strategy` also accepts `'random'` and `'weighted-random'`; `ejection: false` disables ejection.
- DNS requires runtime DNS; unsupported self-registration is refused.
- Failed deregistration warns with URL userinfo masked.
