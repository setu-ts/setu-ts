# @setu-ts/multi-tenancy-plugin — resolve tenants and scope data

**Add it:** `setu add multi-tenancy` adds it and prints the registration for `setu.config.ts`.
`MultiTenancyPlugin` provides `CAPABILITIES.MULTI_TENANCY` (`IMultiTenancyService`).

## Require a tenant from the request host

Put this plugin in the config's plugins array:

```ts
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

export const tenancy = MultiTenancyPlugin({
  resolver: 'subdomain',
  subdomain: { baseDomain: 'example.com' },
  required: true,
});
```

## Read only the resolved tenant's orders

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService, IRouterApi } from '@setu-ts/common';

export function registerOrderRoutes(router: IRouterApi): void {
  router.get('/orders', {
    handler: async (ctx) => {
      const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      const orders = await tenancy.getRepository<{ id: string; total: number }>(ctx, 'Order').findAll();
      return ctx.response.json(orders);
    },
  });
}
```

## Behaviour the types do not show

- The middleware runs at priority 40 and sets `ctx.request.tenant`; unresolved required tenants
  answer `rejectionStatus` (default 400) before the handler.
- `subdomain.baseDomain` constrains hosts; without it, the first label of a multi-label host is
  used.
- `getRepository` throws `TenantNotResolvedError` without a resolved tenant.
- The default store is process-local memory. Isolation strategy names do not create schemas or
  databases: that needs an injected store implementing the selected strategy.
- The JWT resolver decodes an unverified claim; use authentication that separately verifies it.
- `getRepositoryFor` trusts its explicit tenant id; HTTP routes should use the resolved context.

## Other options

- `resolver` also accepts header, path, JWT or resolver instances tried in order.
- `database` selects column, schema or database isolation; `dataStore` accepts an instance or
  factory.
- `exclude` skips paths; `middlewarePriority` changes ordering.
- `prefixCacheKey` and `getTenantCachePrefix` scope cache keys; `cache.separator` defaults to `':'`.
