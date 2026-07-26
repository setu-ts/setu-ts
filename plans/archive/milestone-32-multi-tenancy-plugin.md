# Milestone 32 — Multi-Tenancy Plugin (`@hono-enterprise/multi-tenancy-plugin`)

> **Status:** Planning. Branch: `feat/32-multi-tenancy-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide multi-tenancy support as a first-party plugin: resolve the tenant for each incoming request
(subdomain / header / path / JWT claim), attach it to the request context so handlers and other
middleware can read it, expose a tenant-scoped repository surface so data access is isolated per
tenant, and provide cache-key isolation plus pluggable database-isolation strategies. The plugin
registers `IMultiTenancyService` under the already-committed `CAPABILITIES.MULTI_TENANCY`
(`'multi-tenancy'`) token.

The boundary: this plugin owns **tenant resolution, tenant context, the tenant-scoped repository
wrapper, and isolation-strategy metadata**. It does **not** own the actual ORM/data-access layer —
there is no committed data-access port it can build on (`IOrmAdapter` is lifecycle-only and
`IRepository` is owned by the database-plugin, see §1), so tenant-scoped CRUD is delegated to an
**internal data-store port** with a shipped zero-dependency memory default (precedent: every
plugin's memory backend). Real databases are supported by the application injecting an
`ITenantDataStore` that consumes the strategy metadata.

- **In scope:** `MultiTenancyPlugin` factory; four `ITenantResolver` implementations
  (Subdomain/Header/Path/Jwt); three isolation-strategy classes (Column/Schema/Database-per-tenant);
  `MultiTenancyService` + `TenantRepository`; a `MemoryTenantDataStore` default; `tenantMiddleware`;
  the `multi-tenancy` health indicator; the small flagged `common` widening that the committed
  ROADMAP/ARCHITECTURE docs already presuppose (`IMultiTenancyService`, `ITenantRepository`, and the
  `tenant?` field on `IRequest`).
- **NOT this milestone:** the actual ORM connection/schema switching for real databases — that lives
  in an application-provided `ITenantDataStore` implementation (this plugin only defines the port
  and the metadata); a full tenant onboarding/admin CRUD API; tenant-aware migrations; per-tenant
  configuration overrides (ConfigPlugin integration); a LaunchDarkly-style hosted tenant catalog.
  Tenant lifecycle management is deferred to a future milestone. The illustrative `@CurrentTenant()`
  parameter-decorator snippet in PUBLIC_API.md (line 4313) is also out of scope — the decorator
  plugin's `current-tenant` resolver is not shipped here (it would require a separate parameter
  resolver registration and is not in the ROADMAP deliverables).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                                           | Source (file:line)                                                                                                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITenant`                                                                           | `packages/common/src/services/tenancy.ts:14`                                                                                                                                                             | `readonly id: string`, `readonly name?: string`, `readonly metadata?: Readonly<Record<string, unknown>>`.                                                                                                                                                                                                                                                  |
| `ITenantResolver`                                                                   | `packages/common/src/services/tenancy.ts:38`                                                                                                                                                             | Single method `resolve(request: IRequest): Promise<Option<ITenant>>`. **Only receives `IRequest` — no `ctx`, no `services`.** Resolvers that need a dependency (JWT) must capture it at construction.                                                                                                                                                      |
| `CAPABILITIES.MULTI_TENANCY`                                                        | `packages/common/src/tokens.ts:95`                                                                                                                                                                       | Value `'multi-tenancy'`. Lowercase kebab-case, no colons — passes `createCapabilityToken` (`packages/common/src/tokens.ts:147`). **No new token needed.**                                                                                                                                                                                                  |
| `IRequest` (no `tenant`)                                                            | `packages/common/src/http.ts:32`                                                                                                                                                                         | Fields: `method`, `url`, `path`, `headers`, `ip?`, `user?` (writable, `:47`), `signal?` (also declared non-`readonly`, but adapter-populated), body readers. **There is NO `tenant` field.** Adding one is a `common` widening (decision 3.2).                                                                                                             |
| `IRequestContext`                                                                   | `packages/common/src/http.ts:193`                                                                                                                                                                        | `request`, `response`, `services`, `params`, `query`, `state: Map<string, unknown>`, `startTime`, `signal`. `.state` is the request-scoped bag.                                                                                                                                                                                                            |
| `IOrmAdapter`                                                                       | `packages/common/src/services/database.ts:33`                                                                                                                                                            | **Lifecycle-only**: `connect`/`disconnect`/`isReady`/`beginTransaction`. Module docstring (line 5-6): "The repository and unit-of-work interfaces are owned by the database plugin itself; `common` defines only the adapter port." Confirms the M10 lesson — no data access here.                                                                         |
| `IRepository` / `IDatabaseService`                                                  | `packages/database-plugin/src/interfaces/index.ts:21` (`IRepository`), `:125` (`IDatabaseService.getRepository`)                                                                                         | Owned by **database-plugin**, NOT in `common` (`common/src/index.ts:134` exports only `IOrmAdapter, ITransaction`). So the multi-tenancy plugin **cannot** return the database-plugin's `IRepository` without importing that plugin (forbidden, AI_GUIDELINES §2.2/§3.3) — `getRepository` returns a NEW `ITenantRepository` (decision 3.4).               |
| `IJwtService`                                                                       | `packages/common/src/services/auth.ts:52`                                                                                                                                                                | `sign`, `verify<T>(token): Promise<T>`, **`decode<T>(token): T \| null`** (unverified decode, line 78). `JwtResolver` uses `decode` (decision 3.6).                                                                                                                                                                                                        |
| `IPlugin` / `IPluginContext`                                                        | `packages/common/src/plugin.ts:470` / `:409`                                                                                                                                                             | `name`, `version`, `dependencies?`, `optionalDependencies?`, `provides?`, `consumes?`, `priority?`, `register(ctx)`. `ctx` exposes `services`, `middleware.add(fn, {priority, name})` (`:49`), `health.register(name, fn)` (`:187`), `lifecycle.onClose` (`:328`), `runtime`, `logger?`, `options`.                                                        |
| `optionalDependencies` creates ordering edges                                       | `packages/kernel/src/registry/plugin-resolver.ts:49`                                                                                                                                                     | When a registered plugin provides an optional token, the resolver adds a topological edge — so `optionalDependencies: [CAPABILITIES.JWT]` guarantees the auth plugin registers first when present, and is silently tolerated when absent.                                                                                                                  |
| `HealthCheckResult` shape                                                           | `packages/common/src/services/health.ts:13`                                                                                                                                                              | `{ readonly status: HealthStatus; readonly data?: Readonly<Record<string, unknown>> }`; `HealthStatus = 'up' \| 'down' \| 'degraded'` (`types.ts:60`). Diagnostics go under **`data`**, not `detail`/`details` (decision 3.10).                                                                                                                            |
| `IRuntimeServices.uuid`                                                             | `packages/common/src/runtime.ts:203`                                                                                                                                                                     | `uuid(): string` — the only sanctioned id source outside `packages/runtime`; used to seed `MemoryTenantDataStore`'s id generator in `register()` (decision 3.3).                                                                                                                                                                                           |
| Duplicate plugin name throws                                                        | `packages/kernel/src/registry/plugin-resolver.ts:112`                                                                                                                                                    | Two plugins with the same `name` throw at startup ("Duplicate plugin name …").                                                                                                                                                                                                                                                                             |
| Duplicate capability provider throws                                                | `packages/kernel/src/registry/plugin-resolver.ts:131`                                                                                                                                                    | Two plugins `provides`-ing the same token throw at startup ("Capability … is provided by both …").                                                                                                                                                                                                                                                         |
| Duplicate service registration throws                                               | `packages/kernel/src/registry/service-registry.ts:114`                                                                                                                                                   | `register(token, svc)` without `override`/`multi` throws if the token is taken.                                                                                                                                                                                                                                                                            |
| `ctx.request.user = principal` precedent                                            | `packages/auth-plugin/src/middleware/auth-middleware.ts:28`                                                                                                                                              | Auth attaches the principal by **writing the writable `user?` field on `IRequest`**. Tenant attachment mirrors this (decision 3.2). PUBLIC_API.md:1107 documents `user` as "the one writable field on `IRequest`" — adding `tenant` makes it a second _documented_ writable field; flagged in §2.                                                          |
| Type-only circular import between `http.ts` and `services/*` is already precedented | `packages/common/src/http.ts:12` imports `IPrincipal` from `./services/auth.ts`; `packages/common/src/services/auth.ts:8` imports `IRequest` back from `../http.ts`                                      | So `http.ts` importing `ITenant` from `./services/tenancy.ts` (which imports `IRequest`) is the **existing** pattern, not a new cycle. `import type` only — no runtime edge.                                                                                                                                                                               |
| `ctx.state` key convention                                                          | `packages/storage-plugin/src/middleware/upload-middleware.ts:12` (`const UPLOADS_STATE_KEY = 'storage-plugin:uploads'`) and `:136` (exported `getUploadedFile(ctx: { state: Map<string, unknown> }, …)`) | Keys are `'<plugin>:<key>'` in a module const, read back through an **exported accessor** so consumers never hardcode the string. Adopted verbatim in decision 3.9.                                                                                                                                                                                        |
| Short-circuit response body convention                                              | `packages/http-security-plugin/src/middleware/csrf-middleware.ts:97` (`403 { error: 'Forbidden', message: … }`), `request-size-middleware.ts:62` (`413 { error: 'Payload Too Large', message: … }`)      | Two fields: a human-readable `error` label plus an explanatory `message`. Adopted in decision 3.8 (a snake_case machine code alone would diverge).                                                                                                                                                                                                         |
| ARCHITECTURE §10 middleware priority table                                          | `ARCHITECTURE.md:1557`                                                                                                                                                                                   | Rows: ErrorHandler 0, Metrics 20, Logging 50, RequestId 100, CorrelationId 150, Cors 200, SecurityHeaders 250, Auth 300, Authorization 350, Validation 400. **Priority 40 is free**; the table has no tenant row, so adding one is a named doc deliverable (conflict C5) — the M19 precedent for correcting this table.                                    |
| Type-only `interfaces/index.ts` emits no coverage                                   | `packages/feature-flags-plugin/src/interfaces/index.ts` (138 lines, zero exported `const`/`function`/`class`)                                                                                            | A pure-type module compiles to nothing, so it never appears in the per-file coverage table. This is why §6 maps no test file to `src/interfaces/index.ts`.                                                                                                                                                                                                 |
| `PLUGIN_PRIORITY` bands                                                             | `packages/common/src/types.ts:78`                                                                                                                                                                        | `HIGHEST 0`, `HIGH 100`, `NORMAL 500`, `OPENAPI 700`, `LOW 900`, `LOWEST 1000`. AuthPlugin registers at `NORMAL` (`packages/auth-plugin/src/plugin/auth-plugin.ts:56`); auto-added first-party middleware use literal priorities (metrics 20, telemetry 30). Tenant middleware uses priority `40` (decision 3.7).                                          |
| `Option<T>`                                                                         | `packages/common/src/option.ts:52`                                                                                                                                                                       | `Some<T> \| None`, discriminated by `.present`; helpers `some`/`none`/`isSome`/`isNone` exported from `common`.                                                                                                                                                                                                                                            |
| ARCHITECTURE multi-tenancy row                                                      | `ARCHITECTURE.md:1407`                                                                                                                                                                                   | Responsibilities: "Tenant resolution; tenant context; database isolation strategies; cache isolation". Public API: `MultiTenancyPlugin()`; `IMultiTenancyService`. Rules: **"Tenant resolution via middleware; tenant context via request context."** Confirms the middleware + `ctx.request.tenant` design and that `IMultiTenancyService` is public API. |
| PUBLIC_API common Multi-tenancy row                                                 | `PUBLIC_API.md:4683`                                                                                                                                                                                     | Currently documents only `ITenantResolver, ITenant` for `common`. **No `IMultiTenancyService`** — confirms the gap widened in §3.1.                                                                                                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                          | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                              |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M32 references `IMultiTenancyService` (`ROADMAP.md:3249`) and ARCHITECTURE lists it as public API (`ARCHITECTURE.md:1415`), but it is **not** in `common` — `common/src/services/tenancy.ts` exports only `ITenant`/`ITenantResolver`, and `common/src/index.ts:170` re-exports only those two.                     | **Widen `common`** — add `IMultiTenancyService` and `ITenantRepository<Entity, Id>` to `services/tenancy.ts` and the barrel (decision 3.1). This follows the M27/M44/M45 precedent (new service interface backing a standard capability token → committed to `common`); the alternative "token in common, interface in plugin" exception is reserved for large ORM-specific contracts like the database-plugin's. | Update `PUBLIC_API.md` Multi-tenancy common row (`:4683`) to `IMultiTenancyService, ITenantRepository, ITenantResolver, ITenant`; add a full Multi-Tenancy plugin Options/Exports/Notes section documenting every §4 export (including `ITenantIsolationStrategy`, `TenantIsolationKind`, and `getTenantCachePrefix`). |
| C2 | ROADMAP M32 programmatic example reads `const tenant = ctx.request.tenant;` (`ROADMAP.md:3252`), but `IRequest` has **no** `tenant` field (`packages/common/src/http.ts:32`); PUBLIC_API:1107 states `user` is the only writable `IRequest` field.                                                                          | **Add `tenant?: ITenant` to `IRequest`** (`common/src/http.ts`), set by `tenantMiddleware` and read by handlers (decision 3.2). Honors ROADMAP + ARCHITECTURE's "tenant context via request context" and mirrors the M16 `user?` precedent.                                                                                                                                                                       | Update `PUBLIC_API.md` `IRequest` widening note (alongside `user?` M16 / `signal?` M42); add an `IRequest.tenant` bullet.                                                                                                                                                                                              |
| C3 | ROADMAP M32 example `tenancy.getRepository<User>('User')` (`ROADMAP.md:3255`) passes **no request context**, but the framework has **no ambient request context** — no `AsyncLocalStorage`, and AI_GUIDELINES §11.4 forbids hidden globals. An app-scoped service cannot know the "current" tenant without it being passed. | **Committed signature is `getRepository<Entity, Id = string>(ctx: IRequestContext, entity: string): ITenantRepository<Entity, Id>`** — the service reads `ctx.request.tenant` (set by middleware) and throws `TenantNotResolvedError` if absent (decision 3.4). This is the only framework-consistent option; the ctx-less ROADMAP form is impossible without breaking §11.4.                                     | Correct the ROADMAP M32 example to `tenancy.getRepository<User>(ctx, 'User')`; mirror in PUBLIC_API plugin section.                                                                                                                                                                                                    |
| C4 | ROADMAP M32 lists **4 resolvers** (`SubdomainResolver`, `HeaderResolver`, `PathResolver`, `JwtResolver`, `ROADMAP.md:3259-3264`) but only **3 resolver files** (`subdomain/header/path`, `ROADMAP.md:3276-3278`) — `jwt-resolver.ts` is missing from the file list.                                                         | **Add `src/resolvers/jwt-resolver.ts`** (decision 3.6). Also add the files the design requires that ROADMAP omits: `src/interfaces/index.ts`, `src/repositories/tenant-repository.ts`, `src/stores/memory-tenant-store.ts`, `src/errors.ts` (precedent: every plugin adds files beyond ROADMAP's list and corrects it).                                                                                           | Correct the ROADMAP M32 implementation-files list to match §5.                                                                                                                                                                                                                                                         |
| C5 | ARCHITECTURE §10's middleware priority table (`ARCHITECTURE.md:1557`) has **no tenant row** — it jumps from Metrics 20 to Logging 50 — yet ARCHITECTURE:1417 mandates "tenant resolution via middleware", so this milestone auto-adds a middleware the committed table does not document.                                   | **Add the row** `40 \| TenantMiddleware \| Resolve request tenant` to the §10 table (decision 3.7). M19 set the precedent: it added `20 \| MetricsMiddleware` to this same table as part of its milestone PR rather than leaving the table stale.                                                                                                                                                                 | Add the priority-40 row to the ARCHITECTURE.md §10 table.                                                                                                                                                                                                                                                              |

## 3. Design decisions

### 3.1 Where `IMultiTenancyService` lives — widen `common`

- **Decision:** Add `IMultiTenancyService` and `ITenantRepository<Entity, Id = string>` to
  `packages/common/src/services/tenancy.ts` and export both from `common/src/index.ts`. The plugin
  implements them; resolvers, strategies, the data-store port, the service class, the repo class and
  middleware live in the plugin.
- **Why:** `ITenant`/`ITenantResolver` are already in `common`; ARCHITECTURE/PUBLIC_API list
  `IMultiTenancyService` as public API; and every other standard-token capability commits its
  service interface to `common` (`ILogger`, `IStorage`, `IMailer`, `IFeatureFlags`,
  `IResilienceService`, `ISsrService`, `IWorkerPool`…). Committing here keeps the tenancy contract
  in one place and resolves conflict C1. `getRepository` returns the **new** `ITenantRepository`
  (not the database-plugin's `IRepository`), so `common` gains **no cross-package type dependency**
  (the `common ← plugins` rule, AI_GUIDELINES §2.2, is preserved).
- **Test home:** `test/unit/multi-tenancy-service.test.ts` resolves the service via
  `ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY)` and asserts the returned repo
  satisfies `ITenantRepository`; `test/integration/multi-tenancy-integration.test.ts` exercises the
  full resolved surface.

Committed `common` shapes (added this milestone):

```typescript
// common/src/services/tenancy.ts  (additions)
export interface ITenantRepository<Entity, Id = string> {
  findAll(): Promise<readonly Entity[]>;
  findById(id: Id): Promise<Entity | null>;
  find(filter: Readonly<Record<string, unknown>>): Promise<readonly Entity[]>;
  create(data: Readonly<Record<string, unknown>>): Promise<Entity>;
  update(id: Id, data: Readonly<Record<string, unknown>>): Promise<Entity | null>;
  delete(id: Id): Promise<boolean>;
}

export interface IMultiTenancyService {
  getCurrentTenant(ctx: IRequestContext): ITenant | undefined;
  getRepository<Entity, Id = string>(
    ctx: IRequestContext,
    entity: string,
  ): ITenantRepository<Entity, Id>;
  prefixCacheKey(tenantId: string, key: string): string;
}
```

Inputs use `Readonly<Record<string, unknown>>` (the memory store persists them as-is; a real store
maps to its ORM). `Entity` is the read type. This is a thin tenant-scoped CRUD surface — it
deliberately does **not** reimplement query builders, relations, or transactions (those belong to
the injected data store / the application's ORM).

### 3.2 Tenant context attachment — writable `IRequest.tenant`

- **Decision:** Add `tenant?: ITenant` to `IRequest` (`common/src/http.ts`). `tenantMiddleware`
  resolves the tenant and, on success, sets `ctx.request.tenant = tenant` (mirroring
  `ctx.request.user = principal` at `auth-middleware.ts:28`). Handlers read `ctx.request.tenant`. On
  no resolution the field is left `undefined` (unless `required`, see 3.8). `ctx.state` is **not**
  used as the primary tenant carrier (would diverge from the documented ROADMAP/ARCHITECTURE API);
  it remains available for arbitrary per-request data.
- **Why:** ARCHITECTURE:1417 mandates "tenant context via request context"; ROADMAP:3252 shows
  `ctx.request.tenant`; the M16 `user?` field is the exact precedent for a writable per-request
  resolved identity. Resolves conflict C2.
- **Test home:** `test/unit/tenant-middleware.test.ts` asserts `ctx.request.tenant` is set after a
  successful resolution and `undefined` after `none()`;
  `test/integration/multi-tenancy-integration.test.ts` reads it from a handler.

### 3.3 The data-access seam — internal `ITenantDataStore` port + memory default

- **Decision:** Define an **internal** `ITenantDataStore` port in `src/interfaces/index.ts`
  (exported for injection, like M31's `IFlagStore`, but its sole consumer is the plugin's
  `TenantRepository`). It owns the real tenant-scoped CRUD and threads `tenantId` + `entity` into
  every call:

  ```typescript
  export interface ITenantDataStore {
    /**
     * Receives the resolved isolation strategy once, during `register()`.
     * Optional so a store may ignore isolation metadata entirely.
     */
    useIsolation?(strategy: ITenantIsolationStrategy): void;
    findAll<E>(tenantId: string, entity: string): Promise<readonly E[]>;
    findById<E, Id>(tenantId: string, entity: string, id: Id): Promise<E | null>;
    find<E>(
      tenantId: string,
      entity: string,
      filter: Readonly<Record<string, unknown>>,
    ): Promise<readonly E[]>;
    create<E>(
      tenantId: string,
      entity: string,
      data: Readonly<Record<string, unknown>>,
    ): Promise<E>;
    update<E, Id>(
      tenantId: string,
      entity: string,
      id: Id,
      data: Readonly<Record<string, unknown>>,
    ): Promise<E | null>;
    delete<Id>(tenantId: string, entity: string, id: Id): Promise<boolean>;
    close?(): Promise<void>;
  }
  ```

  `useIsolation` is the **strategy handoff**: `register()` builds the strategy from the `database`
  option and calls `store.useIsolation?.(strategy)` before registering the service. Without it the
  strategy the plugin builds would reach nothing (see 3.5) — an app-provided store would have to
  construct a second, disconnected copy.

  Ship `MemoryTenantDataStore` (zero-dependency default) so the plugin is fully functional and
  testable standalone — write→read-back works out of the box (precedent: `MemoryQueue`,
  `MemoryProvider`, `MemoryAuditStorage`, `MemoryRateLimitStore`). Real databases are supported by
  the application injecting its own `ITenantDataStore`. Its two specified behaviors:

  - **Partitioning is strategy-derived** — rows live in `Map<scope, Map<entity, Map<Id, unknown>>>`
    where `scope` comes from the strategy handed to `useIsolation` (3.5): `'column'` → `tenantId`,
    `'schema'` → `strategy.resolveSchema(tenantId)`, `'database'` →
    `strategy.resolveDatabase(tenantId)`; when `useIsolation` was never called (a bare
    `new MemoryTenantDataStore()`), `scope` is `tenantId`. Under the `'column'` strategy `create`
    additionally stamps the stored row with `[strategy.getTenantColumn()]: tenantId`, so a `find`
    filtering on that column behaves as a real column-isolated table would.
  - **Id assignment on `create`** — if `data` carries an `id` that is a `string` or `number`, it is
    used as the key; otherwise the store calls its `generateId` function. The constructor takes
    `MemoryTenantDataStoreOptions { generateId?: () => string }`, defaulting to an in-process
    monotonic counter (`'1'`, `'2'`, …) so a bare `new MemoryTenantDataStore()` needs no runtime.
    `register()` constructs the default store with `{ generateId: () => ctx.runtime.uuid() }`
    (`runtime.ts:203`) — no `crypto.randomUUID()` and no `Date.now()` anywhere in `src/`
    (AI_GUIDELINES runtime-API rule). The returned entity is the stored record including its `id`.
- **Why:** `IOrmAdapter` is lifecycle-only (`database.ts:33`) and `IRepository` is database-plugin
  owned and unscoped — there is **no** committed port the plugin can build tenant scoping on. This
  is the exact M10 defect class, and CLAUDE.md mandates: "if a committed port lacks a surface the
  design needs, the plan must define the internal port explicitly (its methods, its file, and that
  it is NOT exported from `src/index.ts`)". `ITenantDataStore` IS exported (it is the app injection
  seam, like `IFlagStore`); the internal, never-exported piece is the `TenantRepository` wrapper
  class itself (consumers hold it as `ITenantRepository` from `common`).
- **Test home:** `test/unit/memory-tenant-store.test.ts` (CRUD + cross-tenant isolation +
  `close()` + both id branches + one case per strategy arm through `useIsolation`);
  `test/unit/tenant-repository.test.ts` (the wrapper delegates to a fake store with the captured
  `tenantId` + `entity`); `test/unit/multi-tenancy-plugin.test.ts` asserts `register()` calls
  `useIsolation` on a recording fake store with the strategy the `database` option selected;
  integration test does a real write→read-back through the memory store.

### 3.4 `getRepository` — wraps the data-store port, scoped to `ctx.request.tenant`

- **Decision:** `MultiTenancyService.getRepository<Entity, Id>(ctx, entity)` reads
  `tenant = ctx.request.tenant`; if `undefined`, throws the exported `TenantNotResolvedError`.
  Otherwise returns `new TenantRepository<Entity, Id>(store, tenant.id, entity)` — a wrapper that
  captures the tenant id and entity name and delegates every `ITenantRepository` call to the
  injected `ITenantDataStore`, threading `tenant.id` + `entity`. Isolation is therefore automatic
  and total: a repo built for tenant A cannot see tenant B's rows.
- **Why:** Resolves conflict C3 (ctx must be threaded — no ambient context). Keeps the data-access
  boundary honest (§3.3) while honoring ROADMAP's "scoped to current tenant" intent.
- **Test home:** `test/unit/tenant-repository.test.ts` + `test/unit/multi-tenancy-service.test.ts`
  (throws `TenantNotResolvedError` without a tenant); integration test asserts cross-tenant
  isolation (create as A, `findAll` as B → `[]`).

### 3.5 Database strategies — isolation-metadata providers

- **Decision:** `ITenantIsolationStrategy` and `TenantIsolationKind` are declared **once**, in
  `src/interfaces/index.ts` (NOT in `column-strategy.ts` — the strategy files hold only their
  classes), and both are **exported from the barrel** because `MultiTenancyPluginOptions.database`
  accepts a custom instance and ARCHITECTURE:1418 commits "custom database strategy" as an extension
  point — an app cannot implement an unexported interface. The union is a discriminated one:

  ```typescript
  export type TenantIsolationKind = 'column' | 'schema' | 'database';

  export type ITenantIsolationStrategy =
    | { readonly kind: 'column'; getTenantColumn(): string }
    | { readonly kind: 'schema'; resolveSchema(tenantId: string): string }
    | { readonly kind: 'database'; resolveDatabase(tenantId: string): string };
  ```

  Discriminating on `kind` means a consumer that narrows to `'schema'` gets `resolveSchema` and
  nothing else — no optional methods, no `undefined` checks. Three exported classes implement the
  arms:

  - `ColumnPerTenant` — `kind: 'column'`; `getTenantColumn(): string` (default `'tenant_id'`,
    configurable). The **default** strategy.
  - `SchemaPerTenant` — `kind: 'schema'`; `resolveSchema(tenantId): string` (default
    `` `tenant_${tenantId}` ``, configurable prefix).
  - `DatabasePerTenant` — `kind: 'database'`; `resolveDatabase(tenantId): string` (default
    `` `tenant_${tenantId}` ``, configurable prefix).

  The `database` option discriminant uses ROADMAP's kebab strings (`'column-per-tenant'` |
  `'schema-per-tenant'` | `'database-per-tenant'`) and maps to the class, or accepts a custom
  `ITenantIsolationStrategy` instance.

  **Every strategy method is read on an in-repo code path**, via `useIsolation` (3.3):
  `MemoryTenantDataStore` narrows on `kind` and calls `getTenantColumn()` (to stamp and filter the
  tenant column), `resolveSchema(tenantId)`, or `resolveDatabase(tenantId)` (to derive its partition
  scope). The `multi-tenancy` health indicator additionally reports `kind`. An app-provided store
  reads the same strategy — through the same `useIsolation` handoff, not a second copy it builds
  itself — to switch real connection/schema/column.
- **Why:** The plugin **cannot** itself switch ORM schemas/databases — `IOrmAdapter` exposes no data
  access and there is no committed connection-switching port. The honest, implementable design is
  metadata + a store that receives it: the strategy derives the isolation scope deterministically,
  the store applies it. Routing the memory store's partitioning through the strategy is what makes
  this real rather than decorative — without it, `getTenantColumn`/`resolveSchema`/`resolveDatabase`
  would be dead surface whose only "consumer" is hypothetical app code (the CLAUDE.md dead-surface
  rule). This matches the ARCHITECTURE "database isolation strategies" responsibility without
  overpromising connection management the committed contracts cannot support.
- **Test home:** `test/unit/column-strategy.test.ts`, `schema-strategy.test.ts`,
  `database-strategy.test.ts` assert `kind` + each method's default and customized output;
  `memory-tenant-store.test.ts` drives one round-trip per arm and asserts the derived partition
  actually differs (schema/database scopes do not collide with the bare tenant id), plus that a
  `'column'`-stamped row is findable by filtering on the configured column name.

### 3.6 Resolvers — pure except `JwtResolver`, which captures a decoder

- **Decision:** All four implement the committed
  `ITenantResolver.resolve(request): Promise<Option<ITenant>>` (`tenancy.ts:38`) and depend only on
  `IRequest`:

  - `SubdomainResolver` — parses the host of `request.url`; returns the first label below a
    configurable `baseDomain` as `some({ id })`, else `none()`.
  - `HeaderResolver` — reads a configurable header (default `'x-tenant-id'`); `some({ id })` or
    `none()`.
  - `PathResolver` — reads a path segment from `request.path` by **segment index** (default `0`),
    configurable. **Documented limitation:** it parses `request.path` directly — it cannot read the
    router's `:param` values, because those live on `IRequestContext.params` (`http.ts:203`), which
    the resolver interface does not receive. There is deliberately **no** `param` option: an option
    the resolver could never read would be dead surface, so the segment index is the only knob (the
    limitation is documented in JSDoc and §8 instead).
  - `JwtResolver` — reads the `Authorization: Bearer <token>` header (configurable `headerName`),
    **decodes it via an injected `decode` function** (`(token) => Record<string, unknown> | null`),
    reads a configurable claim (default `'tenant_id'`), and returns `some({ id })` or `none()`.

  `JwtResolver`'s decoder is wired in `register()`: the plugin resolves `IJwtService` from
  `CAPABILITIES.JWT` (`ctx.services.get`) and constructs the resolver with
  `{ decode: (t) => jwt.decode(t) ?? null }`. Apps without the auth plugin may inject a custom
  `jwt.decode` via options. If `resolver: 'jwt'` is configured and **neither** the JWT capability
  **nor** a `jwt.decode` option is available, `register()` throws fail-fast. Resolvers may be
  chained (an array); the first `Some` wins, later resolvers are not consulted.

  **A throwing resolver does not fail the request.** `tenantMiddleware` wraps each `resolve()` call
  in `try`/`catch`: a rejection is logged at `warn` through the optional logger (3.7) with the
  resolver's index, then treated exactly like `none()`, so the chain continues to the next resolver
  and an unresolved tenant is handled by the `required` rule (3.8). This mirrors
  `auth-middleware.ts:31`, which swallows an authentication error and lets the guards decide.

  **Security note (documented in JSDoc + §8):** `JwtResolver` uses **unverified** `decode`
  (`auth.ts:78`) — tenant identity is taken from an unsigned token claim. This is acceptable
  **only** because the auth middleware separately verifies the token and establishes the principal;
  an application using `JwtResolver` without the auth plugin must understand a client could spoof
  the tenant claim. The mitigation is documented; no signature verification is added here (it would
  duplicate auth's job and require key config in this plugin).
- **Why:** The committed resolver interface passes only `IRequest`, so any resolver needing a
  dependency must capture it at construction — the `optionalDependencies: [CAPABILITIES.JWT]` +
  `register()`-time wiring is the framework-idiomatic answer (precedent: notification's
  `optionalDependencies: ['mail']` + fail-fast in register). Resolves the dependency seam the
  interface otherwise forbids.
- **Test home:** one unit test per resolver; `jwt-resolver.test.ts` injects a fake `decode` and
  asserts the claim path, malformed-token `none()`, and missing-token `none()`; the
  throwing-resolver path is asserted in `tenant-middleware.test.ts` (case (f), §6).

### 3.7 Tenant middleware — auto-added, priority 40, short-circuits when required

- **Decision:** `MultiTenancyPlugin.register()` calls
  `ctx.middleware.add(tenantMiddleware(service, resolvers, opts), { priority: 40, name: 'tenant' })`
  — auto-wired like the metrics/telemetry/security middleware (the app does **not** need a separate
  `app.middleware.add(...)` line, matching ROADMAP's `app.register(MultiTenancyPlugin({...}))`).
  `tenantMiddleware()` is **also exported** so an app can add it manually with a different priority
  if it wants ordering control relative to auth. Priority `40` runs after observability (metrics 20
  / telemetry 30) and before the NORMAL handler band; `JwtResolver` decodes the token itself, so
  ordering relative to auth is not load-bearing for resolution. ARCHITECTURE §10's table gains the
  matching row (conflict C5).

  The middleware factory takes an optional `logger?: ILogger` in its options bag; `register()`
  passes `ctx.logger` when the logger capability is registered (hence
  `optionalDependencies: [CAPABILITIES.LOGGER]` — its **only** consumer is the resolver-throw `warn`
  in 3.6, which is what keeps that declared dependency honest rather than decorative). When absent,
  the catch is silent.
- **Why:** ROADMAP's registration form implies auto-wiring; auto-add is well-precedented; exporting
  the factory preserves the auth-plugin-style escape hatch. The short-circuit path is mandatory per
  the CLAUDE.md "Short-circuit tests are mandatory" rule.
- **Test home:** `test/unit/tenant-middleware.test.ts` asserts: (a) success sets
  `ctx.request.tenant` and calls `next()`; (b) `required: true` + `none()` short-circuits with
  `rejectionStatus` (default `400`) **without** calling `next()` and the handler never runs; (c)
  not-required + `none()` proceeds with `ctx.request.tenant === undefined`; (d) chain order (first
  `Some` wins); (e) when `cache.prefix === true`, the resolved prefix is stashed in `ctx.state` (see
  3.9); (f) a resolver that rejects is logged through a recording fake logger and treated as
  `none()` — the next resolver in the chain still runs, and with no logger configured the same input
  does not throw.

### 3.8 Required-tenant behavior

- **Decision:** Option `required?: boolean` (default `false`). When `true` and no resolver returns
  `Some`, the middleware short-circuits with status `rejectionStatus` (default `400`) and the JSON
  body `{ error: 'Tenant Required', message: 'No tenant could be resolved for this request' }`,
  **without** calling `next()`. The two-field `{ error, message }` shape follows the committed
  short-circuit convention (csrf 403, request-size 413 — see §1); `error` is a fixed human-readable
  label rather than an HTTP reason phrase precisely because `rejectionStatus` is configurable, so a
  hardcoded phrase like `'Bad Request'` would lie whenever the app overrides the status. When
  `required` is `false`, the request proceeds with `ctx.request.tenant === undefined`; any later
  `getRepository(ctx, …)` then throws `TenantNotResolvedError` (§3.4). Both paths are documented
  per-implementation.
- **Test home:** the (b) and (c) cases in `tenant-middleware.test.ts`.

### 3.9 Cache isolation — `cache.prefix` stamps `ctx.state` + service helper

- **Decision:** Option `cache?: { prefix?: boolean; separator?: string }` (default no prefixing).
  `MultiTenancyService.prefixCacheKey(tenantId, key)` returns `tenantId + separator + key`
  (separator default `':'`) and is the **single home for separator resolution**. When
  `prefix === true`, the middleware writes the resolved tenant's prefix into `ctx.state`, and it
  obtains that prefix by calling `service.prefixCacheKey(tenant.id, '')` — it does **not**
  re-concatenate `tenant.id + separator` itself. One configured separator, one implementation, two
  entry points (CLAUDE.md "one capability, one implementation" rule).

  The state key follows the committed convention (§1): a module const
  `TENANT_CACHE_PREFIX_STATE_KEY = 'multi-tenancy-plugin:cache-prefix'`, read back through an
  **exported** `getTenantCachePrefix(ctx: { state: Map<string, unknown> }): string | undefined`
  accessor — modelled on `UPLOADS_STATE_KEY` + `getUploadedFile()` — so consumers never hardcode the
  string. When `prefix` is absent / `false`, the middleware does not write the key and the accessor
  returns `undefined` (but `prefixCacheKey` remains available for direct use). The plugin does
  **not** auto-wrap `ICacheStore` — intercepting the `CACHE` capability is out of scope and fragile.
- **Why:** Gives the option a real, testable consumer (the middleware + the service helper) so it is
  not dead surface (CLAUDE.md dead-option rule), while keeping the cache plugin decoupled.
- **Test home:** `tenant-middleware.test.ts` (`getTenantCachePrefix(ctx)` returns the prefix when
  `prefix:true` and `undefined` otherwise) and `multi-tenancy-service.test.ts` (`prefixCacheKey`
  output, default + custom separator). Both entry points are driven under a **non-default**
  separator in one test, asserting the middleware-stamped prefix and `prefixCacheKey` agree.

### 3.10 Health indicator, `onClose`, capability/token binding

- **Decision:** Register a `multi-tenancy` health indicator returning the committed
  `HealthCheckResult` (`health.ts:13`) —
  `{ status: 'up', data: { resolver: <type>, strategy: <kind>,
  store: <'memory' | 'custom'> } }`.
  Diagnostics go under **`data`** (the contract has no `detail`/`details` field); the memory store
  is always up, so the status is unconditionally `'up'`. Register `onClose` that calls
  `store.close?.()` (the memory store exposes a no-op-ish `close()`; an injected store may release
  connections). The plugin `name: 'multi-tenancy-plugin'`, `provides: [CAPABILITIES.MULTI_TENANCY]`,
  `optionalDependencies: [CAPABILITIES.LOGGER, CAPABILITIES.JWT]`. The single instance claims the
  bare `'multi-tenancy'` token; registering the plugin twice throws at startup (duplicate plugin
  name, `plugin-resolver.ts:112`, and/or duplicate capability provider, `:131`) — there is **no**
  multi-instance story and none is needed.
- **Why:** Matches the per-plugin health + lifecycle precedent. Both optional dependencies have
  exactly one real consumer: JWT is read in `register()` to wire `JwtResolver`'s decoder (tolerated
  when absent, fail-fast only when `resolver: 'jwt'` and no `jwt.decode` — 3.6), and LOGGER is
  passed into `tenantMiddleware` for the resolver-throw `warn` (3.7). `optionalDependencies` also
  buys ordering: the resolver adds a topological edge when a provider is registered
  (`plugin-resolver.ts:49`), so the auth plugin registers first and
  `ctx.services.get(CAPABILITIES.JWT)` cannot miss.
- **Test home:** `multi-tenancy-plugin.test.ts` (health indicator registered and returns
  `{ status: 'up', data: {…} }`; `onClose` invoked and calls `store.close()`;
  provides/optionalDependencies correct).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                                                                                                                         | Kind                  | Consumer / real code path that READS it                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MultiTenancyPlugin`                                                                                                                                                                                    | factory fn            | `app.register(MultiTenancyPlugin({...}))` — the plugin entry point (ROADMAP:3239).                                                                                                                                                                                               |
| `tenantMiddleware`                                                                                                                                                                                      | factory fn            | `register()` auto-adds it (`ctx.middleware.add`, 3.7); also exported for manual app use.                                                                                                                                                                                         |
| `SubdomainResolver`                                                                                                                                                                                     | class                 | `createResolver()` builds it when `resolver: 'subdomain'`; custom-construction by apps.                                                                                                                                                                                          |
| `HeaderResolver`                                                                                                                                                                                        | class                 | `createResolver()` for `resolver: 'header'`; custom use.                                                                                                                                                                                                                         |
| `PathResolver`                                                                                                                                                                                          | class                 | `createResolver()` for `resolver: 'path'`; custom use.                                                                                                                                                                                                                           |
| `JwtResolver`                                                                                                                                                                                           | class                 | `createResolver()` for `resolver: 'jwt'`; custom use.                                                                                                                                                                                                                            |
| `ColumnPerTenant`                                                                                                                                                                                       | class (strategy)      | `createStrategy()` for `database: 'column-per-tenant'` (default); its `getTenantColumn()` is read by `MemoryTenantDataStore` via `useIsolation` (3.3/3.5), `kind` by the health indicator.                                                                                       |
| `SchemaPerTenant`                                                                                                                                                                                       | class (strategy)      | `createStrategy()` for `database: 'schema-per-tenant'`; `resolveSchema()` read by `MemoryTenantDataStore`'s partition derivation + any injected store, `kind` by health.                                                                                                         |
| `DatabasePerTenant`                                                                                                                                                                                     | class (strategy)      | `createStrategy()` for `database: 'database-per-tenant'`; `resolveDatabase()` read by `MemoryTenantDataStore`'s partition derivation + any injected store, `kind` by health.                                                                                                     |
| `MemoryTenantDataStore`                                                                                                                                                                                 | class (default store) | `register()` instantiates it (with `generateId: () => ctx.runtime.uuid()`) when no `dataStore` option is given; `TenantRepository` delegates to it.                                                                                                                              |
| `getTenantCachePrefix`                                                                                                                                                                                  | function              | Exported accessor reading the `ctx.state` cache prefix the middleware stamps (3.9), so consumers never hardcode the state key.                                                                                                                                                   |
| `TenantNotResolvedError`                                                                                                                                                                                | class (Error)         | Thrown by `MultiTenancyService.getRepository` (3.4); consumers `instanceof`-check.                                                                                                                                                                                               |
| `ITenantDataStore`                                                                                                                                                                                      | interface (type)      | Implemented by app-provided real-DB stores (injection port, like M31 `IFlagStore`); the plugin's `TenantRepository` consumes it and `register()` calls its `useIsolation?`.                                                                                                      |
| `ITenantIsolationStrategy`, `TenantIsolationKind`                                                                                                                                                       | types                 | `MultiTenancyPluginOptions.database` accepts a custom `ITenantIsolationStrategy`, and ARCHITECTURE:1418 commits "custom database strategy" as an extension point — an app cannot implement an unexported interface. Also the parameter type of `ITenantDataStore.useIsolation?`. |
| `MultiTenancyPluginOptions` + sub-option types (`SubdomainResolverOptions`, `HeaderResolverOptions`, `PathResolverOptions`, `JwtResolverOptions`, `TenantCacheOptions`, `MemoryTenantDataStoreOptions`) | types                 | The argument type of `MultiTenancyPlugin(...)` / `new MemoryTenantDataStore(...)`; the option fields are each READ in `register()`/the factories (see §4.1).                                                                                                                     |
| Re-exported from `common`: `IMultiTenancyService`, `ITenantRepository`, `ITenant`, `ITenantResolver`, `CAPABILITIES`                                                                                    | types/const           | Convenience one-stop import for consumers; canonical definitions stay in `common`.                                                                                                                                                                                               |

`MultiTenancyService` (the class) and `TenantRepository` (the wrapper) are **not** exported —
consumers obtain the service via
`ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY)` and hold the repo as the
committed `ITenantRepository<Entity, Id>` (tests import them directly from their source paths, not
via the barrel).

### 4.1 Options — every option names its consumer

| Option                                                                                                   | Consumer                                                                 | Behavior (per implementation)                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver` (`'subdomain'\|'header'\|'path'\|'jwt'\|ITenantResolver\|ITenantResolver[]`)                  | `createResolver()` in `register()`                                       | Builds the resolver chain; string discriminants map to the four classes; a custom instance/array is used as given. **Typed required** (not optional) — the type system rejects an absent resolver, so there is deliberately no runtime `resolver`-absent throw: such a branch would be unreachable without an unsound cast (`as any` is banned) and could never clear the 90% bar. |
| `subdomain.baseDomain?`                                                                                  | `SubdomainResolver` ctor                                                 | Stripped from the host to isolate the tenant label. Absent → first host label is the tenant id.                                                                                                                                                                                                                                                                                    |
| `header.name?`                                                                                           | `HeaderResolver` ctor                                                    | Header to read; default `'x-tenant-id'`.                                                                                                                                                                                                                                                                                                                                           |
| `path.segment?`                                                                                          | `PathResolver` ctor                                                      | Segment index (default `0`) to read from `request.path`. The only knob — no `param` option exists (3.6).                                                                                                                                                                                                                                                                           |
| `jwt.claim?` / `jwt.headerName?` / `jwt.decode?`                                                         | `JwtResolver` ctor + `register()`                                        | Claim name (default `'tenant_id'`), header (default `'authorization'`), custom decoder; if `jwt.decode` absent, `register()` resolves `IJwtService` from `CAPABILITIES.JWT` and wires `decode`. Fail-fast if neither is available.                                                                                                                                                 |
| `database` (`'column-per-tenant'\|'schema-per-tenant'\|'database-per-tenant'\|ITenantIsolationStrategy`) | `createStrategy()` → `store.useIsolation?.(strategy)` + health indicator | Maps to the strategy class or uses the custom instance; default `'column-per-tenant'`. The resolved strategy is handed to the data store, which derives its partition scope from it (3.3/3.5) — that handoff is what makes this option load-bearing rather than metadata nobody reads.                                                                                             |
| `dataStore?: ITenantDataStore`                                                                           | `register()`                                                             | The CRUD backend; default `new MemoryTenantDataStore({ generateId: () => ctx.runtime.uuid() })`.                                                                                                                                                                                                                                                                                   |
| `cache.prefix?` / `cache.separator?`                                                                     | `tenantMiddleware` + `MultiTenancyService.prefixCacheKey`                | Prefix stamping into `ctx.state` + the key-prefixer, both funnelled through `prefixCacheKey` (3.9). Default no prefix; separator default `':'`.                                                                                                                                                                                                                                    |
| `required?: boolean`                                                                                     | `tenantMiddleware`                                                       | Short-circuit on unresolved tenant (3.8); default `false`.                                                                                                                                                                                                                                                                                                                         |
| `rejectionStatus?: number`                                                                               | `tenantMiddleware`                                                       | Status code when short-circuiting; default `400`.                                                                                                                                                                                                                                                                                                                                  |
| `middlewarePriority?: number`                                                                            | `register()`                                                             | Priority passed to `ctx.middleware.add`; default `40`.                                                                                                                                                                                                                                                                                                                             |
| `MemoryTenantDataStoreOptions.generateId?`                                                               | `MemoryTenantDataStore.create`                                           | Id source when the created record carries no `string`/`number` `id`; default an in-process monotonic counter, and `register()` passes `() => ctx.runtime.uuid()` for the default store (3.3).                                                                                                                                                                                      |

## 5. Implementation files

| File                                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                          | Barrel: replaces the M0 stub (`export {}`) with all §4 exports + the `common` re-exports.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/plugin/multi-tenancy-plugin.ts`    | `MultiTenancyPlugin(options)` factory: `name`, `version: '0.1.0'`, `provides: [CAPABILITIES.MULTI_TENANCY]`, `optionalDependencies: [CAPABILITIES.LOGGER, CAPABILITIES.JWT]`, `priority: PLUGIN_PRIORITY.NORMAL`. `register()` builds resolver chain + strategy + store, constructs `MultiTenancyService`, registers it, auto-adds `tenantMiddleware`, registers the `multi-tenancy` health indicator, registers `onClose`. Also `createResolver()`/`createStrategy()` helpers (file-local or in interfaces). |
| `src/services/multi-tenancy-service.ts` | `MultiTenancyService` implementing `IMultiTenancyService`: `getCurrentTenant(ctx)` (reads `ctx.request.tenant`), `getRepository(ctx, entity)` (throws `TenantNotResolvedError` else returns `new TenantRepository(…)`), `prefixCacheKey(tenantId, key)`.                                                                                                                                                                                                                                                      |
| `src/repositories/tenant-repository.ts` | `TenantRepository<Entity, Id>` implementing `ITenantRepository<Entity, Id>`; captures `{ store, tenantId, entity }`, delegates each method to `ITenantDataStore`. (Not exported from barrel.)                                                                                                                                                                                                                                                                                                                 |
| `src/stores/memory-tenant-store.ts`     | `MemoryTenantDataStore` implementing `ITenantDataStore`: `Map<scope, Map<entity, Map<Id, unknown>>>` with the scope derived from the strategy received via `useIsolation`, `create` id assignment via `generateId`, cross-tenant isolation, `close()`.                                                                                                                                                                                                                                                        |
| `src/resolvers/subdomain-resolver.ts`   | `SubdomainResolver` (`ITenantResolver`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/resolvers/header-resolver.ts`      | `HeaderResolver` (`ITenantResolver`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/resolvers/path-resolver.ts`        | `PathResolver` (`ITenantResolver`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/resolvers/jwt-resolver.ts`         | `JwtResolver` (`ITenantResolver`) — added beyond ROADMAP's 3-file list (conflict C4).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/strategies/column-strategy.ts`     | `ColumnPerTenant` only — the class, implementing the `'column'` arm.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/strategies/schema-strategy.ts`     | `SchemaPerTenant` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/strategies/database-strategy.ts`   | `DatabasePerTenant` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/middleware/tenant-middleware.ts`   | `tenantMiddleware(service, resolvers, opts)` — resolve (catching a throwing resolver and logging via the optional logger), set `ctx.request.tenant`, short-circuit when `required`, stamp the `ctx.state` cache prefix via `service.prefixCacheKey`. Also `TENANT_CACHE_PREFIX_STATE_KEY` (module const) and the exported `getTenantCachePrefix(ctx)` accessor.                                                                                                                                               |
| `src/interfaces/index.ts`               | The **single** declaration home for every plugin-side type: `MultiTenancyPluginOptions` + sub-option types (`SubdomainResolverOptions`, `HeaderResolverOptions`, `PathResolverOptions`, `JwtResolverOptions`, `TenantCacheOptions`, `MemoryTenantDataStoreOptions`), `ITenantDataStore`, `ITenantIsolationStrategy`, `TenantIsolationKind`. The strategy files import these — they do **not** re-declare them. Type-only, so it emits no coverage (M31 precedent, §1). (Added beyond ROADMAP's list.)         |
| `src/errors.ts`                         | `TenantNotResolvedError`. (Small dedicated file for the exported error, precedent: worker-pool `errors.ts`.)                                                                                                                                                                                                                                                                                                                                                                                                  |

`common` edits (same PR, flagged widening): `packages/common/src/services/tenancy.ts` (add
`IMultiTenancyService`, `ITenantRepository`), `packages/common/src/http.ts` (add `tenant?: ITenant`
to `IRequest`, import `ITenant` type), `packages/common/src/index.ts` (export the two new types).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                            | src covered                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/barrel-exports.test.ts`                                                                   | `src/index.ts`                                     | Every §4 export is present and `typeof`-correct; re-exports from `common` resolve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/multi-tenancy-plugin.test.ts`                                                             | `src/plugin/multi-tenancy-plugin.ts`               | `name === 'multi-tenancy-plugin'`, `version === '0.1.0'`, `provides`/`optionalDependencies` correct; `register()` registers the service under `CAPABILITIES.MULTI_TENANCY`, adds middleware (priority/name, and `middlewarePriority` override honored), registers the health indicator (returns `{ status: 'up', data: { resolver, strategy, store } }` — `store: 'custom'` with an injected store, `'memory'` without), registers `onClose`; `onClose` calls `store.close()`; **`register()` calls `store.useIsolation(strategy)` on a recording fake with the strategy the `database` option selected — one case per arm, plus a store WITHOUT `useIsolation` to prove the optional call is guarded**; the default store is constructed with a `generateId` that delegates to `ctx.runtime.uuid()`; throws fail-fast when `resolver:'jwt'` and no JWT + no `jwt.decode`; wires `jwt.decode` from `CAPABILITIES.JWT` when the capability IS registered; duplicate `register()` of the plugin surfaces the kernel's duplicate-name/provider error path (asserted via the registry, not re-implemented). (No `resolver`-absent test: the option is typed required — §4.1.) |
| `test/unit/multi-tenancy-service.test.ts`                                                            | `src/services/multi-tenancy-service.ts`            | `getCurrentTenant(ctx)` returns `ctx.request.tenant` and `undefined` when absent; `getRepository(ctx,'User')` throws `TenantNotResolvedError` without a tenant and returns an `ITenantRepository<User>` with one; `prefixCacheKey('t1','k')` === `'t1:k'` and honors custom separator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/tenant-repository.test.ts`                                                                | `src/repositories/tenant-repository.ts`            | `findAll/findById/find/create/update/delete` delegate to a fake `ITenantDataStore` with the **captured** `tenantId` + `entity`; a fake returning specific data is read back unchanged; isolation: repo built for tenant `A` never passes tenant `B`'s id to the store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/memory-tenant-store.test.ts`                                                              | `src/stores/memory-tenant-store.ts`                | CRUD round-trips (write→read-back); `find` filters by the provided filter record; cross-tenant isolation (tenant A cannot read tenant B's rows); `update` returns `null` for an unknown id; `delete` returns `true`/`false` correctly; `close()` resolves. **Id branches:** a `create` with a `string`/`number` `id` in `data` keeps it, one without calls `generateId` (default counter and an injected generator both asserted). **Strategy branches:** one round-trip per `useIsolation` arm — `'column'` stamps `getTenantColumn()` on the row (findable by filtering that column), `'schema'`/`'database'` partition under `resolveSchema`/`resolveDatabase` output (asserted not to collide with the bare tenant-id scope), and a store that never received `useIsolation` partitions by tenant id.                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/subdomain-resolver.test.ts`                                                               | `src/resolvers/subdomain-resolver.ts`              | `resolve({url:'https://acme.example.com'})` → `some({id:'acme'})`; with `baseDomain:'example.com'` strips correctly; bare domain/localhost → `none()`. Signature: `resolve(request: IRequest): Promise<Option<ITenant>>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/header-resolver.test.ts`                                                                  | `src/resolvers/header-resolver.ts`                 | Reads default `'x-tenant-id'` and custom header; absent → `none()`; empty → `none()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/path-resolver.test.ts`                                                                    | `src/resolvers/path-resolver.ts`                   | Reads segment index `0` (and custom index) from `request.path`; empty/missing segment → `none()`; out-of-range index → `none()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/jwt-resolver.test.ts`                                                                     | `src/resolvers/jwt-resolver.ts`                    | With an injected fake `decode`: valid token + claim → `some({id})`; missing header → `none()`; malformed token (`decode` returns `null`) → `none()`; claim absent → `none()`; custom `claim`/`headerName` honored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/column-strategy.test.ts`                                                                  | `src/strategies/column-strategy.ts`                | `kind === 'column'`; `getTenantColumn()` default `'tenant_id'` and custom value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/schema-strategy.test.ts`                                                                  | `src/strategies/schema-strategy.ts`                | `kind === 'schema'`; `resolveSchema('acme')` default `` `tenant_acme` `` and custom prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/database-strategy.test.ts`                                                                | `src/strategies/database-strategy.ts`              | `kind === 'database'`; `resolveDatabase('acme')` default and custom.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/tenant-middleware.test.ts`                                                                | `src/middleware/tenant-middleware.ts`              | (a) success sets `ctx.request.tenant` + calls `next()`; (b) `required:true` + `none()` → short-circuits at `rejectionStatus` (default `400`, custom value honored) with the exact body `{ error: 'Tenant Required', message: … }` **without** `next()` and a downstream handler spy is NOT called; (c) not-required + `none()` → proceeds, `ctx.request.tenant === undefined`, `next()` called; (d) chain order (first `Some` wins — a later resolver's `resolve` spy is never invoked); (e) `cache.prefix:true` → `getTenantCachePrefix(ctx)` returns the prefix, `undefined` when `prefix` is absent, and under a **non-default** separator the stamped prefix agrees with `service.prefixCacheKey` (both entry points, one test); (f) a resolver whose `resolve` rejects is `warn`-logged through a recording fake logger and treated as `none()` — the next resolver still runs — and the same input with no logger configured neither throws nor logs.                                                                                                                                                                                                               |
| `test/unit/errors.test.ts`                                                                           | `src/errors.ts`                                    | `TenantNotResolvedError` is an `Error`, carries a message, and is `instanceof`-checkable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/integration/multi-tenancy-integration.test.ts`                                                 | cross-file (plugin + service + middleware + store) | Build a test app, register the plugin with `resolver:'header'`, `database:'column-per-tenant'`; send a request with `x-tenant-id: acme`; assert `ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY)` resolves; in a handler call `tenancy.getRepository<User>(ctx,'User').create({name:'Ada'})` then `.findAll()` returns the user **including its generated `id`** (write→read-back through the real memory store, whose ids came from `runtime.uuid()`); a second tenant's request's `findAll()` does NOT see it (cross-tenant isolation); a `required:true` app rejects a request with no `x-tenant-id` at 400 and the handler never runs; health indicator reports `{ status:'up', data:{resolver:'header', strategy:'column', store:'memory'} }`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/fixtures/fake-context.ts`, `fake-request.ts`, `fake-store.ts`, `fake-jwt.ts`, `fake-logger.ts` | (test fixtures, excluded from coverage)            | Minimal fakes honoring real contracts: a fake `IRequest`/`IRequestContext` (monotonic `startTime` from `performance.now()` as the kernel sets it, writable `request.user`/`request.tenant`, real `state` Map, non-aborting `signal`), a recording fake `ITenantDataStore` (with a variant that omits the optional `useIsolation`), a fake `decode` for `JwtResolver`, and a recording `ILogger`. Fixtures cross-checked against the real producers (kernel/runtime source) per the CLAUDE.md test-double rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`src/interfaces/index.ts` has **no** named test file by design: it is type-only (no exported
`const`/`function`/`class`), so it compiles to nothing and never appears in the per-file coverage
table — the same as `packages/feature-flags-plugin/src/interfaces/index.ts` today (§1). Every other
`src/` file in §5 is mapped above.

**External-dependency / guarded real-import tests: NONE required.** This plugin has **zero npm
dependencies** — verified by design: resolvers parse `IRequest` strings; `JwtResolver` uses the
resolved `IJwtService.decode` (Web-Crypto impl in the auth plugin), not an imported JWT library;
strategies are pure string derivation; the memory store is in-process maps; cache prefixing is
string concatenation. No `npm:` specifier is imported anywhere in `src/`, so there is no guarded
real-import test to write (the M9/M14b precedent does not apply).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/32-multi-tenancy-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

The `common` edits also re-run `deno task check` / `test` across the workspace (no consumer breaks —
`tenant?` is an additive optional field; `IMultiTenancyService`/`ITenantRepository` are net-new).

## 8. Risks & mitigations

- **`JwtResolver` trusts an unverified token claim for tenant identity** → documented in JSDoc +
  here; acceptable only because auth middleware separately verifies the token. Apps without the auth
  plugin are warned a client could spoof the claim. No signature verification is added (would
  duplicate auth and require key config).
- **The data-store port pushes real-DB isolation into app code** → by design (no committed
  data-access port exists). Mitigated by the metadata-producing strategies handed to the store
  through `useIsolation` + the shipped `MemoryTenantDataStore` that derives its partition scope from
  the strategy end-to-end; the integration test proves write→read-back and cross-tenant isolation
  through the real default store.
- **A `useIsolation`-ignoring store silently loses isolation metadata** → `useIsolation` is optional
  (a store may legitimately not care), so a store that omits it still works, just with no
  strategy-derived scoping. Mitigated by documenting the contract on the port's JSDoc and by the
  plugin-test case that registers a store WITHOUT `useIsolation` and asserts the optional call is
  guarded rather than throwing.
- **`PathResolver` cannot read router `:param` values** (resolver interface gives only `IRequest`) →
  documented limitation (3.6); parses `request.path` by segment index instead, and ships **no**
  `param` option so nothing dead is stored. A future `common` widening of `ITenantResolver` to
  receive `IRequestContext` would enable param-based path resolution; deferred (out of scope).
- **`getRepository(ctx, entity)` deviates from ROADMAP's ctx-less example** → resolved as conflict
  C3 and shipped as a ROADMAP/PUBLIC_API correction; the deviation is mandatory (no ambient context,
  AI_GUIDELINES §11.4).
- **`common` widening (`IRequest.tenant`, `IMultiTenancyService`, `ITenantRepository`) is a
  public-API change requiring approval** (AI_GUIDELINES §10.2/§16.1) → flagged in the PR
  description, PUBLIC_API updated in the same PR, all additions are additive (no break to existing
  consumers).
- **Auto-added middleware ordering vs app-added `authMiddleware`** → not load-bearing for resolution
  (`JwtResolver` decodes independently); documented; `middlewarePriority` option + exported
  `tenantMiddleware()` let the app reorder if needed. ARCHITECTURE §10's table gains the priority-40
  row so the pipeline stays documented (conflict C5).
- **A throwing resolver could mask a misconfiguration silently** → the catch treats a rejection as
  `none()` (3.6), matching `auth-middleware.ts:31`. Mitigated by the `warn` log through the optional
  logger and by `required: true`, which turns a persistently-unresolvable tenant into a visible 400
  rather than a request that proceeds tenant-less.

## 9. Out of scope

- Real-ORM schema/database switching — owned by an application-provided `ITenantDataStore` (this
  plugin defines the port + metadata only).
- A tenant onboarding/admin CRUD API and tenant lifecycle management — future milestone.
- Per-tenant configuration overrides (ConfigPlugin integration) — future milestone.
- Tenant-aware database migrations — future milestone.
- The illustrative `@CurrentTenant()` parameter decorator (PUBLIC_API.md:4313) — the decorator
  plugin's `current-tenant` resolver is not shipped here (not a ROADMAP deliverable); handlers read
  `ctx.request.tenant` directly.
- Ambient/AsyncLocalStorage-based "current tenant" (so `getRepository` could be ctx-less) — rejected
  (AI_GUIDELINES §11.4 forbids hidden globals); `getRepository` threads `ctx` instead.
