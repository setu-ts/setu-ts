# @setu-ts/service-discovery-plugin

**Add:** `setu add service-discovery`; register in `setu.config.ts`. Provides
`CAPABILITIES.SERVICE_DISCOVERY` (`IServiceDiscovery`).

## Static pool

```ts
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

export const discovery = ServiceDiscoveryPlugin({
  provider: 'static',
  services: {
    billing: [{ host: '10.0.0.1', port: 8080 }, { host: '10.0.0.2', port: 8080 }],
  },
});
```

## URL

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

## Rules

- `resolve` includes ejected instances; `pick` filters with full-pool fallback. `pick`/`resolveUrl`
  return `null` when empty. Default: round-robin.
- Warm reads use cache; a read (watched too) starts background refresh once `cacheTtlMs` old (30000
  ms; `0` every call; bad values refused). Cold reads share `resolveTimeoutMs` (2000 ms; `0`
  unbounded).
- Failed warm refreshes retry at 1, 2, 4, 8, 16, 30 s; cold failures are unspaced.
- `emptyAnswerGraceMs` holds warm lists on empty answers (30000 ms; `0` immediate). A timer re-reads
  at expiry; empty results reach watchers without another event. Nonempty answers/close clear it.
- One provider watch per name; joiners get the cache at once; lists may repeat.
- Data `degraded` (status stays `up`): warm failures/held empties. `staleForMs`: failed-list age.
  All providers cache health for 5 s; DNS uses its last lookup outcome. DNS absent names resolve
  `[]`; other errors reject.
- Warm reporters survive cold failures (256 cold reporters; 20 cold warns/min). At most 256
  unwatched empty-only names stay cached. Sync/async listener errors are isolated, warn once.
  Superseded reads open no outage.
- Consul ids default to `<serviceName>@<address>:<port>`; escape `%`/`@` as `%25`/`%40`.
- Five failures in 30000 ms eject for 30000 ms, with a 50% pool cap; success clears state.

Providers: static/consul/kubernetes/dns/custom. Strategies: random/weighted-random.
`ejection: false` disables ejection. DNS requires runtime DNS.
