# @setu-ts/multi-tenancy-plugin — tenant resolution and scoped data

`setu add multi-tenancy` adds the dependency and prints the registration line; add
`MultiTenancyPlugin(...)` to the `plugins` array in `setu.config.ts`. `resolver` is required. The
plugin registers `CAPABILITIES.MULTI_TENANCY` and a middleware at priority 40 that sets
`ctx.request.tenant`.

```ts
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

export const tenancy = MultiTenancyPlugin({
  resolver: 'subdomain',
  subdomain: { baseDomain: 'example.com' },
  required: true,
  rejectionStatus: 400,
});
```

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService, IRequestContext } from '@setu-ts/common';

interface Order {
  id: string;
  total: number;
}

export async function listOrders(context: IRequestContext): Promise<readonly Order[]> {
  const tenancy = context.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
  return await tenancy.getRepository<Order>(context, 'Order').findAll();
}
```

- `resolver` is `'subdomain'`, `'header'`, `'path'`, `'jwt'`, or a chain of resolver instances tried
  in order. With `subdomain.baseDomain` set, only hosts under it resolve; without it, the host's
  first label is the tenant.
- `jwt` reads an UNVERIFIED claim — anyone can mint a token naming a tenant. Use it only beside
  authentication middleware that verifies the token, e.g. auth-plugin's.
- `database` is `'column-per-tenant'` (default), `'schema-per-tenant'` or `'database-per-tenant'`,
  or an `ITenantIsolationStrategy`. It NAMES the isolation a store must implement; the default
  memory store isolates logically, and `@setu-ts/database-plugin`'s store supports the column
  strategy only.
- `required: true` short-circuits a request with no tenant, answering `rejectionStatus` (default
  `400`); `exclude` lists skipped paths and `middlewarePriority` overrides 40.
- `getRepositoryFor(tenantId, entity)` is the ctx-free entry point for jobs and ingress; its id is
  TRUSTED input. `prefixCacheKey` and `getTenantCachePrefix` scope cache keys by tenant.
