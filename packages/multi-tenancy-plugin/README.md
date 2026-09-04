# @setu-ts/multi-tenancy-plugin

Multi-tenancy: tenant resolution, data isolation, and cache-key scoping. Registers an
`IMultiTenancyService` under `CAPABILITIES.MULTI_TENANCY` (`'multi-tenancy'`) and a tenant
middleware at priority 40.

## Installation

```typescript
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
```

## Usage

```typescript
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { CAPABILITIES, type IMultiTenancyService } from '@setu-ts/common';

app.register(MultiTenancyPlugin({
  resolver: 'subdomain',
  subdomain: { baseDomain: 'example.com' },
  database: 'column-per-tenant',
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

**`jwt` reads an UNVERIFIED claim** — the tenant id comes from a token whose signature nobody has
checked, so a client can mint a token naming any tenant. Use it only alongside authentication
middleware which separately verifies the token (e.g. `AuthPlugin`). A `register()` warning fires
whenever the resolved chain contains a `JwtResolver`.

## Isolation strategies

A strategy NAMES the isolation an `ITenantDataStore` is expected to implement — selecting one does
not by itself create schemas or databases. The shipped `MemoryTenantDataStore` uses the strategy's
label as its partition-map key, so all three isolate correctly on it, and a store may ignore
isolation metadata entirely (see `ITenantDataStore.useIsolation`). No shipped database adapter is
told the strategy.

| `database`              | Strategy names                                      |
| ----------------------- | --------------------------------------------------- |
| `'column-per-tenant'`   | a tenant column on shared tables (default)          |
| `'schema-per-tenant'`   | a per-tenant schema the injected store implements   |
| `'database-per-tenant'` | a per-tenant database the injected store implements |

You may also pass a custom `ITenantIsolationStrategy`.

A **`register()` warning** fires when a non-`'column-per-tenant'` strategy is selected and no
`dataStore` is injected: the default memory store cannot deliver physical isolation, so the
selection is flagged rather than silently logical-only.

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

## Exports

| Export                          | Kind      |
| ------------------------------- | --------- |
| `getTenantCachePrefix`          | function  |
| `MultiTenancyPlugin`            | function  |
| `tenantMiddleware`              | function  |
| `ColumnPerTenant`               | class     |
| `DatabasePerTenant`             | class     |
| `HeaderResolver`                | class     |
| `JwtResolver`                   | class     |
| `MemoryTenantDataStore`         | class     |
| `PathResolver`                  | class     |
| `SchemaPerTenant`               | class     |
| `SubdomainResolver`             | class     |
| `TenantNotResolvedError`        | class     |
| `CAPABILITIES`                  | const     |
| `TENANT_CACHE_PREFIX_STATE_KEY` | const     |
| `HeaderResolverOptions`         | interface |
| `IMultiTenancyService`          | interface |
| `ITenant`                       | interface |
| `ITenantDataStore`              | interface |
| `ITenantRepository`             | interface |
| `ITenantResolver`               | interface |
| `JwtResolverOptions`            | interface |
| `MemoryTenantDataStoreOptions`  | interface |
| `MultiTenancyPluginOptions`     | interface |
| `PathResolverOptions`           | interface |
| `SubdomainResolverOptions`      | interface |
| `TenantCacheOptions`            | interface |
| `DatabaseStrategyKind`          | type      |
| `ITenantIsolationStrategy`      | type      |
| `ResolverConfig`                | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#multi-tenancy-plugin-setu-tsmulti-tenancy-plugin).
