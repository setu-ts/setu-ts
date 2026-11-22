# @setu-ts/service-discovery-plugin

**Add:** `setu add service-discovery`; register the printed plugin in `setu.config.ts`. It provides
`CAPABILITIES.SERVICE_DISCOVERY` (`IServiceDiscovery`).

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

- `resolve` includes ejected instances; `pick` filters with full-pool fallback. `pick`/`resolveUrl`
  return `null` for an empty pool. Default strategy: round-robin.
- Warm reads use cache; `cacheTtlMs` starts background refresh (30000 ms; `0` every call). Cold
  reads share `resolveTimeoutMs` (2000 ms; `0` unbounded).
- Failures retry after 1, 2, 4, 8, 16, then 30 s. `staleForMs` reports age; warm names stay ready.
- `emptyAnswerGraceMs` holds warm lists on empty answers (30000 ms; `0` immediate). A timer re-reads
  at expiry; an empty result reaches all watchers without another backend event. Reads notify
  changes once. Nonempty answers, replacement and close clear the timer; watches still refresh by
  TTL.
- `degraded` covers warm failures and held empty answers. Cold failures discard state/reporters.
  Every provider's health result uses a 5 s cache; DNS uses the last lookup outcome.
- Consul ids default to `<serviceName>-<address>-<port>`; use the instance's own address.
- Five failures in 30000 ms eject for 30000 ms, with a 50% pool cap; success clears the state.
- Unsubscribe stops watches. DNS absent names resolve `[]`; other errors reject.

## Other options

- Providers: static, consul, kubernetes, dns, or custom with `discovery`.
- Strategies: random/weighted-random; `ejection: false` disables ejection.
- DNS requires runtime DNS; unsupported self-registration is refused.
