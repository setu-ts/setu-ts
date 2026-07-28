# @hono-enterprise/multi-tenancy-plugin

Multi-tenancy: tenant resolution, data isolation, and cache-key scoping. Registers an
`IMultiTenancyService` under `CAPABILITIES.MULTI_TENANCY` (`'multi-tenancy'`) and a tenant
middleware at priority 40.

## Installation

```typescript
import { MultiTenancyPlugin } from '@hono-enterprise/multi-tenancy-plugin';
```

## Usage

```typescript
import { MultiTenancyPlugin } from '@hono-enterprise/multi-tenancy-plugin';
import { CAPABILITIES, type IMultiTenancyService } from '@hono-enterprise/common';

app.register(MultiTenancyPlugin({
  resolver: 'subdomain',
  subdomain: { baseDomain: 'example.com' },
  database: 'schema-per-tenant',
  required: true,
}));

app.router.get('/orders', async (ctx) => {
  const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
  const tenant = tenancy.getCurrentTenant(ctx);
  const orders = tenancy.getRepository<Order, string>(ctx, 'Order');
  return ctx.response.json(await orders.findAll());
});
```

The resolved tenant is also available as `ctx.request.tenant`.

## Resolvers

`'subdomain'`, `'header'`, `'path'`, and `'jwt'` — or an array of them, tried in order.

**`subdomain` requires `baseDomain`** and constrains resolution to it: a request for an unrelated
host does not resolve a tenant.

## Isolation strategies

| `database`              | Isolation                                  |
| ----------------------- | ------------------------------------------ |
| `'column-per-tenant'`   | a tenant column on shared tables (default) |
| `'schema-per-tenant'`   | one schema per tenant                      |
| `'database-per-tenant'` | one database per tenant                    |

You may also pass a custom `ITenantIsolationStrategy`.

## Options

| Option               | Type                                               | Default                 | Description                              |
| -------------------- | -------------------------------------------------- | ----------------------- | ---------------------------------------- |
| `resolver`           | `ResolverConfig`                                   | **required**            | Resolver or ordered chain.               |
| `database`           | `DatabaseStrategyKind \| ITenantIsolationStrategy` | `'column-per-tenant'`   | Isolation strategy.                      |
| `dataStore`          | `ITenantDataStore`                                 | `MemoryTenantDataStore` | Backing store for tenant records.        |
| `cache`              | `TenantCacheOptions`                               | —                       | Cache-prefix behaviour.                  |
| `required`           | `boolean`                                          | `false`                 | Short-circuit when no tenant resolves.   |
| `rejectionStatus`    | `number`                                           | `400`                   | Status used when short-circuiting.       |
| `middlewarePriority` | `number`                                           | `40`                    | Priority passed to `ctx.middleware.add`. |

An **empty resolver chain** and a **malformed injected `dataStore`** both fail at `register()`, not
per request.

## Cache isolation

`prefixCacheKey(tenantId, key)` scopes cache keys so one tenant cannot read another's entries. The
middleware publishes the active prefix under `TENANT_CACHE_PREFIX_STATE_KEY`, readable with
`getTenantCachePrefix(ctx)`.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
