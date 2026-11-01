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
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { CAPABILITIES, type IMultiTenancyService, type IRequestContext } from '@setu-ts/common';

// Your application's own entity — a stand-in so this compiles as written.
interface Order {
  id: string;
  total: number;
}

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    MultiTenancyPlugin({
      resolver: 'subdomain',
      subdomain: { baseDomain: 'example.com' },
      database: 'column-per-tenant',
      required: true,
    }),
  ],
});

// Plugins register during `start()`, so the capability is resolvable only after it.
await app.start({ port: 3000 });

const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);

// In a route handler the middleware has resolved `ctx.request.tenant` first.
export async function listOrders(ctx: IRequestContext): Promise<readonly Order[]> {
  const orders = tenancy.getRepository<Order, string>(ctx, 'Order');
  return orders.findAll();
}
```

The resolved tenant is also available as `ctx.request.tenant`.

## Resolvers

`'subdomain'`, `'header'`, `'path'`, and `'jwt'` — or an array of them, tried in order.

**`subdomain` takes an optional `baseDomain`.** With one, it constrains resolution to that domain: a
request for an unrelated host does not resolve a tenant. Without one, the first label of any
multi-label host is the tenant id, and a single-label host such as `localhost` resolves nothing.

**`jwt` reads an UNVERIFIED claim** — the tenant id comes from a token whose signature nobody has
checked, so a client can mint a token naming any tenant. Use it only alongside authentication
middleware which separately verifies the token (e.g. `AuthPlugin`). A `register()` warning fires
whenever the resolved chain contains a `JwtResolver`.

## Tenant from the signed-in principal

Use a custom `ITenantResolver` when the tenant must come from a verified principal rather than the
built-in resolver's unverified JWT decode. Register it above passive authentication's priority 300,
for example 310:

```typescript
import { none, some, type ITenantResolver } from '@setu-ts/common';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

const resolver: ITenantResolver = {
  resolve(request) {
    const tenantId = request.user?.claims?.tenantId;
    return Promise.resolve(typeof tenantId === 'string' ? some({ id: tenantId }): none());
  },
};
const tenancy = MultiTenancyPlugin({ resolver, middlewarePriority: 310, required: true });
```

Compose `tenancy` with `AuthPlugin` configured to verify credentials. Everything before 310 sees no
tenant: localization's `tenantLocale` at 45, and any cache, rate-limit or feature-flag lookup in the
40–310 band cannot use it. Move dependent readers after resolution or use them per route. See
[session tenant binding](https://github.com/setu-ts/setu-ts/blob/main/packages/session-plugin/README.md#tenant-binding)
for the session check that also handles late resolution.

`ITenantRepository` offers `findAll()`, `findById`, `find(filter)`, `create`, `update`, and
`delete`, plus `updateWhere(id, where, data)` and `deleteWhere(id, where)` when the configured store
supports conditional writes (the shipped memory store and `createDatabaseTenantDataStore()` both do,
since 0.12.0). Those combine your `where` with the tenant into one precondition, so
`updateVersioned(tenantRepository, id, version, data)` from `@setu-ts/database-plugin` gives
optimistic locking on the tenant path; a `where` naming the tenant column is refused. It has no
paging, ordering or expression-filter options. For those, use `IDatabaseService` repositories and
scope every operation to the verified tenant yourself:

- **Reads:** filter on the tenant column (`findOne({ where: { id, tenantId } })`), never
  `findById(id)` with a client-supplied id.
- **Writes:** use `updateWhere(id, { tenantId }, data)` and `deleteWhere(id, { tenantId })`, which
  apply only while the stored row still carries that tenant. Key-only `update(id, data)` and
  `delete(id)` select by key alone, so a client-supplied id can reach another tenant's row — putting
  the tenant column in `data` does not prevent that.
- Where a data source lacks conditional writes (the call rejects with `conditional-write`), do not
  fall back to a key-only write or to a read-then-write ownership check, which races a concurrent
  delete-and-recreate. Isolate the tenant's data physically instead (a schema or database per
  tenant).

## Isolation strategies

A strategy NAMES the isolation an `ITenantDataStore` is expected to implement — selecting one does
not by itself create schemas or databases. The shipped `MemoryTenantDataStore` uses the strategy's
label as its partition-map key, so all three isolate correctly on it, and a store may ignore
isolation metadata entirely (see `ITenantDataStore.useIsolation`).

The shipped database bridge, `createDatabaseTenantDataStore` from `@setu-ts/database-plugin`, is the
one store told the strategy over a real backend. It supports **`'column-per-tenant'` only**: it
conjoins the tenant column to every read and stamps it on every write. Selecting
`'schema-per-tenant'` or `'database-per-tenant'` with it throws
`TenantStoreStrategyUnsupportedError` at startup, because `IRepository` offers no schema or database
switch — a silent accept would be a store that claims isolation it does not deliver.
`'schema-per-tenant'` and `'database-per-tenant'` therefore still require a store you inject
yourself.

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

| Option               | Type                                                    | Default                 | Description                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver`           | `ResolverConfig`                                        | **required**            | Resolver or ordered chain.                                                                                                                                                             |
| `subdomain`          | `SubdomainResolverOptions`                              | —                       | Options forwarded to `SubdomainResolver` when the chain contains one.                                                                                                                  |
| `header`             | `HeaderResolverOptions`                                 | —                       | Options forwarded to `HeaderResolver`.                                                                                                                                                 |
| `path`               | `PathResolverOptions`                                   | —                       | Options forwarded to `PathResolver`.                                                                                                                                                   |
| `jwt`                | `JwtResolverOptions`                                    | —                       | Options forwarded to `JwtResolver`. The tenant claim is **unverified** — require authentication middleware alongside it.                                                               |
| `database`           | `DatabaseStrategyKind \| ITenantIsolationStrategy`      | `'column-per-tenant'`   | Isolation strategy.                                                                                                                                                                    |
| `dataStore`          | `ITenantDataStore \| RegistryFactory<ITenantDataStore>` | `MemoryTenantDataStore` | Backing store for tenant records. A factory (for example `createDatabaseTenantDataStore()`) is resolved once at `onInit`, so it may read a capability such as `CAPABILITIES.DATABASE`. |
| `cache`              | `TenantCacheOptions`                                    | —                       | Cache-prefix behaviour.                                                                                                                                                                |
| `required`           | `boolean`                                               | `false`                 | Short-circuit when no tenant resolves.                                                                                                                                                 |
| `rejectionStatus`    | `number`                                                | `400`                   | Status used when short-circuiting.                                                                                                                                                     |
| `middlewarePriority` | `number`                                                | `40`                    | Priority passed to `ctx.middleware.add`.                                                                                                                                               |
| `exclude`            | `readonly PathPattern[]`                                | six operational paths   | Paths skipped entirely; a match goes straight to `next()`. `[]` exempts nothing.                                                                                                       |

An **empty resolver chain** and a **malformed injected `dataStore`** both fail at `register()`, not
per request.

## Non-HTTP ingress (a tenant concern in a behaviour)

`getRepositoryFor(tenantId, entity)` is the ctx-free entry point: the `IRequestContext`-taking
members are unreachable from a non-HTTP path, which has no request to resolve a tenant from. An
ingress behaviour reads the tenant id from the work item's own payload and scopes through it. The id
is TRUSTED INPUT — nothing resolves it — so on the HTTP path keep using `getRepository(ctx, …)`,
which reads the middleware-resolved tenant.

```typescript
import type { IIngressBehavior, IngressContext, RegistryFactory } from '@setu-ts/common';
import { CAPABILITIES, type IMultiTenancyService } from '@setu-ts/common';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

// The tenant concern, expressed ONCE for this ingress kind. RegistryFactory
// entries resolve during `onInit`, so the behaviour holds the resolved service.
const tenantScopedWrite: RegistryFactory<IIngressBehavior> = (services) => {
  const tenancy = services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
  return {
    handle: (ctx: IngressContext, next: () => Promise<void>) => {
      const payload = ctx.payload as { tenantId: string; event: { id: string } };
      const audit = tenancy.getRepositoryFor<{ id: string }>(payload.tenantId, 'Audit');
      return audit.create({ id: payload.event.id }).then(() => next());
    },
  };
};

export const messaging = MessagingPlugin({
  broker: 'memory',
  behaviors: [tenantScopedWrite],
});
```

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
| `TenantDataStoreNotReadyError`  | class     |
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

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#multi-tenancy-plugin-setu-tsmulti-tenancy-plugin).
