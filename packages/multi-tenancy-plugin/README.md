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

### Identity bound to the tenant

Resolving a tenant does not by itself stop one tenant's identity acting on another tenant's host.
Bind each credential to it:

- **Bearer tokens.** Set `tenantClaim` on auth-plugin's `jwt` option and on each `issuers` entry. A
  token whose verified claim differs from the request's tenant is then refused, and so is a token
  carrying the claim on a request with no tenant. So the tenant must be resolved before
  authentication runs (priority 300); the built-in resolvers run at 40. Do not combine `tenantClaim`
  with the principal-derived resolver at priority 310 above: it resolves after authentication, so
  every bound token would be refused. See auth-plugin's
  [Binding tokens to the tenant](https://github.com/setu-ts/setu-ts/blob/main/packages/auth-plugin/README.md#binding-tokens-to-the-tenant).
- **Password sign-in.** `local.verify(identifier, secret, request)` and
  `verifyCredentials(credentials, request)` receive the request. Pass `ctx.request` and look the
  user up by `(request.tenant.id, identifier)`. A lookup by email alone lets a user of one tenant
  sign in on another tenant's host, and the session is then sealed to that host's tenant while
  carrying the other tenant's principal.
- **API keys.** `apiKey.validate(key, request)` receives the request: look the key up within
  `request.tenant`. `tenantClaim` does not cover API keys.
- **Sessions.** The session plugin's tenant binding, on by default, seals each session to the tenant
  that created it. It compares only when both the session and the request carry a tenant, and
  `tenantBinding: false` turns it off.

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

## Transactions

Pass the unit of work as the third argument to `getRepository` or `getRepositoryFor`, and the tenant
repository joins that transaction:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService, IRequestContext } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';

export async function placeOrder(ctx: IRequestContext): Promise<void> {
  const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
  await db.transaction(async (uow) => {
    await tenancy.getRepository(ctx, 'Order', uow).create({ id: 'o-1', total: 40 });
    await tenancy.getRepository(ctx, 'OrderLine', uow).create({ id: 'l-1', orderId: 'o-1' });
  });
}
```

Both writes commit or roll back together, and each keeps every tenant guard: the tenant column is
stamped on create and stripped from updates, and another tenant's row is never read, updated or
deleted. Only a store with `withUnitOfWork` can join a transaction. `createDatabaseTenantDataStore`
has it; `MemoryTenantDataStore` does not, so passing a unit of work with it throws
`TenantUnitOfWorkUnsupportedError` (status hint 500). On a deferred-write transaction (Cloudflare
D1) writes are buffered until commit, so a read or an update inside the transaction does not see a
row the same transaction created.

## Which tenants exist

Without `tenants`, any id a resolver returns is the tenant — a typo looks like an empty site and
anyone can mint tenants. With it, the middleware checks the first resolved id before the request
carries it:

```typescript
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

export const tenancyPlugin = MultiTenancyPlugin({
  resolver: 'subdomain',
  required: true,
  tenants: ['acme', 'globex'],
});
```

| Check                                    | Response                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| listed                                   | the registry's tenant (canonical `id`, `name`, `metadata`) is set |
| not listed, or longer than 256 chars     | `unknownTenantStatus` (default `404`) `Unknown Tenant`            |
| the registry threw or answered malformed | `503` `Tenant Registry Unavailable`                               |

Neither refusal runs the handler, and no response byte names the requested id. With or without
`tenants`, a custom resolver's empty or non-string id answers `unknownTenantStatus` too, as
`lookupTenant` answers `none()` for it. The fault warning never carries a registry's error message —
which may quote the id in any form — only each error's name and driver codes, e.g.
`<- Error (code=ECONNREFUSED, errno=-111, syscall=connect)`, with URL credentials masked. A registry
you write should keep the id out of error names and codes too: only an unaltered copy of it there is
masked. A miss does not fall through to the next resolver. The session binding compare and the cache
prefix use the registry's id, so `ACME` and `acme` cannot split a tenant when the registry answers
`acme`.

`tenants` also takes an `ITenantRegistry` (`lookup(id)` returning `some(tenant)` or `none()`) or a
factory resolved at `onInit`, such as `createDatabaseTenantRegistry()` from
`@setu-ts/database-plugin`. A registry must answer `none()` for "not found" — a throw means "could
not check" and answers `503` — and must bound its own I/O. Instance and factory registries are
cached (`tenantCache`): hits whose canonical id equals the requested id only, for `ttlMs` (default
30 s), so a suspended tenant stays admitted for up to that long (`ttlMs: 0` or `tenantCache: false`
removes the window). Misses are never cached, so each request naming an unknown tenant runs one
lookup: rate-limit a public resolver. Tenants are handed out as frozen copies holding only `id`, a
string `name` and a plain-object `metadata` (an array, `Map` or class instance is dropped), with
`metadata` frozen at the top level; deeper objects in `metadata` are shared between requests, so do
not mutate them.

A queue job or message handler checks a payload's tenant the same way:

```typescript
import type { IMultiTenancyService } from '@setu-ts/common';

export async function saveOrder(
  tenancy: IMultiTenancyService,
  payload: { tenantId: string; total: number },
): Promise<void> {
  const tenant = await tenancy.lookupTenant(payload.tenantId);
  if (!tenant.present) return; // unknown tenant: drop the job
  await tenancy.getRepositoryFor(tenant.value.id, 'Order').create({ total: payload.total });
}
```

`lookupTenant` throws `TenantRegistryUnavailableError` on a registry fault — let the job retry. If
an HTTP handler lets it escape, `errorHandler` answers the same `503` and logs the error with its
`cause` chain, so the registry's own message — which may quote the id — reaches the error log.
Without `tenants` it answers `some({ id })` for any non-empty string id, so it is not validation
without a registry. A non-string or empty id (a malformed payload) is `none()` either way.

`unknownTenantStatus: 403` answers an unknown tenant and a forbidden one alike in the status code
only: a listed tenant served from the cache still answers faster than an unknown one.

## Options

| Option                | Type                                                                                    | Default                                                     | Description                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver`            | `ResolverConfig`                                                                        | **required**                                                | Resolver or ordered chain.                                                                                                                                                             |
| `subdomain`           | `SubdomainResolverOptions`                                                              | —                                                           | Options forwarded to `SubdomainResolver` when the chain contains one.                                                                                                                  |
| `header`              | `HeaderResolverOptions`                                                                 | —                                                           | Options forwarded to `HeaderResolver`.                                                                                                                                                 |
| `path`                | `PathResolverOptions`                                                                   | —                                                           | Options forwarded to `PathResolver`.                                                                                                                                                   |
| `jwt`                 | `JwtResolverOptions`                                                                    | —                                                           | Options forwarded to `JwtResolver`. The tenant claim is **unverified** — require authentication middleware alongside it.                                                               |
| `database`            | `DatabaseStrategyKind \| ITenantIsolationStrategy`                                      | `'column-per-tenant'`                                       | Isolation strategy.                                                                                                                                                                    |
| `dataStore`           | `ITenantDataStore \| RegistryFactory<ITenantDataStore>`                                 | `MemoryTenantDataStore`                                     | Backing store for tenant records. A factory (for example `createDatabaseTenantDataStore()`) is resolved once at `onInit`, so it may read a capability such as `CAPABILITIES.DATABASE`. |
| `cache`               | `TenantCacheOptions`                                                                    | —                                                           | Cache-prefix behaviour.                                                                                                                                                                |
| `required`            | `boolean`                                                                               | `false`                                                     | Short-circuit when no tenant resolves.                                                                                                                                                 |
| `rejectionStatus`     | `number`                                                                                | `400`                                                       | Status used when short-circuiting.                                                                                                                                                     |
| `middlewarePriority`  | `number`                                                                                | `40`                                                        | Priority passed to `ctx.middleware.add`.                                                                                                                                               |
| `exclude`             | `readonly PathPattern[]`                                                                | six operational paths                                       | Paths skipped entirely; a match goes straight to `next()`. `[]` exempts nothing.                                                                                                       |
| `tenants`             | `readonly (string \| ITenant)[] \| ITenantRegistry \| RegistryFactory<ITenantRegistry>` | —                                                           | Which tenants exist; see above. A list is validated at `register()`.                                                                                                                   |
| `unknownTenantStatus` | `number`                                                                                | `404`                                                       | Status of `Unknown Tenant`, 400–499; 400, 403 or 404 recommended (a 401 may prompt a browser for credentials).                                                                         |
| `tenantCache`         | `false \| TenantRegistryCacheOptions`                                                   | `{ ttlMs: 30_000, maxEntries: 1_000, maxBytes: 1_048_576 }` | Cache around an instance or factory registry; refused with a list.                                                                                                                     |

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

| Export                             | Kind      |
| ---------------------------------- | --------- |
| `getTenantCachePrefix`             | function  |
| `MultiTenancyPlugin`               | function  |
| `tenantMiddleware`                 | function  |
| `ColumnPerTenant`                  | class     |
| `DatabasePerTenant`                | class     |
| `HeaderResolver`                   | class     |
| `JwtResolver`                      | class     |
| `MemoryTenantDataStore`            | class     |
| `PathResolver`                     | class     |
| `SchemaPerTenant`                  | class     |
| `SubdomainResolver`                | class     |
| `TenantDataStoreNotReadyError`     | class     |
| `TenantNotResolvedError`           | class     |
| `TenantRegistryUnavailableError`   | class     |
| `TenantUnitOfWorkUnsupportedError` | class     |
| `CAPABILITIES`                     | const     |
| `TENANT_CACHE_PREFIX_STATE_KEY`    | const     |
| `HeaderResolverOptions`            | interface |
| `IMultiTenancyService`             | interface |
| `ITenant`                          | interface |
| `ITenantDataStore`                 | interface |
| `ITenantRegistry`                  | interface |
| `ITenantRepository`                | interface |
| `ITenantResolver`                  | interface |
| `JwtResolverOptions`               | interface |
| `MemoryTenantDataStoreOptions`     | interface |
| `MultiTenancyPluginOptions`        | interface |
| `PathResolverOptions`              | interface |
| `SubdomainResolverOptions`         | interface |
| `TenantCacheOptions`               | interface |
| `TenantRegistryCacheOptions`       | interface |
| `DatabaseStrategyKind`             | type      |
| `ITenantIsolationStrategy`         | type      |
| `ResolverConfig`                   | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#multi-tenancy-plugin-setu-tsmulti-tenancy-plugin).
