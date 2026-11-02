# Milestone 127 — A registry of real tenants (`@setu-ts/multi-tenancy-plugin`)

> **Status:** Planning. Branch: `feat/m127-tenant-registry`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Today a tenant is whatever the request names. The four shipped resolvers return `some({ id })` from
a trimmed header, the left-most host label, a path segment or an unverified JWT claim, and the
tenant middleware installs that id without comparing it with anything. Column isolation stops this
becoming a data leak, but every write under an invented tenant creates rows, a typo looks like an
empty site instead of an error, and anyone can mint unlimited tenants (rows, cache keys, per-tenant
rate-limit buckets). This milestone adds a tenant registry: a port in `common`, a `tenants` option
on `MultiTenancyPlugin` that checks every resolved id against it before the tenant reaches the
request, a bounded cache for registries that do I/O, a database-backed registry in
`database-plugin`, and a `lookupTenant` member so non-HTTP handlers validate a payload's tenant the
same way.

- **In scope:** `ITenantRegistry` and `IMultiTenancyService.lookupTenant` in `common`; the
  `tenants`, `unknownTenantStatus` and `tenantCache` options, the registry step in the tenant
  middleware, the static registry, the caching wrapper and `TenantRegistryUnavailableError` in
  `multi-tenancy-plugin`; `createDatabaseTenantRegistry` in `database-plugin`; `apps/multi-tenant`
  on `tenants: ['acme', 'globex']`; PUBLIC_API, READMEs, agent cards, CHANGELOG,
  `docs/upgrading.md`, `docs/examples.md`.
- **NOT this milestone:** a `setu add multi-tenancy` scaffold that writes a `tenants` list (the CLI
  template batch, M131c, or a later CLI milestone — the generated
  `MultiTenancyPlugin({ resolver: 'header' })` stays as it is); tenant administration
  (create/suspend endpoints, a tenant entity migration) — application code; cache invalidation by
  event (a suspended tenant is served until its cache entry expires, §3.7); negative caching (§3.7,
  §8a T5).

## 1. Contracts verified from SOURCE (not names)

Read at `develop` `29be2e77b`.

| Reference                                                 | Source (file:line)                                                                                                                   | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ITenant`                                                 | `packages/common/src/services/tenancy.ts:15-22`                                                                                      | `{ readonly id: string; readonly name?: string; readonly metadata?: Readonly<Record<string, unknown>> }`                                                                                                                                                                                                                                                                                               |
| `IMultiTenancyService`                                    | `packages/common/src/services/tenancy.ts:78-128`                                                                                     | `getCurrentTenant(ctx)`, `getRepository(ctx, entity)`, `getRepositoryFor(tenantId, entity)` (id is TRUSTED input, `:102-106`), `prefixCacheKey(tenantId, key)`. No lookup member.                                                                                                                                                                                                                      |
| `ITenantResolver`                                         | `packages/common/src/services/tenancy.ts:145-153`                                                                                    | `resolve(request): Promise<Option<ITenant>>`                                                                                                                                                                                                                                                                                                                                                           |
| `RegistryFactory<T>` / `resolveRegistryEntry`             | `packages/common/src/registry.ts:66`, `:216-229`                                                                                     | `(services) => T`; `resolveRegistryEntry` discriminates on `typeof entry === 'function'`, wraps a factory throw in an `Error` naming the label with `cause`                                                                                                                                                                                                                                            |
| `Option`, `some`, `none`                                  | `packages/common/src/option.ts:68`, `:78`                                                                                            | `some(value)`, `none()`; `.present` / `.value` (read by the middleware, `tenant-middleware.ts:127-128`)                                                                                                                                                                                                                                                                                                |
| `respondWithError`                                        | `packages/common/src/errors/error-responder.ts:245`                                                                                  | `(target, { status, title, detail? })`; sanitizes the status, writes the configured format or the fallback `{ error, detail? }`                                                                                                                                                                                                                                                                        |
| `replaceTenant`                                           | `packages/common/src/request-identity.ts:293`                                                                                        | installs `request.tenant`, bypassing the single-write seal                                                                                                                                                                                                                                                                                                                                             |
| `describeError`                                           | `packages/common/src/errors/describe-error.ts:51`                                                                                    | bounded, masked one-line description of a thrown value (M119g, M131a)                                                                                                                                                                                                                                                                                                                                  |
| Tenant middleware                                         | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:110-195`                                                          | excluded paths go straight to `next()` (`:115-118`); first present resolver result wins, a throwing resolver is warned and skipped (`:121-139`); `replaceTenant` (`:142`); session tenant-binding compare against the parked session → `403 Tenant Mismatch` (`:158-171`); cache-prefix stamp (`:174-177`); `required` with no tenant → `rejectionStatus` (default 400) `Tenant Required` (`:184-191`) |
| Default exclusions                                        | `tenant-middleware.ts:60-67`                                                                                                         | `/live`, `/ready`, `/health`, `/metrics`, `/openapi.json`, `/docs`                                                                                                                                                                                                                                                                                                                                     |
| Resolvers                                                 | `resolvers/header-resolver.ts:19-23, 45-50`; `subdomain-resolver.ts:26-47, 72-81`; `path-resolver.ts:19-41`; `jwt-resolver.ts:42-60` | each returns `some({ id })` only — never `name`/`metadata`. **No length bound on any id**: the header resolver only trims; a header-supplied id can be as long as the server's header limit allows                                                                                                                                                                                                     |
| Plugin options                                            | `packages/multi-tenancy-plugin/src/interfaces/index.ts:94-164`                                                                       | `resolver`, `subdomain`, `header`, `path`, `jwt`, `database`, `dataStore`, `cache`, `required`, `rejectionStatus`, `middlewarePriority`, `exclude`. Nothing names which tenants exist                                                                                                                                                                                                                  |
| `dataStore` factory arm                                   | `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:263-311`                                                           | instance validated in `register()` (`assertUsableStore`, `:116-124`); factory resolved in `ctx.lifecycle.onInit` via `resolveRegistryEntry`, then bound to the service (`bindStore`)                                                                                                                                                                                                                   |
| Health indicator                                          | `multi-tenancy-plugin.ts:331-345`                                                                                                    | `up` with `{ resolver, strategy, store }`; `store` is `'factory'` until `onInit` binds it                                                                                                                                                                                                                                                                                                              |
| `MultiTenancyService`                                     | `packages/multi-tenancy-plugin/src/services/multi-tenancy-service.ts:28-95`                                                          | late-bound store (`bindStore`), `TenantDataStoreNotReadyError` before `onInit`                                                                                                                                                                                                                                                                                                                         |
| Implementers of `IMultiTenancyService` outside the plugin | `grep` over `packages/` and `apps/`                                                                                                  | test doubles only: `common/test/unit/barrel-exports.test.ts:381`, `messaging-plugin/test/integration/tenant-behaviour.test.ts:47`, `multi-tenancy-plugin/test/fixtures/fake-context.ts:28`                                                                                                                                                                                                             |
| `createDatabaseTenantDataStore`                           | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts:253-258`                                                         | `RegistryFactory<ITenantDataStore>` resolving `CAPABILITIES.DATABASE` as `IDatabaseService`                                                                                                                                                                                                                                                                                                            |
| `IRepository.findOne` / `FindOptions.where`               | `packages/database-plugin/src/interfaces/index.ts:99`; `src/query/find-options.ts:29-31`                                             | `findOne({ where: Record<string, unknown> })` → first match or `null`; `where` is keyed by the entity's field name                                                                                                                                                                                                                                                                                     |
| Drizzle on SQLite in tests                                | `packages/database-plugin/test/integration/drizzle-query-sqlite.test.ts:1-30`                                                        | `node:sqlite` `DatabaseSync` behind `drizzle-orm/sqlite-proxy` — no external service                                                                                                                                                                                                                                                                                                                   |
| Full-stack starter pass-through                           | `packages/starters/full-stack-starter/src/options.ts:71`, `src/app.ts:77`                                                            | `multiTenancy?: MultiTenancyPluginOptions` passed straight to `MultiTenancyPlugin`, so new options reach starter users with no starter change                                                                                                                                                                                                                                                          |
| CLI scaffold                                              | `packages/cli/src/commands/add.ts:372`                                                                                               | `setu add multi-tenancy` writes `MultiTenancyPlugin({ resolver: 'header' })` (unchanged, §0)                                                                                                                                                                                                                                                                                                           |
| `apps/multi-tenant`                                       | `apps/multi-tenant/setu.config.ts:11-25`, `smoke.ts`                                                                                 | header resolver, `required: true`, tenants `tenant-a`/`tenant-b` in the smoke                                                                                                                                                                                                                                                                                                                          |
| Ingress envelope                                          | `packages/common/src/services/ingress.ts:30-56`                                                                                      | no tenant and no `services`; a tenant concern reads the id from `payload` and uses the ctx-free members of `IMultiTenancyService`                                                                                                                                                                                                                                                                      |
| gRPC and WebSocket upgrades                               | `packages/grpc-plugin/src/plugin/grpc-plugin.ts:1-8`; `packages/runtime/src/adapters/node/node-http-adapter.ts:30-45`                | gRPC dispatch runs after the middleware pipeline (M70a); the Node upgrade path carries the upgrade intent through the pipeline — the tenant middleware covers both                                                                                                                                                                                                                                     |
| CMS demo workaround                                       | `~/Projects/setu-cms-demo/PLAN.md` D2                                                                                                | a custom resolver wrapping the subdomain resolver, admitting only `acme`/`globex`, `required: true`; unknown host answers `400 Tenant Required`                                                                                                                                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                 | Resolution (picked side)                                                                                                                         | Doc deliverable (same PR)                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M127 decision 5 asks for an entry AND a byte bound on the cache "because the key is a request-supplied string"; this plan also caps the id length (§3.3), which bounds every key | Keep both bounds (§3.7): the byte bound also covers the cached tenant VALUE (`name` and `metadata` from the registry), which the id cap does not | none — the ROADMAP stays correct                                                                                                                         |
| C2  | `apps/multi-tenant/smoke.ts` uses `tenant-a`/`tenant-b`; ROADMAP M127's gate names `tenants: ['acme', 'globex']`                                                                         | ROADMAP's names                                                                                                                                  | `apps/multi-tenant` (config, smoke, README) and `docs/examples.md` use `acme`/`globex`                                                                   |
| C3  | PUBLIC_API.md's multi-tenancy section (`PUBLIC_API.md:9116-9210`) documents "any resolved id is the tenant" by omission — it lists no registry                                           | This plan's behaviour                                                                                                                            | PUBLIC_API.md: `ITenantRegistry`, `lookupTenant`, the three options, the registry step, `TenantRegistryUnavailableError`, `createDatabaseTenantRegistry` |

## 3. Design decisions

### 3.1 The port in `common`

- **Decision:** `packages/common/src/services/tenancy.ts` gains

  ```ts
  export interface ITenantRegistry {
    lookup(id: string): Promise<Option<ITenant>>;
  }
  ```

  `none()` means "does not exist or is not active". `some(tenant)` returns the tenant the request
  will carry; its `id` is the canonical id (§3.4). Exported as a type from the `common` barrel.

- **Why:** `database-plugin` implements it by name without importing the plugin (AI_GUIDELINES
  §2.2), the same reason `ITenantDataStore` moved to `common` in M101c.
- **Test home:** `common/test/unit/barrel-exports.test.ts` (type reachable; a structural instance
  compiles).

### 3.2 The `tenants` option — three shapes, one parse at `register()`

- **Decision:**
  `tenants?: readonly (string | ITenant)[] | ITenantRegistry | RegistryFactory<ITenantRegistry>`.
  Parsed once in `register()`:
  - **Array** → an internal `StaticTenantRegistry` (a `Map<string, ITenant>`). Refused at
    `register()` with an `Error` naming the option: an empty array; a non-string id; an empty id; an
    id that differs from its trimmed form (the header resolver trims, so it could never match); an
    id longer than `MAX_TENANT_ID_LENGTH` (§3.3); a duplicate id. A string entry becomes `{ id }`.
    Each stored tenant is a fresh `Object.freeze`d copy (`id`, plus `name`/`metadata` when present),
    so a handler cannot mutate the object other requests receive.
  - **Function** → a `RegistryFactory`, resolved in `ctx.lifecycle.onInit` through
    `resolveRegistryEntry(entry, ctx.services, 'MultiTenancyPlugin.tenants')` — the `dataStore` arm.
  - **Object** → an `ITenantRegistry` instance.
  - The instance and the factory's result are shape-checked (`typeof lookup === 'function'`) where
    they enter — `register()` for an instance, `onInit` for a factory result — and refused with an
    `Error` naming the option.
  - **Omitted** → no registry; the middleware behaves exactly as today.
- **Why:** one option, the way `dataStore` already takes instance-or-factory; a list is the common
  case (the CMS demo's two tenants) and must not need a class.
- **Test home:** `test/unit/tenant-registry-options.test.ts`,
  `test/unit/static-tenant-registry.test.ts`.

### 3.3 One check, shared by the middleware and `lookupTenant`

- **Decision:** an internal `TenantCheck` (`src/registry/tenant-check.ts`, not exported from
  `src/index.ts`) owns the whole decision. `check(id)` returns `some(tenant)`, `none()`, or throws
  `TenantRegistryUnavailableError`:
  1. no registry configured → `some({ id })` (today's behaviour, unchanged);
  2. `id.length > MAX_TENANT_ID_LENGTH` (256, UTF-16 code units, an internal constant) → `none()`
     without calling the registry;
  3. registry not bound yet (factory arm before `onInit`) → throws `TenantRegistryUnavailableError`;
  4. `registry.lookup(id)` throws → throws `TenantRegistryUnavailableError` with the original as
     `cause`;
  5. the lookup returns anything other than `none()` or a `some` whose `value.id` is a non-empty
     string → throws `TenantRegistryUnavailableError` (a malformed answer is a registry fault, never
     an admitted tenant);
  6. otherwise the lookup's result. The middleware and `IMultiTenancyService.lookupTenant` both call
     this one function.
- **Why:** CLAUDE.md "one capability, one implementation": a queue handler validating a payload's
  tenant must get the answer the HTTP path would give. The length cap keeps a header-sized string
  out of a database query and out of the cache key — no resolver bounds it today (§1).
- **Test home:** `test/unit/tenant-check.test.ts` (each numbered branch), and the both-entry-points
  test in `test/integration/tenant-registry-kernel.test.ts` (§3.9).

### 3.4 The registry's tenant replaces the resolved one

- **Decision:** on `some(tenant)` the middleware calls `replaceTenant(ctx.request, tenant)` with the
  REGISTRY's tenant, and every later step (session tenant-binding compare, cache-prefix stamp) uses
  `tenant.id`. The registry's id is canonical: a database registry on a case-insensitive collation
  answers `acme` for `ACME`, and the request then carries `acme`.
- **Why:** `name` and `metadata` reach `ctx.request.tenant`; and two spellings of one tenant can no
  longer partition its rows or its session binding.
- **Test home:** `test/unit/tenant-middleware.test.ts` (a registry answering a different-case id:
  the handler sees the registry's id, the cache prefix uses it, a session bound to it passes).

### 3.5 The middleware step and its responses

- **Decision:** the registry step runs after the resolver chain picks a tenant and before
  `replaceTenant` — so before the session tenant-binding check. The resolver chain is NOT re-entered
  on a miss: the first present resolver's id is checked, and a miss refuses (a fallback would let
  the caller pick which resolver's id is used).

  | Check result   | Response                                                                                                                                                         |
  | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `some(tenant)` | `replaceTenant(ctx.request, tenant)`, then the existing steps with `tenant.id`                                                                                   |
  | `none()`       | `respondWithError(ctx, { status: unknownTenantStatus, title: 'Unknown Tenant', detail: 'The request names a tenant that does not exist' })`; `next()` not called |
  | throws         | `respondWithError(ctx, { status: 503, title: 'Tenant Registry Unavailable', detail: 'The tenant could not be checked; try again later' })`; `next()` not called  |

  Neither `detail` contains the requested id. No tenant resolved: unchanged (`required` decides).
  Excluded paths: unchanged (skip everything, including the registry).

- **Logging:** the shared check (§3.3) logs, so a fault seen by either entry point counts: on a
  registry fault it logs `warn`
  `'Tenant registry lookup failed; requests naming a tenant answer 503'` with
  `{ error: describeError(cause) }`, once per transition from healthy to failing, and `info`
  `'Tenant registry lookups recovered'` on the first success after a failure (the M119g pattern).
  The requested id is never logged.
- **`unknownTenantStatus`:** an integer in 400–499, checked at `register()` (anything else refused
  by name); default 404. 404 because the request is well formed and names a resource that does not
  exist (survey in §3.10); an app wanting 400 or 403 sets it.
- **Test home:** `test/unit/tenant-middleware.test.ts` (each row, field-by-field bodies, the
  short-circuit assertion that the handler and downstream middleware did not run, the no-echo
  assertion with a distinctive id, the warn-once/info-on-recovery log sequence).

### 3.6 Registry bodies through the configured error format

- **Decision:** the two new refusals go through `respondWithError`, so with `errorHandler`
  registered they are RFC 9457 Problem Details (`type`, `title`, `status`, `detail`, no `message`),
  and without it the fallback `{ error, detail }`.
- **Test home:** `test/integration/tenant-registry-kernel.test.ts` — one app with `errorHandler`
  (Problem Details asserted field by field, `message` absent) and one without (fallback shape).

### 3.7 The bounded cache for registries that do I/O

- **Decision:** an internal `CachingTenantRegistry` (`src/registry/caching-tenant-registry.ts`)
  wraps an instance or factory-built registry; a static array registry is never wrapped. Option
  `tenantCache?: false | { ttlMs?: number; maxEntries?: number; maxBytes?: number }`, defaults
  `ttlMs: 30_000`, `maxEntries: 1_000`, `maxBytes: 1_048_576`.
  - Only `some` results are cached, keyed by the REQUESTED id. Misses and throws are not cached, so
    a tenant created in the database is admitted on its next request.
  - Expiry is monotonic: `runtime.hrtime()` at insert plus `ttlMs`; an expired entry is a miss that
    looks up again.
  - Size of an entry = UTF-8 length of the key + UTF-8 length of `JSON.stringify` of the tenant. A
    tenant whose `JSON.stringify` throws (a cycle, a `BigInt`) is returned uncached.
  - Insertion evicts oldest-first (`Map` order) until both `entries ≤ maxEntries` and
    `bytes ≤ maxBytes`; an entry larger than `maxBytes` on its own is returned uncached.
  - Concurrent lookups of one uncached id share one in-flight promise (single-flight); the in-flight
    entry is deleted when it settles, so that map is bounded by concurrency, not by distinct ids.
  - `false` disables the wrapper. `tenantCache` with an array `tenants` or with no `tenants` is
    refused at `register()` (it would configure nothing). Each numeric field must be a finite
    integer ≥ 1 (`ttlMs` ≥ 0, where 0 also disables caching): `NaN`, `Infinity` and negatives are
    refused by name.
- **Why:** the key and the value both come from outside the process — the key from the request, the
  value from the registry's store — so both bounds are needed (C1). A suspended tenant stays
  admitted until its entry expires; the default 30 s is the documented window, and `ttlMs: 0` or
  `false` removes it.
- **Test home:** `test/unit/caching-tenant-registry.test.ts` (TTL with an injected clock reading the
  same monotonic source, entry and byte eviction, oversize entry uncached, unserializable tenant
  uncached, misses and throws not cached, single-flight: N concurrent calls → 1 lookup, in-flight
  map empty after settle, option refusals including `NaN`/`Infinity`/`-1`).

### 3.8 `createDatabaseTenantRegistry`

- **Decision:** `packages/database-plugin/src/tenancy/database-tenant-registry.ts`:

  ```ts
  createDatabaseTenantRegistry(options?: {
    entity?: string;        // default 'Tenant'
    idField?: string;       // default 'id'
    nameField?: string;     // default 'name'
    activeField?: string;   // optional
    toMetadata?: (row: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  }): RegistryFactory<ITenantRegistry>
  ```

  The factory resolves `CAPABILITIES.DATABASE` as `IDatabaseService` (like
  `createDatabaseTenantDataStore`) and fetches the repository once. `lookup(id)` runs
  `findOne({ where: { [idField]: id } })`:
  - `null` → `none()`;
  - `activeField` set and the row's value falsy → `none()` (a suspended tenant, data kept);
  - the row's `idField` value not a non-empty string → throws `TypeError` naming the entity and
    field (the check turns it into a 503, §3.3);
  - else
    `some({ id: row[idField], name?: row[nameField] when a string, metadata?: toMetadata(row) when given })`.
    The row itself never reaches the tenant: without `toMetadata` there is no `metadata`, so a
    column such as an API key on the tenant table does not land on `ctx.request.tenant` or in a log.
    Options are validated when the factory is created (non-empty strings, `toMetadata` a function).

- **Why:** the common case — tenants are rows — with no import of the tenancy plugin. `findOne` with
  `where` addresses the field by name, so a slug column works as well as the primary key.
- **Test home:** `database-plugin/test/unit/database-tenant-registry.test.ts` (memory adapter: hit,
  miss, inactive, malformed id, `nameField`, `toMetadata`, row columns absent from the tenant,
  option refusals); `database-plugin/test/integration/database-tenant-registry-drizzle.test.ts`
  (Drizzle on `node:sqlite` through `sqlite-proxy`, the same table of cases).

### 3.9 `IMultiTenancyService.lookupTenant`

- **Decision:** a required member `lookupTenant(id: string): Promise<Option<ITenant>>` on the
  committed interface, implemented by `MultiTenancyService` as a call to the shared check (§3.3).
  With no `tenants` configured it answers `some({ id })` — what the HTTP path admits — and its JSDoc
  says so in its first sentence, so a handler author does not mistake it for validation when no
  registry exists. Throws `TenantRegistryUnavailableError` on a registry fault, so a queue job
  retries rather than proceeding.
- **Why:** queue, scheduler and messaging handlers have no request (`ingress.ts:30-56`) and read the
  tenant from a payload; this is their way to refuse a tenant that does not exist before calling the
  trusted `getRepositoryFor`.
- **Breaking:** a required member on a published interface breaks other implementers — only test
  doubles exist (§1), updated in this PR. Ships in `0.12.0`.
- **Test home:** `test/unit/multi-tenancy-service.test.ts`; the both-entry-points test in
  `test/integration/tenant-registry-kernel.test.ts` drives the middleware and `lookupTenant` under a
  non-default configuration (a factory registry with a cache, `unknownTenantStatus: 403`) and
  asserts the same admit/refuse answer for a hit, a miss, an over-long id and a throwing registry.

### 3.10 Survey — unknown-tenant behaviour elsewhere

- **Decision:** default 404, registry faults 503, misses not cached (§3.5, §3.7).
- **Why:** read from each library's source on 2026-11-03.

  | Library                                                                       | Unknown tenant                                                                                                                           | Store failure                             | Caching                                                                                     |
  | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
  | Finbuckle.MultiTenant 10 (`TenantManager.cs`, `MultiTenantMiddleware.cs`)     | store required; by default the request CONTINUES with no tenant; `ShortCircuitWhenTenantNotResolved()` stops it (optionally redirecting) | caught, logged, treated as not found      | optional memory/distributed cache, hits only; invalidated on writes through `TenantManager` |
  | django-tenants (`middleware/main.py`)                                         | `Http404` (`TENANT_NOT_FOUND_EXCEPTION`), or a configured view, or the public schema                                                     | not caught → 500                          | none                                                                                        |
  | stancl/tenancy 3 (`IdentificationMiddleware.php`, `CachedTenantResolver.php`) | `TenantCouldNotBeIdentified…Exception` → 500 unless `$onFail` is set                                                                     | not the caught type → 500                 | opt-in, TTL 3600 s, hits only; invalidated on model save                                    |
  | ABP (`MultiTenancyMiddleware.cs`, `TenantConfigurationProvider.cs`)           | `BusinessException` "tenant not found" (inactive tenant: its own code); AJAX → 404 JSON                                                  | caught by the same handler → 404 for AJAX | distributed cache, invalidated on tenant change events; misses re-queried                   |

  404 follows django-tenants (and ABP's API answer); none of the four caches misses. Finbuckle and
  ABP turn a store outage into "no tenant", which is the fall-open this plan refuses: 503 is the one
  answer that says "retry" without admitting or denying the tenant. Finbuckle's continue-with-no-
  tenant default is today's Setu behaviour with `required: false`, kept when `tenants` is omitted.

- **Test home:** none (a design input).

### 3.11 Health and wiring

- **Decision:** the health indicator's `data` gains
  `registry: 'none' | 'static' | 'factory' | 'custom'` (`'factory'` until `onInit` binds it, as
  `store` does). No readiness change: a static registry cannot fail, and a database registry's
  backend already has its own readiness indicator. `onClose` needs nothing — the registry owns no
  connection.
- **Test home:** `test/integration/multi-tenancy-kernel.test.ts` (each value).

### 3.12 `apps/multi-tenant`

- **Decision:**
  `MultiTenancyPlugin({ resolver: 'header', header: { name: TENANT_HEADER }, required: true, tenants: ['acme', 'globex'] })`;
  the smoke switches to `acme`/`globex` and adds a case asserting `x-tenant-id: initech` answers 404
  with body `{ error: 'Unknown Tenant', detail: … }` and creates nothing. README updated.
- **Test home:** `apps/multi-tenant/smoke.ts` under `pnpm run check:apps`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `IMultiTenancyService` gains the required `lookupTenant` member
(§3.9) — ships in minor `0.12.0`.

| Exported symbol                                                                                                    | Kind             | Consumer / real code path that READS it                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ITenantRegistry` (`common`)                                                                                       | type             | `MultiTenancyPluginOptions.tenants`; implemented by `createDatabaseTenantRegistry`'s result and the internal static registry |
| `IMultiTenancyService.lookupTenant` (`common`)                                                                     | interface member | queue/scheduler/messaging handlers; `apps/multi-tenant` README example; the both-entry-points test                           |
| `TenantRegistryUnavailableError` (`multi-tenancy-plugin`)                                                          | class            | thrown by the shared check; caught by the middleware (→ 503) and by an ingress handler calling `lookupTenant`                |
| `createDatabaseTenantRegistry` (`database-plugin`)                                                                 | function         | an application's `tenants:` option; the CMS demo replaces its custom resolver with it                                        |
| `DatabaseTenantRegistryOptions` (`database-plugin`)                                                                | type             | the parameter of `createDatabaseTenantRegistry`                                                                              |
| `TenantRegistryCacheOptions` (`multi-tenancy-plugin`; `TenantCacheOptions` already names the cache-prefix options) | type             | `MultiTenancyPluginOptions.tenantCache`                                                                                      |

### 4.1 Options — every option names its consumer

| Option                                                                                           | Consumer                                             | Behavior (per implementation)                                                                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tenants`                                                                                        | plugin `register()` parse (§3.2) → the shared check  | array: static registry; function: factory resolved in `onInit`; object: instance; omitted: no registry                  |
| `unknownTenantStatus`                                                                            | middleware miss branch (§3.5)                        | status of `Unknown Tenant`; 400–499 else refused at `register()`; refused when `tenants` is omitted, like `tenantCache` |
| `tenantCache`                                                                                    | plugin `register()` → `CachingTenantRegistry` (§3.7) | bounds and TTL for instance/factory registries; refused with an array or without `tenants`                              |
| `tenantCache.ttlMs` / `.maxEntries` / `.maxBytes`                                                | `CachingTenantRegistry` expiry and eviction          | defaults 30 000 / 1 000 / 1 MiB                                                                                         |
| `createDatabaseTenantRegistry` `entity` / `idField` / `nameField` / `activeField` / `toMetadata` | the database registry's `lookup` (§3.8)              | repository, where-key, `name`, active filter, metadata mapper                                                           |

## 5. Implementation files

| File                                                                    | Purpose                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/tenancy.ts`                               | `ITenantRegistry`; `lookupTenant` on `IMultiTenancyService`                                                                                                                                                                                                                                                                                                                     |
| `packages/common/src/index.ts`                                          | export type `ITenantRegistry`                                                                                                                                                                                                                                                                                                                                                   |
| `packages/multi-tenancy-plugin/src/registry/static-tenant-registry.ts`  | array → frozen `Map` registry, refusals (§3.2)                                                                                                                                                                                                                                                                                                                                  |
| `packages/multi-tenancy-plugin/src/registry/caching-tenant-registry.ts` | bounded TTL cache + single-flight (§3.7)                                                                                                                                                                                                                                                                                                                                        |
| `packages/multi-tenancy-plugin/src/registry/tenant-check.ts`            | the shared check, `MAX_TENANT_ID_LENGTH`, late binding, fault-state logging hook (§3.3)                                                                                                                                                                                                                                                                                         |
| `packages/multi-tenancy-plugin/src/registry/registry-options.ts`        | parse/validate `tenants`, `unknownTenantStatus`, `tenantCache` (§3.2, §3.5, §3.7)                                                                                                                                                                                                                                                                                               |
| `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts`     | the registry step (§3.4, §3.5)                                                                                                                                                                                                                                                                                                                                                  |
| `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts`      | wire options, `onInit` factory arm, health `registry` field                                                                                                                                                                                                                                                                                                                     |
| `packages/multi-tenancy-plugin/src/services/multi-tenancy-service.ts`   | `lookupTenant`                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/multi-tenancy-plugin/src/errors.ts`                           | `TenantRegistryUnavailableError`                                                                                                                                                                                                                                                                                                                                                |
| `packages/multi-tenancy-plugin/src/interfaces/index.ts`                 | the three options, `TenantRegistryCacheOptions`                                                                                                                                                                                                                                                                                                                                 |
| `packages/multi-tenancy-plugin/src/index.ts`                            | export the error and the options type; re-export `ITenantRegistry` type                                                                                                                                                                                                                                                                                                         |
| `packages/database-plugin/src/tenancy/database-tenant-registry.ts`      | `createDatabaseTenantRegistry` (§3.8)                                                                                                                                                                                                                                                                                                                                           |
| `packages/database-plugin/src/index.ts`                                 | export it and its options type                                                                                                                                                                                                                                                                                                                                                  |
| `apps/multi-tenant/setu.config.ts`, `smoke.ts`, `README.md`             | §3.12                                                                                                                                                                                                                                                                                                                                                                           |
| Docs                                                                    | PUBLIC_API.md (C3), `packages/multi-tenancy-plugin/README.md` + `AGENT_CARD.md`, `packages/database-plugin/README.md` + `AGENT_CARD.md`, `packages/common/README.md` (port list), `CHANGELOG.md` (Added + BREAKING for implementors), `docs/upgrading.md`, `docs/examples.md`, the CLI agent brief data if it lists tenancy options (`packages/cli/src/agents/package-data.ts`) |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                     | src covered                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `multi-tenancy-plugin/test/unit/static-tenant-registry.test.ts`               | `static-tenant-registry.ts`                        | hit returns frozen copy with `name`/`metadata`; miss; `'__proto__'`, `'constructor'`, `'hasOwnProperty'` ids are misses unless listed; each refusal (empty list, empty/whitespace/over-long/non-string/duplicate id) names the option — `lookup(id: string): Promise<Option<ITenant>>`     |
| `…/test/unit/caching-tenant-registry.test.ts`                                 | `caching-tenant-registry.ts`                       | §3.7 list                                                                                                                                                                                                                                                                                  |
| `…/test/unit/tenant-check.test.ts`                                            | `tenant-check.ts`                                  | §3.3 branches 1–6; over-long id never reaches `lookup` (recorded calls); malformed answers (`some({ id: '' })`, `some({})`, `some(null)`, a non-Option) → `TenantRegistryUnavailableError` with `cause`                                                                                    |
| `…/test/unit/tenant-registry-options.test.ts`                                 | `registry-options.ts`                              | three `tenants` shapes; instance without `lookup` refused at `register()`; `unknownTenantStatus` 399/500/`NaN`/`404.5` refused, 403 accepted; `unknownTenantStatus` or `tenantCache` without `tenants` refused; `tenantCache` with an array refused                                        |
| `…/test/unit/tenant-middleware.test.ts` (extended)                            | `tenant-middleware.ts`                             | §3.4, §3.5: hit/miss/throw rows, handler and downstream not run on refusal, no id in body or log, canonical id flows to session compare and cache prefix, no registry = unchanged, excluded path makes no lookup, `required` + nothing resolved unchanged, warn-once then info-on-recovery |
| `…/test/unit/multi-tenancy-service.test.ts` (extended)                        | `multi-tenancy-service.ts`                         | `lookupTenant` delegates to the check; no registry → `some({ id })`                                                                                                                                                                                                                        |
| `…/test/unit/multi-tenancy-plugin.test.ts` (extended)                         | `multi-tenancy-plugin.ts`                          | factory resolved in `onInit` and shape-checked; factory throw fails `start()` naming `MultiTenancyPlugin.tenants`; health `registry` values                                                                                                                                                |
| `…/test/unit/errors.test.ts` (extended)                                       | `errors.ts`                                        | name, message, `cause`                                                                                                                                                                                                                                                                     |
| `…/test/unit/barrel-exports.test.ts` (extended)                               | `index.ts`                                         | `TenantRegistryUnavailableError` is a function at runtime                                                                                                                                                                                                                                  |
| `…/test/integration/tenant-registry-kernel.test.ts` (new)                     | middleware + plugin + service through a kernel app | §3.6 both formats; §3.9 both entry points under a non-default configuration; a write under an unknown tenant creates no row (read back through `getRepositoryFor`); WebSocket-free                                                                                                         |
| `…/test/integration/multi-tenancy-kernel.test.ts` (extended)                  | plugin wiring                                      | health `registry` field                                                                                                                                                                                                                                                                    |
| `common/test/unit/barrel-exports.test.ts` (extended)                          | `tenancy.ts` (types)                               | `ITenantRegistry` structural instance compiles; the `IMultiTenancyService` double gains `lookupTenant`                                                                                                                                                                                     |
| `messaging-plugin/test/integration/tenant-behaviour.test.ts` (double updated) | —                                                  | compiles with the new member                                                                                                                                                                                                                                                               |
| `database-plugin/test/unit/database-tenant-registry.test.ts`                  | `database-tenant-registry.ts`                      | §3.8 on the memory adapter                                                                                                                                                                                                                                                                 |
| `database-plugin/test/integration/database-tenant-registry-drizzle.test.ts`   | `database-tenant-registry.ts`                      | §3.8 on Drizzle over `node:sqlite`; a factory-built registry inside `MultiTenancyPlugin` with `DatabasePlugin` registered AFTER it (the `onInit` ordering)                                                                                                                                 |
| `database-plugin/test/unit/barrel-exports.test.ts` (extended)                 | `index.ts`                                         | `createDatabaseTenantRegistry` is a function                                                                                                                                                                                                                                               |
| `apps/multi-tenant/smoke.ts`                                                  | the example                                        | §3.12                                                                                                                                                                                                                                                                                      |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m127-tenant-registry
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local           # sharded: static, packages, messaging, cli, tooling
pnpm run test:deno-lane
pnpm run check:apps
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

Per-file coverage read ANSI-stripped for every changed `src` file in `common`,
`multi-tenancy-plugin` and `database-plugin`.

## 8a. Design security review

- **Reviewed flows:** F1 an HTTP request whose resolved id is checked (hit, miss, fault); F2 a
  request on an excluded path; F3 a request with no tenant under `required`; F4 a non-HTTP handler
  calling `lookupTenant`; F5 the cache filling and evicting under request-chosen ids; F6 a database
  registry reading a tenant row.
- **Boundaries:** B1 request → resolver → registry (request-supplied id); B2 registry → request (the
  tenant object installed on `ctx.request.tenant`); B3 registry → logs and response bodies; B4
  payload → `lookupTenant` → `getRepositoryFor`.
- **Assets:** tenant data partitions; the set of tenants that can write rows; process memory;
  database capacity; tenant-table columns not meant for requests.
- **Attackers:** X1 an anonymous client choosing any header, host, path or unverified JWT claim; X2
  a client flooding distinct ids; X3 a client using a suspended tenant's name; X4 a message producer
  naming a tenant in a payload.
- **Threats and resolutions:**

  | #   | Threat                                                                                      | Resolution                                                                                                                                                                                       |
  | --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | T1  | an unlisted tenant is admitted                                                              | miss → `unknownTenantStatus`, `next()` not called (§3.5)                                                                                                                                         |
  | T2  | registry fault falls open                                                                   | fault → 503, never admitted (§3.3 steps 3–5, §3.5)                                                                                                                                               |
  | T3  | a malformed registry answer is admitted (`some({ id: '' })`, a non-Option)                  | treated as a fault (§3.3 step 5)                                                                                                                                                                 |
  | T4  | the requested id is reflected (XSS in a body, log injection)                                | neither `detail` nor any log carries it (§3.5)                                                                                                                                                   |
  | T5  | distinct-id flood: memory growth                                                            | misses not cached; cache bounded by entries AND bytes; in-flight map bounded by concurrency (§3.7)                                                                                               |
  | T6  | distinct-id flood: one database query per request                                           | accepted risk — misses are not cached by decision (ROADMAP 5); the id cap bounds each query; rate limiting (`http-security-plugin` / auth rate limit) is the documented mitigation in the README |
  | T7  | a header-sized id reaches the database and the cache                                        | `MAX_TENANT_ID_LENGTH` (§3.3 step 2)                                                                                                                                                             |
  | T8  | the resolver chain falls through to a second resolver after a miss, letting the caller pick | no fallthrough (§3.5)                                                                                                                                                                            |
  | T9  | two spellings of one tenant split its rows or session binding                               | the registry's id is canonical (§3.4)                                                                                                                                                            |
  | T10 | a suspended tenant keeps access                                                             | admitted until its cache entry expires (≤ `ttlMs`, default 30 s) — accepted and documented; `ttlMs: 0` / `false` removes the window                                                              |
  | T11 | secret tenant columns reach `ctx.request.tenant` and logs                                   | only `id`, `name` and an explicit `toMetadata` result (§3.8)                                                                                                                                     |
  | T12 | prototype-named ids (`__proto__`, `constructor`) hit in the static registry                 | `Map`, not an object (probe in the test table)                                                                                                                                                   |
  | T13 | a handler mutates the shared tenant object                                                  | frozen copies (§3.2)                                                                                                                                                                             |
  | T14 | tenant existence disclosure (404 vs 200)                                                    | accepted: the set is the product's public hostnames in the subdomain case; an app can choose 403 for both unknown and unauthorized via `unknownTenantStatus`                                     |
  | T15 | `lookupTenant` read as validation where no registry exists                                  | JSDoc first sentence + README (§3.9); same answer as the HTTP path by design                                                                                                                     |
  | T16 | session tenant-binding bypassed by the replacement                                          | binding compare runs after replacement against the canonical id (§3.4)                                                                                                                           |

- **Obligations the audit probes (each with a positive control):** O1 a miss runs no handler and no
  downstream middleware (control: a hit runs both); O2 a throwing, hanging-then-rejecting, and
  malformed-answer registry each answer 503 (control: a healthy registry admits); O3 a 10 000-char
  id never reaches `lookup` (control: a 256-char listed id is admitted); O4 the distinctive id
  `"<x>\r\nX-Evil: 1"` appears in no response byte and no log line (control: it reaches the
  registry's `lookup` argument); O5 100 000 distinct unknown ids leave the cache empty and the
  in-flight map empty; 10 000 distinct HITS (a registry admitting every id) keep the cache within
  `maxEntries` and `maxBytes` (control: a small set stays cached); O6 a different-case registry
  answer is what the handler, the cache prefix and the session compare see; O7 a database registry's
  tenant has no keys beyond `id`/`name`/`metadata` with a secret column present on the row; O8
  `lookupTenant` and the middleware agree on hit, miss, over-long and fault (control: the
  no-registry configuration admits on both); O9 an excluded path makes no lookup; O10 a factory
  registry with `DatabasePlugin` registered after `MultiTenancyPlugin` answers correctly.
- **Committed-tree audit:** yes — the change sits on the tenant boundary. Run by a fresh agent per
  `.roo/skills/security-audit/SKILL.md` on the PR's head commit (never Codex); the record goes in
  the PR.

## 8. Risks & mitigations

- A registry implemented by an application throws for "not found" instead of returning `none()` →
  every unknown tenant answers 503. Mitigation: the port's JSDoc and the README state that a throw
  means "could not check"; the warn log names the fault.
- A custom registry whose `lookup` never settles holds the request open: the plugin applies no
  timeout of its own. The database registry inherits the database plugin's command bounds (M101a);
  the port's JSDoc tells implementers to bound their own I/O.
- The cache serves a renamed tenant's old `name` for up to `ttlMs` → documented with T10.
- `unknownTenantStatus` set to 401 → a browser may prompt for credentials on a non-Bearer 401 with
  no challenge; documented next to the option (400, 403, 404 recommended).
- Adding a required interface member breaks an out-of-tree implementer → BREAKING entry in CHANGELOG
  and `docs/upgrading.md` (one line: implement `lookupTenant` or delegate to `MultiTenancyService`).

## 9. Out of scope

- `setu add multi-tenancy` writing a `tenants` list (CLI work, M131c or later).
- An event-driven cache invalidation (`forgetTenant`) — TTL only in this milestone.
- Negative caching of misses (ROADMAP M127 decision 5).
- Resolving the tenant for WebSocket messages after the upgrade, or per gRPC message — the upgrade
  request and the gRPC call are checked once by the middleware, as today.
- The CMS demo's switch to `createDatabaseTenantRegistry` — the demo is re-scaffolded on `0.12.0`
  after the release (memory `cms-demo-plan`).
