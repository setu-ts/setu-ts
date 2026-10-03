# Milestone 101c — tenancy and identity features that do not compose

> **Status:** Planning. Branch: `feat/m101c-identity-composition`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Four features that each work alone and silently stop working, or deny service, in the composition
their own documentation describes. A session's tenant binding compares against a tenant that does
not exist yet; the tenant repository writes to a memory store with no bridge to the database the
application actually uses; the SAML CSRF recipe refuses the identity provider it was written for;
and a foreign browser's post of a SAML response burns the victim's pending login. Closes
`smoke/DEFECTS.md` rows **V8-7, V8-8, V8-9, V8-25**.

**Sequence (decided in `PLAN-BRIEF.md`):** independent of every other M101 letter. It lands before
M101h, which documents the final shapes this letter ships and must NOT re-document the SAML recipe
(this letter owns V8-9's correction) nor re-document the multi-tenancy `dataStore` option.

- **In scope:** `packages/session-plugin` (V8-7 compare site + README), `packages/common` (two
  shared constants and one pure helper for V8-7; the `ITenantDataStore` and
  `ITenantIsolationStrategy` ports for V8-8), `packages/multi-tenancy-plugin` (V8-7 compare at the
  tenant side, V8-8 factory arm), `packages/database-plugin` (V8-8 bridge implementation),
  `packages/http-security-plugin` (V8-9 `csrf.exclude`), `packages/auth-plugin` (V8-9 README recipe,
  V8-25 ACS order).
- **NOT this milestone:** V8-43's five missing multi-tenancy option rows (M101h — this letter edits
  only the `dataStore` row of that table, and M101h rebases on it); a `schema`/`database` isolation
  strategy over `database-plugin` (declined with cause in §3.4 — `IRepository` has no schema
  switch); `IRepository`/`IDatabaseService` promotion into `common` (not needed, see §3.3); the
  session cookie strategy's documented "a stolen cookie stays valid until `Max-Age`" trade-off (M48,
  unchanged); any change to `JwtResolver`'s unverified-claim warning (M89a, unchanged).

## 1. Contracts verified from SOURCE (not names)

| Reference                                             | Source (file:line)                                                                                                                                          | Verified surface / fact                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session middleware compare site                       | `packages/session-plugin/src/middleware/session-middleware.ts:53-63`                                                                                        | compares `readTenantBinding(session)` against `ctx.request.tenant?.id` BEFORE `next()`; mismatch answers `403` through `respondWithError`. Seal runs AFTER `next()` at `:75-80`. Signature `sessionMiddleware(service, tenantBinding = true)` at `:41-44`                                                                         |
| Session middleware priority                           | `packages/session-plugin/src/plugin/session-plugin.ts:29-34,121-123`                                                                                        | a package-LOCAL `MIDDLEWARE_PRIORITY = { SESSION: 260, CSRF_FORM: 275 }` (there is no shared table in `common`); registered at `SESSION`                                                                                                                                                                                          |
| `SessionMiddlewareMissingError` names 260             | `packages/session-plugin/src/errors.ts:45-58`                                                                                                               | the ROADMAP's citation holds: the message names "260 (the session middleware's priority)"                                                                                                                                                                                                                                         |
| `tenantBinding` option                                | `packages/session-plugin/src/options.ts:148-156,211`                                                                                                        | `readonly tenantBinding?: boolean`, default `true`; JSDoc promises refusal "before the handler runs"                                                                                                                                                                                                                              |
| Binding key and helpers                               | `packages/session-plugin/src/services/session-tenant-binding.ts:23,31-34,42-44`                                                                             | `TENANT_BINDING_KEY = '__setu_tenant'`; `readTenantBinding(session): string \| undefined`; `sealTenantBinding(session, id)`. NOT barrel-exported (`src/index.ts:34-73` lists neither)                                                                                                                                             |
| Session state key                                     | `packages/session-plugin/src/services/session-service.ts:37`                                                                                                | `SESSION_STATE_KEY = 'session-plugin:session'`; the `common` state-key table ALREADY lists it as a shared key (`packages/common/src/state-keys.ts:25`) but defines only `CLIENT_IP_STATE_KEY` (`:48`)                                                                                                                             |
| `ISession` / `ISessionService` in `common`            | `packages/common/src/services/session.ts:64,150-181`                                                                                                        | `ISession` is a committed contract; `ISessionService.from(ctx)` THROWS when the middleware did not run (`:160`), so it is not a probe a middleware at priority 40 can call per request                                                                                                                                            |
| Auth passive priority                                 | `packages/auth-plugin/src/plugin/auth-plugin.ts:50`                                                                                                         | `AUTH_MIDDLEWARE_PRIORITY = 300`; M100a registers passive authentication globally there                                                                                                                                                                                                                                           |
| Tenant middleware priority and stamp                  | `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:151,278-286`; `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:117-137` | default `middlewarePriority = 40`; the resolver chain runs and `replaceTenant(ctx.request, resolved)` stamps the tenant. `respondWithError` and `createPathMatcher` are already imported (`:16`)                                                                                                                                  |
| Shipped `JwtResolver` reads the HEADER                | `packages/multi-tenancy-plugin/src/resolvers/jwt-resolver.ts:40-61`                                                                                         | `request.headers.get(this.headerName)` + unverified decode — it never reads `ctx.request.user`, so it resolves at 40, BEFORE the session compare. See §2 C1                                                                                                                                                                       |
| `IRequest.user` / `IRequest.tenant`                   | `packages/common/src/http.ts:57,66`; `packages/common/src/request-identity.ts:182`                                                                          | both optional writable fields; `replaceTenant(request, tenant)` is the explicit replacement escape (M71)                                                                                                                                                                                                                          |
| `ITenantDataStore` port                               | `packages/multi-tenancy-plugin/src/interfaces/index.ts:162-196`                                                                                             | `useIsolation?(strategy)`, `findAll`, `findById`, `find(tenantId, entity, filter)`, `create`, `update` (returns `E \| null`), `delete`, `close?`. Declared IN the plugin, so `database-plugin` cannot name it today (§2.2)                                                                                                        |
| `ITenantIsolationStrategy`                            | `packages/multi-tenancy-plugin/src/interfaces/index.ts:211-214`                                                                                             | union on `kind`: `'column'` carries `getTenantColumn()`; `ColumnPerTenant` defaults the column to `'tenant_id'` (`strategies/column-strategy.ts:19-25`)                                                                                                                                                                           |
| `dataStore` option and X18-5 warning                  | `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:148-156,238-260,263-265`                                                                  | `dataStore?: ITenantDataStore` (`interfaces/index.ts:126`); the warning fires on `providedStore === undefined`; the store is built, `assertUsableStore`d and handed the strategy inside `register()`                                                                                                                              |
| `MultiTenancyService` holds the store                 | `packages/multi-tenancy-plugin/src/services/multi-tenancy-service.ts:21-28,39-63`                                                                           | constructor takes `{ store, separator? }`; `getRepository`/`getRepositoryFor` build a `TenantRepository` over `this.store`                                                                                                                                                                                                        |
| `IRepository` / `IDatabaseService` live in the PLUGIN | `packages/database-plugin/src/interfaces/index.ts:74-129,187-197`                                                                                           | `findAll(options?: FindOptions)`, `findOne`, `create(data)`, `update(id, data): Promise<Entity>`, `delete(id): Promise<boolean>`; `IDatabaseService.getRepository<E, Id>(entity)`. NOT in `common` — the ROADMAP's "`ITenantDataStore` over `IDatabaseService`" cannot be typed inside `multi-tenancy-plugin`. See §2 C2 and §3.3 |
| `FindOptions`                                         | `packages/database-plugin/src/query/find-options.ts:29-50`                                                                                                  | `where?: Record<string, unknown>` (equality map), `filter?`, `orderBy?`, `limit?`, `offset?`, `select?`, `cursor?`                                                                                                                                                                                                                |
| `DatabasePlugin` registers in `register()`            | `packages/database-plugin/src/plugin/database-plugin.ts:108,111,145`                                                                                        | `provides: [token]`; `ctx.services.register<IDatabaseService>(token, service)` inside `register()`                                                                                                                                                                                                                                |
| `RegistryFactory` / `resolveRegistryEntry`            | `packages/common/src/registry.ts:66,216-220`                                                                                                                | `RegistryFactory<T> = (services: IServiceRegistry) => T`; `resolveRegistryEntry(entry, services, label)` — the M70d factory arm, resolved at `onInit`                                                                                                                                                                             |
| `ILifecycleApi.onInit`                                | `packages/common/src/plugin.ts:335,519`                                                                                                                     | `onInit(fn)` exists on `ctx.lifecycle`; the first phase at which the registry holds every capability (M70d)                                                                                                                                                                                                                       |
| Kernel orders optional dependencies                   | `packages/kernel/src/registry/plugin-resolver.ts:49-53`                                                                                                     | an `optionalDependencies` token adds a graph edge when a provider exists, so the provider registers first                                                                                                                                                                                                                         |
| `createPathMatcher` / `PathPattern`                   | `packages/common/src/path-matcher.ts:29,58-60`                                                                                                              | `PathPattern = string \| RegExp`; `createPathMatcher(patterns): (path) => boolean`, partitioned once (M90a)                                                                                                                                                                                                                       |
| `CsrfOptions` and the CSRF middleware                 | `packages/http-security-plugin/src/middleware/csrf-middleware.ts:16-31,39-101`                                                                              | options: `enabled?`, `trustedOrigins?`, `customHeader?` — NO path exclusion. Safe methods pass (`:54`); `Origin` is read verbatim (`extractOrigin`, `:111-115`), so `Origin: null` compares as the string `'null'` against `trustedOrigins` (`:91`) and is refused at `:97-101`                                                   |
| CSRF registration priority                            | `packages/http-security-plugin/src/plugin/http-security-plugin.ts:25-31,96-99`                                                                              | package-local `CSRF: 270`, opt-in on `options.csrf !== undefined`                                                                                                                                                                                                                                                                 |
| Session form-CSRF `exclude` precedent                 | `packages/session-plugin/src/options.ts:79`; `packages/session-plugin/src/csrf/exclude.ts:14-27`                                                            | `exclude?: readonly (string \| RegExp)[]`; exact-string or `RegExp.test` with `lastIndex` reset — the semantics V8-9's new option copies                                                                                                                                                                                          |
| Auth README SAML CSRF recipe                          | `packages/auth-plugin/README.md:598-614`                                                                                                                    | prose says `trustedOrigins` admits the IdP origin; the fence sets `trustedOrigins: ['https://sts.example.com']` — the configuration X64 measured answering `403` against Keycloak's `Origin: null`                                                                                                                                |
| Existing composition gate                             | `packages/auth-plugin/test/integration/saml-csrf-composition.test.ts:49,72-94`                                                                              | drives the documented recipe with the IdP's REAL origin in `Origin`; never sends `Origin: null`, which is why it passes                                                                                                                                                                                                           |
| SAML ACS consume-before-bind order                    | `packages/auth-plugin/src/saml/routes.ts:352-419`                                                                                                           | `readBindingCookie` at `:357`; the per-request cache adapter consumes inside `removeAsync` (`:381-382`) and again at `:405`; the binding compare is at `:414-419`, AFTER consumption. The `:390-391` comment records that node-saml calls `removeAsync` on its failure path                                                       |
| Request store surface                                 | `packages/auth-plugin/src/stores/saml-request-store.ts:53-73`                                                                                               | `saveRequest`, `peekRequest(requestId, now)` (a READ), `consumeRequest(requestId, now)` (single-winner), `claimAssertionId`                                                                                                                                                                                                       |
| Library cache contract                                | `packages/auth-plugin/src/saml/engine.ts:18-20,68,97`                                                                                                       | `SamlCacheProvider { saveAsync, getAsync(key): Promise<string \| null>, removeAsync(key \| null) }` handed to node-saml as `cacheProvider`                                                                                                                                                                                        |
| Real-library ACS suite                                | `packages/auth-plugin/test/integration/saml-acs.test.ts:247-292`                                                                                            | already has "posted by a browser without the binding cookie", "InResponseTo names another browser's login" and the concurrent-post case; none asserts that the VICTIM can still sign in afterwards — the V8-25 gap                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                  | Doc deliverable (same PR)                                                                                                                                           |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` M101c says "a `JwtResolver`-style tenant is always absent at compare time". The shipped `JwtResolver` reads the raw `Authorization` header (§1) and runs at 40, so it IS present at 260. The inert case is a tenant stamped AFTER 260 — a resolver that needs `ctx.request.user` at a `middlewarePriority` above 300, or application code setting the tenant later | The source wins. The defect is real but its subject is "any tenant resolved after the session loads", not the shipped `JwtResolver`                                                                                                                                       | Reported to the maintainer in the hand-back (the brief forbids editing `ROADMAP.md` here); the session README section written for V8-7 states the correct condition |
| C2 | `ROADMAP.md` M101c and `X58-FINDINGS.md` name the V8-8 bridge "an `ITenantDataStore` over `IDatabaseService` resolved at `onInit`". `IDatabaseService` is declared in `database-plugin`, not `common`, so `multi-tenancy-plugin` cannot type such a store (§1); and `ITenantDataStore` is declared in `multi-tenancy-plugin`, so `database-plugin` cannot implement it by name  | The bridge's PORT moves to `common` and its IMPLEMENTATION lives in `database-plugin` (§3.3); `multi-tenancy-plugin` resolves it through M70d's `RegistryFactory` at `onInit`, exactly as the ROADMAP's timing says                                                       | Reported in the hand-back; the multi-tenancy README "Isolation strategies" prose and `PUBLIC_API.md` Multi-Tenancy section document the bridge where it lives       |
| C3 | `PUBLIC_API.md:3792` and `options.ts:148-156` promise `tenantBinding` refuses "before the handler runs"; for a tenant stamped after 260 the compare never ran at all                                                                                                                                                                                                            | The promise is kept by moving the compare to wherever the tenant becomes known (§3.1), and the docs gain the one case that remains outside it: a tenant written by APPLICATION code inside a handler is compared at commit, after the handler                             | `PUBLIC_API.md` `tenantBinding` row + session README "Tenant binding" section                                                                                       |
| C4 | `packages/multi-tenancy-plugin/README.md` says "No shipped database adapter is told the strategy" (`interfaces/index.ts:114-119` JSDoc repeats it) — true today, false once §3.3 ships                                                                                                                                                                                          | Update both sites to name the shipped bridge and the strategies it supports (`column` only)                                                                                                                                                                               | multi-tenancy README "Isolation strategies" + the `database` option JSDoc + `PUBLIC_API.md:7051` section                                                            |
| C5 | `packages/auth-plugin/README.md:598-614` documents the SAML CSRF composition with `trustedOrigins` naming the IdP, and `PUBLIC_API.md:2905-2907` documents `CsrfOptions` with no exclusion                                                                                                                                                                                      | Keycloak's `Referrer-Policy: no-referrer` makes the browser send `Origin: null`, which no origin allowlist can admit safely. The recipe becomes `csrf: { exclude: ['/auth/corp/acs'] }` on BOTH plugins, with `trustedOrigins` kept only for IdPs that send a real origin | auth README SAML "CSRF composition" paragraph + fence; http-security README `CsrfOptions` table; `PUBLIC_API.md` `HttpSecurityPlugin()` CSRF paragraph              |

## 3. Design decisions

### 3.1 V8-7 — the binding compare runs on whichever side sees the tenant second

- **Decision:** the compare has TWO call sites sharing ONE implementation. (a) The session
  middleware keeps its load-time compare (it already runs when the tenant was resolved first, which
  is every shipped resolver at the default priority 40). (b) The tenant middleware, right after
  `replaceTenant(ctx.request, resolved)` (`tenant-middleware.ts:137`), reads the session the session
  middleware put in `ctx.state` — present only when the session loaded FIRST — and runs the same
  compare; a mismatch short-circuits with the identical `403 Tenant Mismatch` through
  `respondWithError`, without calling `next()`. The shared pieces move to `common`:
  `SESSION_STATE_KEY` (joins `state-keys.ts`, whose table already lists it as shared),
  `SESSION_TENANT_BINDING_KEY = '__setu_tenant'`, and a pure
  `tenantBindingMismatch(session: ISession, tenantId: string | undefined): boolean`. Session-plugin
  imports all three (its local copies are deleted — the M47 frame-codec / M70n `validatedStateKey`
  shape: a key two packages must agree on byte-for-byte lives in `common`). The seal stays where it
  is (`:75-80`) — it runs after `next()` and therefore sees a late tenant — but its condition
  narrows from "the binding differs from the current tenant" to "the session carries NO binding": a
  bound session is never rebound. Without that, (b) would be undone one frame up: the tenant
  middleware at 310 has already called `replaceTenant(ctx.request, b)` when it refuses, the session
  middleware's `await next()` then resumes, and today's `readTenantBinding(session) !== current`
  seals `b` over `a` and commits it, so the NEXT request under `b` passes the compare. Narrowing the
  condition, rather than having the refusal set a skip marker, closes every path that resumes the
  seal with a mismatched tenant — the refusal, a handler-written tenant, and any third-party
  middleware — and is behaviour-identical on the load-compare path, where a mismatched bound session
  never reaches `next()`.
- **Why this and not the ROADMAP's two arms:** "defer the compare to commit" is unsafe — by commit
  the handler has run under the mismatched session, which is the cross-tenant write the binding
  exists to stop; it would turn a refusal into a silent after-the-fact drop. "Refuse the composition
  at `register()`" is not implementable: the session plugin cannot see the tenancy plugin's
  `middlewarePriority`, and no capability exposes it. Running the compare at the point the tenant
  becomes known is order-independent and needs no configuration. The multi-tenancy side reads
  `ctx.state` directly rather than calling `ISessionService.from(ctx)`, which throws when the
  session has not loaded (§1) — a throw-and-catch per request at priority 40 is not a probe.
- **The one case that stays at commit:** a tenant written by application code INSIDE a handler is
  seen by neither middleware before the handler; on an UNBOUND session the seal records it and the
  NEXT request compares, and on a bound session it is not resealed, so the next request under the
  handler's tenant is refused. That is documented (C3), not fixed — no middleware can precede the
  handler's own write.
- **Test home:** `packages/multi-tenancy-plugin/test/integration/tenant-binding-order.test.ts` (new;
  a real kernel app with `SessionPlugin`, a custom `ITenantResolver` reading `ctx.request.user` at
  `middlewarePriority: 310`, and a fake auth middleware at 300 setting the principal). **Negative
  control:** without (b), a session minted under tenant `a` presented with a principal naming tenant
  `b` answers `200` and the handler runs; with it, `403` and the handler does not run. The same case
  then asserts the refusal did not rebind: the committed session's `__setu_tenant` is still `a`, a
  follow-up request under tenant `a` with the returned cookie answers `200`, and a follow-up under
  `b` is still `403`. **Negative control:** restore the seal's `!== current` condition — the binding
  reads `b` after the refusal and the follow-up under `b` answers `200`. A second case keeps the
  default-order path byte-identical: with `resolver: 'header'` at 40 the refusal still comes from
  the SESSION middleware (asserted by a marker the tenant-side compare does not set), so the shipped
  behaviour is unchanged.

### 3.2 V8-7 — the session README gains a "Tenant binding" section

- **Decision:** a `## Tenant binding` section in the session README (the option is absent from its
  options table and prose today, §1) states: what is sealed and when; that the compare runs on the
  side that resolves second, so middleware priority does not matter for the shipped resolvers or for
  a custom resolver at any priority; the handler-written-tenant caveat; and `false` as the opt-out.
  The `tenantBinding` row joins the options table.
- **Why:** the X58 agent had to read `session-middleware.ts` source to learn when the binding seals;
  the README is the page jsr.io renders.
- **Test home:** the fence compiler (`test/package-readme-fence-compiler.test.ts`) pins the README's
  fence count; the new section carries one compilable fence and the count moves from 11 to 12.

### 3.3 V8-8 — the bridge: port in `common`, implementation in `database-plugin`, factory arm in `multi-tenancy-plugin`

- **Decision:** three coordinated pieces, each in the only package §2.2 allows.
  1. `common` gains `ITenantDataStore` and `ITenantIsolationStrategy` (moved verbatim from
     `multi-tenancy-plugin/src/interfaces/index.ts:162-214`; the plugin re-exports both types from
     its barrel so every existing import keeps compiling — the M52c `IDatabaseAdapter` promotion:
     exactly one definition exists afterwards).
  2. `database-plugin` exports
     `createDatabaseTenantDataStore(options?): RegistryFactory<ITenantDataStore>` with
     `options.tenantColumn?: string` (default: whatever `useIsolation` later hands it, else
     `'tenant_id'`). The returned factory resolves `CAPABILITIES.DATABASE` from the registry it is
     handed — typed as the plugin's OWN `IDatabaseService`, the token's documented interface, so no
     token is cast to another interface — and returns a `DatabaseTenantDataStore` over
     `service.getRepository(entity)`. Per method: `findAll` →
     `findAll({ where: { [col]: tenantId } })`; `find` →
     `findAll({ where: { ...filter, [col]: tenantId } })` (the tenant column is spread LAST so a
     caller's filter cannot override it); `findById` →
     `findOne({ where: { id, [col]: tenantId } })`; `create` →
     `create({ ...data, [col]: tenantId })` (stamped last, same reason); `update` → `findOne` under
     the tenant first, `null` when absent, else `update(id, data)` with the tenant column STRIPPED
     from `data`; `delete` → `findOne` under the tenant first, `false` when absent, else
     `delete(id)`. `useIsolation(strategy)` accepts `kind: 'column'` (and adopts its column unless
     `tenantColumn` was given, in which case a disagreement throws naming both) and THROWS a named
     `TenantStoreStrategyUnsupportedError` for `'schema'`/`'database'` — `IRepository` offers no
     schema or database switch, so a silent accept would be the X18-5 defect in a shipped store.
  3. `MultiTenancyPluginOptions.dataStore` widens to
     `ITenantDataStore | RegistryFactory<ITenantDataStore>`. An instance keeps today's path exactly.
     A factory is resolved in `ctx.lifecycle.onInit` through
     `resolveRegistryEntry(entry, ctx.services, 'MultiTenancyPlugin.dataStore')` (the M70d resolver;
     `DATABASE` is NOT added to `optionalDependencies` — all `register()` phases complete before any
     `onInit`, so no ordering edge is needed), then `assertUsableStore`d and handed `useIsolation` —
     the SAME two calls the instance path makes, moved into one `bindStore` function both paths
     call. `MultiTenancyService` gains an internal late-binding slot: a repository call before the
     slot is bound throws `TenantDataStoreNotReadyError` naming `onInit` (unreachable on the HTTP
     path; reachable from a `register()`-time call, which is a misuse worth naming). The X18-5
     warning condition changes from `providedStore === undefined` to "no instance AND no factory".
     The health indicator's `store` field reports `'factory'` until bound, then `'custom'`.
- **Why:** an application constructs plugin options before any application exists, so a store that
  needs a resolved capability can only be a factory — and `RegistryFactory` is the committed
  mechanism for exactly that (M70d: `HealthPluginOptions.indicators`,
  `EventsPluginOptions.handlers`). The X58 suggestion of a store "over an `IDatabaseAdapter`
  instance shared with `DatabasePlugin({ type: 'custom', adapter })`" was rejected: only the
  `custom` arm exposes an adapter instance, so the bridge would be unreachable for every built-in
  backend. Putting the port in `common` is the only way `database-plugin` can implement it by name
  and the kernel can type it across the two plugins (§2.2).
- **Test home:** `packages/database-plugin/test/unit/database-tenant-data-store.test.ts` (unit, over
  a recording fake `IDatabaseService`) and
  `packages/database-plugin/test/integration/tenant-store-memory-adapter.test.ts` (the REAL
  `DatabaseService` over `MemoryAdapter`: a row written under tenant `a` is invisible to
  `findAll`/`findById`/`find`/`update`/`delete` under tenant `b`, and READ BACK under `a`).
  `packages/multi-tenancy-plugin/test/integration/database-bridge.test.ts` boots a real kernel app
  with `DatabasePlugin({ type: 'memory' })` +
  `MultiTenancyPlugin({ dataStore: createDatabaseTenantDataStore() })` and drives
  `getRepository(ctx, 'Patient')` over HTTP under two tenant headers. **Negative controls:** (1)
  remove the tenant column from `findAll`'s `where` — tenant `b` reads `a`'s row; (2) spread the
  tenant column FIRST in `find` — a filter naming `tenant_id: 'a'` under tenant `b` reads `a`'s
  rows; (3) resolve the factory in `register()` instead of `onInit` with `DatabasePlugin` registered
  AFTER the tenancy plugin and no ordering edge — the factory throws (this is the control that
  proves the `onInit` timing is load-bearing).

### 3.4 V8-8 — what the bridge refuses, stated as a table the tests iterate

- **Decision:** `useIsolation` behaviour is a three-row table in the unit test — `column` adopts,
  `schema` throws, `database` throws — rather than prose, so a fourth kind forces a decision.
- **Why:** "docs must match behaviour" — a prose list can drift silently; a table the test iterates
  cannot (the M90h secrets-table rule).
- **Test home:** `database-tenant-data-store.test.ts`.

### 3.5 V8-9 — `CsrfOptions.exclude`, and the recipe stops trusting an origin

- **Decision:** `CsrfOptions` gains `exclude?: readonly PathPattern[]` (default `[]`), compiled once
  with `createPathMatcher` and checked FIRST in the middleware, before the method test, so an
  excluded path is never inspected. The auth README recipe becomes `exclude: ['/auth/corp/acs']` on
  both the session plugin's form CSRF and `HttpSecurityPlugin`'s CSRF, and the paragraph says why:
  Keycloak serves `Referrer-Policy: no-referrer`, so Chrome posts the ACS with `Origin: null`;
  `trustedOrigins: ['null']` is the only allowlist answer and it admits every opaque-origin `POST`
  on every route, which is worse than the exemption. `trustedOrigins` stays documented for an IdP
  that sends a real origin. Exempting the ACS is sound for the reason the README already gives: the
  signed assertion, the single-use request and the binding cookie are the ACS's own defences.
- **Why `exclude` and not a documented `trustedOrigins: ['null']`:** the register measured the
  global alternative admitting `POST /login` with `Origin: null` on every route. An exemption is
  path-scoped; a trusted `null` is not.
- **Test home:** `packages/http-security-plugin/test/unit/csrf-middleware.test.ts` (exclusion before
  method check; literal and `RegExp` patterns; an excluded path with `Origin: null` passes while a
  non-excluded path with the same header is `403`). The composition gate
  `saml-csrf-composition.test.ts` gains a FOURTH cell: the documented recipe driven with
  `Origin: null` on the ACS post, which must sign in. **Negative control:** the existing recipe
  (`trustedOrigins: [IDP_ORIGIN]`) under `Origin: null` answers `403` — the register's exact
  reproduction — and the new cell fails without the `exclude` option.

### 3.6 V8-25 — the binding is checked before the request is consumed

- **Decision:** the binding compare moves INTO the per-request cache adapter's `getAsync`, the first
  point at which the library has parsed the response's `InResponseTo` and BEFORE any consumption:
  `getAsync` peeks the record, and when the presented binding cookie is absent or does not match the
  record's `binding`, it sets a per-request `bindingRefused` flag and returns `null` WITHOUT
  consuming. `removeAsync` returns `null` without consuming while that flag is set — this is
  load-bearing, because node-saml calls `removeAsync` on its failure path (5.1.0 `lib/saml.js:628`,
  its `catch`) and again just before throwing on an unmatched `InResponseTo` (`:803`, `:814`), which
  is how the foreign post consumed the victim's request. A refused `getAsync` makes the library
  THROW, so control reaches the `catch` at `routes.ts:389-396`, which today answers
  `assertion-invalid`: that branch reads `bindingRefused` FIRST and answers `state-invalid` (the
  code the case already uses) when it is set, and `assertion-invalid` otherwise. The post-validation
  compare at `:414-419` stays as the backstop for a library that never called `getAsync`.
- **Why here and not by parsing the response ourselves:** the request id is inside the signed XML;
  reading it before verification is safe ONLY as a lookup key for a read-and-compare that consumes
  nothing — which is exactly what `getAsync` + `peekRequest` is — and reusing the library's parse
  means no second XML reader. Whatever node-saml's internal order of InResponseTo-vs-signature
  checks is, the design is safe: a peek refuses without consuming, and a match proceeds to every
  existing check unchanged. The order is still READ from the installed library's `lib/saml.js`
  during implementation and recorded in the adapter's comment.
- **Test home:** `saml-acs.test.ts` gains "a foreign browser's post does not consume the victim's
  request": foreign post first → `state-invalid`; THEN the originating browser's post of the same
  response → `302` signed in. **Negative control:** with the flag removed the second post answers
  `assertion-invalid` (the register's reproduction). The concurrent-post case (`:273`) stays and
  must still admit exactly one.

### 3.7 Clock and state rules carried through

- **Decision:** no `Date.now()` anywhere (the bridge takes `now` from nothing — it has no clock
  need; the SAML change reuses `deps.runtime.now()`); every new `ctx.state` key is a `common`
  constant following `<owner>:<kebab>` (`test/state-key-convention.test.ts`).
- **Test home:** the forbidden-construct grep in §7 and the existing state-key convention test.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                            | Kind                 | Consumer / real code path that READS it                                                                                                   |
| ------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_STATE_KEY` (`common`)             | const                | `session-plugin` middleware writes it (`session-middleware.ts:66`); `multi-tenancy-plugin` tenant middleware reads it (§3.1)              |
| `SESSION_TENANT_BINDING_KEY` (`common`)    | const                | `tenantBindingMismatch` and `session-plugin`'s seal                                                                                       |
| `tenantBindingMismatch` (`common`)         | fn                   | both compare sites (§3.1)                                                                                                                 |
| `ITenantDataStore` (`common`)              | type                 | `multi-tenancy-plugin` (option, service, memory store), `database-plugin` (`DatabaseTenantDataStore implements`)                          |
| `ITenantIsolationStrategy` (`common`)      | type                 | `ITenantDataStore.useIsolation`, the three strategy classes, `DatabaseTenantDataStore.useIsolation`                                       |
| `createDatabaseTenantDataStore` (database) | fn → RegistryFactory | the application's `MultiTenancyPlugin({ dataStore })`; resolved by the plugin at `onInit`                                                 |
| `DatabaseTenantDataStore` (database)       | class                | returned by the factory; exported so an application holding its own `IDatabaseService` (a test, a `custom` arm) can construct it directly |
| `TenantStoreStrategyUnsupportedError`      | class                | thrown by `useIsolation` for non-`column` kinds; `instanceof` for an application catching startup errors                                  |
| `TenantDataStoreNotReadyError` (tenancy)   | class                | thrown by the late-binding slot before `onInit`                                                                                           |
| `CsrfOptions.exclude` (http-security)      | option field         | `csrfMiddleware` (§3.5)                                                                                                                   |

`session-plugin/src/index.ts`, `auth-plugin/src/index.ts` and `http-security-plugin/src/index.ts`
are otherwise unchanged; `multi-tenancy-plugin/src/index.ts` re-exports the two promoted types and
adds the one error. Each changed barrel's `barrel-exports.test.ts` is extended (the M56 class).

### 4.1 Options — every option names its consumer

| Option                                       | Consumer                                                     | Behavior (per implementation)                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionPluginOptions.tenantBinding`         | `sessionMiddleware`; unchanged consumer                      | unchanged meaning; the compare now also runs on the tenant side when that side resolves second                                         |
| `MultiTenancyPluginOptions.dataStore`        | `register()` (instance) / `onInit` (factory) via `bindStore` | instance: today's path; factory: resolved once at `onInit`, then validated and handed the strategy                                     |
| `createDatabaseTenantDataStore.tenantColumn` | `DatabaseTenantDataStore`                                    | column name stamped on every write and conjoined to every read; a `column` strategy naming a different column throws at `useIsolation` |
| `CsrfOptions.exclude`                        | `csrfMiddleware`                                             | paths matched by literal or `RegExp` skip the CSRF check entirely; default `[]`                                                        |

## 5. Implementation files

| File                                                                                                                                                                                              | Purpose                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/state-keys.ts`                                                                                                                                                               | `SESSION_STATE_KEY` constant (the table row already exists)                                                                                                                                                  |
| `packages/common/src/services/session.ts`                                                                                                                                                         | `SESSION_TENANT_BINDING_KEY` + `tenantBindingMismatch`                                                                                                                                                       |
| `packages/common/src/services/tenancy.ts`                                                                                                                                                         | `ITenantDataStore`, `ITenantIsolationStrategy` (moved in)                                                                                                                                                    |
| `packages/common/src/index.ts`                                                                                                                                                                    | barrel: the five new symbols                                                                                                                                                                                 |
| `packages/session-plugin/src/services/session-tenant-binding.ts`                                                                                                                                  | re-exports the `common` key; `readTenantBinding`/`sealTenantBinding` call the shared helper's key                                                                                                            |
| `packages/session-plugin/src/services/session-service.ts`                                                                                                                                         | imports `SESSION_STATE_KEY` from `common`                                                                                                                                                                    |
| `packages/session-plugin/src/middleware/session-middleware.ts`                                                                                                                                    | compare through `tenantBindingMismatch`; the seal runs only for an unbound session (§3.1); JSDoc gains the two-sided rule                                                                                    |
| `packages/multi-tenancy-plugin/src/interfaces/index.ts`                                                                                                                                           | `dataStore` widened; the two ports become re-exports of `common`                                                                                                                                             |
| `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts`                                                                                                                               | tenant-side compare after `replaceTenant`                                                                                                                                                                    |
| `packages/multi-tenancy-plugin/src/services/multi-tenancy-service.ts`                                                                                                                             | late-binding store slot; `TenantDataStoreNotReadyError`                                                                                                                                                      |
| `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts`                                                                                                                                | `bindStore`; `onInit` factory resolution; warning condition; health `store` field                                                                                                                            |
| `packages/multi-tenancy-plugin/src/errors.ts`                                                                                                                                                     | `TenantDataStoreNotReadyError`                                                                                                                                                                               |
| `packages/multi-tenancy-plugin/src/index.ts`                                                                                                                                                      | barrel                                                                                                                                                                                                       |
| `packages/database-plugin/src/tenancy/database-tenant-data-store.ts`                                                                                                                              | `DatabaseTenantDataStore`, `createDatabaseTenantDataStore`, `TenantStoreStrategyUnsupportedError`                                                                                                            |
| `packages/database-plugin/src/index.ts`                                                                                                                                                           | barrel                                                                                                                                                                                                       |
| `packages/http-security-plugin/src/middleware/csrf-middleware.ts`                                                                                                                                 | `exclude` option + first-position check                                                                                                                                                                      |
| `packages/auth-plugin/src/saml/routes.ts`                                                                                                                                                         | binding check inside `getAsync`; `removeAsync` guarded by the flag                                                                                                                                           |
| `packages/session-plugin/README.md`, `packages/multi-tenancy-plugin/README.md`, `packages/database-plugin/README.md`, `packages/http-security-plugin/README.md`, `packages/auth-plugin/README.md` | the §2 deliverables                                                                                                                                                                                          |
| `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`                                                                                                                                              | contract notes (§2); `Unreleased` entries; the C5 recipe change under the upgrade guide's `## Unreleased` heading — none exists yet, so whichever of M101c/M101d lands first adds it and the other reuses it |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                | src covered                                                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/session-tenant-binding.test.ts` (new)                         | `services/session.ts` additions, `state-keys.ts`                      | `tenantBindingMismatch(session, id)` over a minimal `ISession`: unbound → `false`; no tenant → `false`; equal → `false`; differ → `true`; both key constants follow the state-key convention                                                                                                   |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                            | `src/index.ts`, `services/tenancy.ts`                                 | the five new symbols are exported; `services/tenancy.ts` is type-only, so its coverage is the compile-time assignment of a fixture to `ITenantDataStore` and `ITenantIsolationStrategy` declared against the barrel                                                                            |
| `packages/session-plugin/test/unit/services/session-service.test.ts` (extended)          | `services/session-service.ts`                                         | the import-only change keeps every existing case green; the state key it writes is asserted equal to `common`'s `SESSION_STATE_KEY`                                                                                                                                                            |
| `packages/multi-tenancy-plugin/test/unit/errors.test.ts` (extended)                      | `errors.ts`                                                           | `TenantDataStoreNotReadyError` carries its `name`, a message naming `onInit` and the factory arm, and is `instanceof Error`                                                                                                                                                                    |
| `packages/session-plugin/test/unit/middleware/session-middleware.test.ts` (extended)     | `middleware/session-middleware.ts`                                    | load-time compare unchanged; a tenant stamped by a downstream middleware is sealed at commit on an unbound session; a bound session whose tenant changes downstream is not rebound                                                                                                             |
| `packages/session-plugin/test/unit/session-tenant-binding.test.ts` (extended)            | `services/session-tenant-binding.ts`                                  | the key is `common`'s constant, byte-identical                                                                                                                                                                                                                                                 |
| `packages/session-plugin/test/unit/barrel-exports.test.ts`                               | `src/index.ts`                                                        | unchanged surface                                                                                                                                                                                                                                                                              |
| `packages/multi-tenancy-plugin/test/unit/tenant-middleware.test.ts` (extended)           | `middleware/tenant-middleware.ts`                                     | with a session in `ctx.state` bound to `a` and a resolver answering `b`: `403`, `next` not called, body through `respondWithError`; no session in state → unchanged; equal → unchanged                                                                                                         |
| `packages/multi-tenancy-plugin/test/integration/tenant-binding-order.test.ts` (new)      | `tenant-middleware.ts`, `plugin/multi-tenancy-plugin.ts`              | §3.1 kernel scenario at priority 310 and the default-order control; `SessionPlugin({ secret })` real, `createApplication` + `inject()`                                                                                                                                                         |
| `packages/multi-tenancy-plugin/test/unit/multi-tenancy-service.test.ts` (extended)       | `services/multi-tenancy-service.ts`                                   | `getRepositoryFor` before binding throws `TenantDataStoreNotReadyError`; after binding delegates                                                                                                                                                                                               |
| `packages/multi-tenancy-plugin/test/unit/multi-tenancy-plugin.test.ts` (extended)        | `plugin/multi-tenancy-plugin.ts`                                      | factory arm resolved at `onInit` with `resolveRegistryEntry`'s label; instance arm unchanged; X18-5 warning does NOT fire for a factory; health `store: 'factory'` → `'custom'`; `assertUsableStore` runs on the resolved store                                                                |
| `packages/multi-tenancy-plugin/test/integration/database-bridge.test.ts` (new)           | `plugin/multi-tenancy-plugin.ts`, `services/multi-tenancy-service.ts` | §3.3 real kernel app over `DatabasePlugin({ type: 'memory' })`; write under `a`, read back under `a`, invisible under `b`; the three negative controls                                                                                                                                         |
| `packages/multi-tenancy-plugin/test/unit/barrel-exports.test.ts` (extended)              | `src/index.ts`                                                        | re-exported port types + the new error                                                                                                                                                                                                                                                         |
| `packages/database-plugin/test/unit/database-tenant-data-store.test.ts` (new)            | `tenancy/database-tenant-data-store.ts`                               | every method's translated `IRepository` call (`findAll({ where })`, `findOne`, `create`, `update`, `delete` signatures from §1); tenant column spread LAST; strip-on-update; the §3.4 strategy table; `tenantColumn` vs strategy disagreement throws; factory resolves `CAPABILITIES.DATABASE` |
| `packages/database-plugin/test/integration/tenant-store-memory-adapter.test.ts` (new)    | `tenancy/database-tenant-data-store.ts`                               | REAL `DatabaseService` + `MemoryAdapter`: isolation read back through the same API                                                                                                                                                                                                             |
| `packages/database-plugin/test/unit/barrel-exports.test.ts` (extended)                   | `src/index.ts`                                                        | the three new exports                                                                                                                                                                                                                                                                          |
| `packages/http-security-plugin/test/unit/csrf-middleware.test.ts` (extended)             | `middleware/csrf-middleware.ts`                                       | §3.5 cases; `exclude: []` byte-identical to today; `RegExp` with `g` flag matches twice in a row (the `lastIndex` trap `createPathMatcher` owns)                                                                                                                                               |
| `packages/http-security-plugin/test/unit/barrel-exports.test.ts`                         | `src/index.ts`                                                        | unchanged surface                                                                                                                                                                                                                                                                              |
| `packages/auth-plugin/test/integration/saml-csrf-composition.test.ts` (extended)         | docs recipe (no auth `src`)                                           | fourth cell: documented recipe under `Origin: null` signs in; the old recipe under `Origin: null` is `403`                                                                                                                                                                                     |
| `packages/auth-plugin/test/integration/saml-acs.test.ts` (extended)                      | `saml/routes.ts`                                                      | §3.6 victim-still-signs-in case; foreign post with NO cookie also leaves the request intact; concurrent-post case still admits exactly one                                                                                                                                                     |
| `packages/auth-plugin/test/e2e/keycloak-saml-real.test.ts` (extended, `ignore:`-guarded) | `saml/routes.ts`                                                      | against the real Keycloak CI already starts (M100b/M100f): the documented recipe with `HttpSecurityPlugin` and the ACS excluded signs in through a real `Origin: null` post, captured from a headless browser where the harness has one, else synthesised                                      |

Per-file bar: `csrf-middleware.ts`, `tenant-middleware.ts` and `session-middleware.ts` are small and
fully driven by the unit files; `database-tenant-data-store.ts` is new and must land at 100% (every
method has a present and an absent arm, and the strategy table covers `useIsolation`).
`saml/routes.ts` gains two branches (`bindingRefused` set / not set in `removeAsync`), both driven
by the new ACS case.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101c-identity-composition, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # README fence counts, export-table drift, upgrade-guide attribution
deno task publish:check     # committed tree
deno task release:verify 0.8.0
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/common/src packages/session-plugin/src packages/multi-tenancy-plugin/src packages/database-plugin/src packages/http-security-plugin/src packages/auth-plugin/src
```

Plus the negative controls, each observed failing and reverted: §3.1 (tenant-side compare removed),
§3.3 (1)–(3), §3.5 (`exclude` removed → the fourth composition cell is `403`), §3.6
(`bindingRefused` removed → the victim's post is `assertion-invalid`).

## 8. Risks & mitigations

- Moving `ITenantDataStore` into `common` changes its declaration site → the plugin keeps a type
  re-export so no import breaks; `deno doc --lint` is re-run so `private-type-ref` does not rise
  (M38 ratchet).
- The tenant-side compare reads a `ctx.state` key written by another package → the key is a `common`
  constant and `test/state-key-convention.test.ts` already refuses a literal.
- A factory `dataStore` means repository calls are impossible before `onInit` → the named
  `TenantDataStoreNotReadyError` makes a `register()`-time call fail loudly, and the HTTP path
  cannot observe it.
- `findOne`-then-`update` in the bridge is two calls → acceptable because the tenant column is
  stripped from every update payload, so no write can move a row between tenants; documented in the
  class JSDoc.
- The Keycloak e2e needs a real `Origin: null` → CI already runs Keycloak (M100b); if no headless
  browser is available the header is synthesised, and the unit-level fourth cell carries the exact
  reproduction regardless.
- Dependencies: none on other letters; M101h rebases its multi-tenancy options-table rows on this
  letter's `dataStore` row.

## 9. Out of scope

- M101h: the five missing multi-tenancy option rows, the logger/telemetry tables, and every other
  doc gap in V8-43/V8-44.
- M101d: anything on the SDK, trace propagation or React Router.
- A `schema`/`database` isolation bridge over `database-plugin` — refused by name in §3.4 until
  `IRepository` can express a schema switch.
- Session `rotate`/`regenerate` interactions with the binding (M48, unchanged and already tested in
  `session-tenant-cross-write.test.ts`).
