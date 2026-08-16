# Milestone 70b — Tenant isolation and data exposure

> **Status:** Planning. Branch: `feat/m70b-tenant-isolation`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the six alpha.8 register rows in which the framework hands a caller data that belongs to
someone else, or refuses to work once tenancy is switched on. Five of the six are silent: the
application looks healthy, every gate is green, and the wrong bytes go out. The unifying shape is
that **a protection one plugin establishes is invisible to every other capability** — the tenancy
plugin resolves a tenant, and the cache key, the session, and the flag evaluator are all blind to
it. The sixth (X12-3) is the same class one level down: the error handler discloses to the client a
string the developer intended for the log.

Every fix in this milestone is **inert for an application that does not use the feature it
protects**. A single-tenant app's cache keys stay byte-identical, its sessions bind nothing, and its
flag evaluation is unchanged. That property is load-bearing, not a nicety: it is what lets these
land as defect repairs rather than as a migration, and each one has a named test pinning it.

- **In scope:** X4-1 (cross-tenant cache disclosure), X4-2 (`required: true` breaks operational
  probes), X4-3 (a session is not bound to its tenant), X4-6 (feature flags have no tenant
  dimension), X12-1 (Prisma `contains` treats `%`/`_` as wildcards), X12-3 (every 500 discloses the
  failing SQL and its bound parameters). Packages: `cache-plugin`, `multi-tenancy-plugin`,
  `session-plugin`, `feature-flags-plugin`, `database-plugin`, `exceptions`, `common`.
- **NOT this milestone:** X4-8 — a short-circuiting middleware emits `{error, message}` rather than
  the configured RFC 9457 body. Owned by **M70f** (error format and error visibility), which takes
  the kernel's own 404/500 in the same sweep. This milestone adds one new short-circuit (the tenant
  mismatch in §3.3) and deliberately gives it the same non-conforming shape as the existing tenant
  rejection beside it, so M70f converts one pattern in one place rather than two. X11-2 (nothing is
  logged without `errorHandler`) is also M70f's; §3.6 depends on the log path that already exists
  and does not widen it. X4-7 (audit read surface) and the remaining X4/X12 rows belong to M70c,
  M70f and M70j per the ROADMAP workstream split.

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                                                                                                                       | Verified surface / fact                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRequest.tenant`                       | `packages/common/src/http.ts:53`                                                                                                                         | `tenant?: ITenant` — already committed in `common`, mutable, populated by the tenancy middleware. **No `common` widening is needed for X4-1.**                                           |
| `ITenant`                               | `packages/common/src/services/tenancy.ts:14-21`                                                                                                          | `{ readonly id: string; readonly name?: string; readonly metadata?: Readonly<Record<string, unknown>> }`. `id` is the only guaranteed member.                                            |
| `IRequest.path`                         | `packages/common/src/http.ts:38`                                                                                                                         | `readonly path: string` — "URL path component (no query string)". This is what §3.2's exclusion matches against; no parsing of `url` is required.                                        |
| `defaultCacheKey`                       | `packages/cache-plugin/src/utils/cache-key.ts:23`                                                                                                        | Returns a template of `request.method`, a colon, and `request.url` — method and URL only. No headers, no `Vary`, no tenant.                                                              |
| `CacheMiddlewareOptions`                | `packages/cache-plugin/src/interfaces/index.ts:94-118`                                                                                                   | Exactly `ttlSeconds`, `key`, `bypass`, `store`, `cacheableStatuses`. No `vary`, no tenant awareness.                                                                                     |
| `cacheMiddleware` key call              | `packages/cache-plugin/src/middleware/cache-middleware.ts:57`                                                                                            | `const key = keyFn !== undefined ? keyFn(ctx) : defaultCacheKey(ctx)` — a single site, which is where §3.1's wrapper goes.                                                               |
| `TENANT_CACHE_PREFIX_STATE_KEY`         | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:20`                                                                                   | Exported state key + `getTenantCachePrefix` accessor. `grep` confirms **no reader outside the plugin that writes it** — the advertised isolation is a string nothing consumes.           |
| `tenantMiddleware` rejection            | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:107-113`                                                                              | `required` short-circuits with `status(rejectionStatus).json({ error, message })` before `next()`, unconditionally for every path.                                                       |
| `MultiTenancyPluginOptions`             | `packages/multi-tenancy-plugin/src/interfaces/index.ts:90-123`                                                                                           | `resolver`, four resolver option bags, `database`, `dataStore`, `cache`, `required`, `rejectionStatus`, `middlewarePriority`. **No path exemption of any kind.**                         |
| `ISession`                              | `packages/common/src/services/session.ts:40-113`                                                                                                         | `id`, `get`, `set`, `has`, `delete`, `clear`, `regenerate`, `destroy`, `toJSON`. `SessionData = Record<string, unknown>` (:23) — a reserved key needs no `common` change.                |
| `SessionPluginOptions`                  | `packages/session-plugin/src/options.ts:75-135`                                                                                                          | `secret`, `secretName`, `mode`, `store`, `maxAge`, `rolling`, `idleTimeoutMs`, `maxCookieBytes`, `cookie`, `csrf`. No tenant awareness.                                                  |
| `ErrorHandlerOptions`                   | `packages/exceptions/src/middleware/error-handler.ts:41-60`                                                                                              | Exactly `format`, `includeStackTrace`, `logErrors`. **Nothing masks the message.**                                                                                                       |
| `errorHandler` normalization            | `packages/exceptions/src/middleware/error-handler.ts:117-120`                                                                                            | A non-`HttpError` becomes `internalServerError(rawError.message, rawError)` — the raw message becomes `detail` and reaches the client.                                                   |
| `internalServerError`                   | `packages/exceptions/src/errors/exceptions.ts:174-176`                                                                                                   | `new HttpError(500, message, undefined, cause)` — no `details`, cause preserved. So masking may rebuild the response error without losing the log's cause chain.                         |
| `HttpError`                             | `packages/exceptions/src/errors/http-error.ts:71-116`                                                                                                    | `statusCode`, optional `details` (declared, assigned only when supplied), ES2022 `cause`. `instanceof HttpError` is the discriminator §3.6 branches on.                                  |
| `prismaFilter` `contains` arm           | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:406`                                                                                     | `return { [filter.field]: { contains: filter.value } }` — value passed through unescaped.                                                                                                |
| Drizzle `contains` arm                  | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:599-608`                                                                               | Escapes via `escapeLikePattern` and emits `like … escape '\\'`, under a comment stating SQLite defines no default escape character. This is the M68 fix, and the duplicate §3.5 removes. |
| `FlagContext`                           | `packages/common/src/services/feature-flags.ts:13-25`                                                                                                    | `{ userId?, attributes? }`; JSDoc states `attributes` is carried but **not read** by the built-in path.                                                                                  |
| `FlagDefinition`                        | `packages/feature-flags-plugin/src/interfaces/index.ts:17-24`                                                                                            | `{ enabled, percentage?, users? }`. Lives in the **plugin**, not `common`, so a `tenants` field is not a `common` change.                                                                |
| `evaluateFlag` precedence               | `packages/feature-flags-plugin/src/evaluation/flag-evaluator.ts:67-108`                                                                                  | unknown → `false`; `users` allowlist (overrides `enabled: false`); `enabled: false`; `percentage` (no `userId` → `false`); default `true`.                                               |
| `createFlagGuard` context build         | `packages/feature-flags-plugin/src/middleware/feature-flag-middleware.ts:44-52`                                                                          | Builds `FlagContext` from `options.context` else `ctx.request.user?.id`. It holds `ctx`, so it is the site that can supply `tenantId` — see §3.4.                                        |
| `Symbol.for` cross-copy precedent       | `packages/common/src/http.ts:395-429`                                                                                                                    | `SECURITY_METADATA` (M57) and `UPGRADE_INTENT` (M70a) both use `Symbol.for`. Cited only as the precedent §3.1 **declines** — no new symbol is needed.                                    |
| Operational endpoint defaults           | `health-plugin/src/plugin/health-plugin.ts:53-54`, `metrics-plugin/src/plugin/metrics-plugin.ts:36`, `openapi-plugin/src/plugin/openapi-plugin.ts:86-87` | `/live`, `/ready`, `/health` (health), `/metrics`, `/docs`, `/openapi.json`. These six are §3.2's default exclusion list, read from source rather than from the register.                |
| No plugin imports `@setu-ts/exceptions` | `grep -rln '@setu-ts/exceptions' packages/*/src`                                                                                                         | Hits are `exceptions` itself, two `cli` template **strings**, and one `validation-plugin` **comment**. So §3.3 cannot throw an `HttpError`; it short-circuits like its neighbour.        |

### 1.1 External fact established by probe, not by memory

The X12-1 fix hinges on which character terminates a `LIKE` pattern for a Prisma-issued query, and
that is **connector-dependent**. Prisma Client exposes no `ESCAPE` option, so the effective escape
character is whatever the target database defaults to. This was measured against real Prisma
**7.9.1** with `@prisma/adapter-better-sqlite3`, seeding `50% off bracket`, `Bolt M6`, `Nut M6`,
`back\slash`:

```
SQL emitted: SELECT … WHERE `main`.`Product`.`name` LIKE ('%' || ? || '%') LIMIT ? OFFSET ?
  contains "%"    -> 4 rows (the whole table)
  contains "%off" -> 1 row  ['50% off bracket']   (matches as a pattern; not a literal substring)
  contains "Bol_" -> 1 row  ['Bolt M6']
  contains "\\%"  -> 1 row  ['back\slash']        <-- the backslash matched LITERALLY
```

**No `ESCAPE` clause is emitted, and SQLite defines no default escape character**, so on SQLite a
pre-escaped `\%` searches for a backslash rather than for a literal percent. The register's
PostgreSQL measurement is the opposite — there `\%` returned `['50% off bracket']`, because
PostgreSQL's `LIKE` defaults its escape to backslash.

This kills the obvious fix. **Copying the Drizzle escape unconditionally would repair PostgreSQL and
MySQL while giving SQLite a different wrong answer**, which is why §3.5 is connector-aware and
refuses rather than guesses. The probe script is scratch and is not committed; §6 re-establishes the
same fact inside the suite with a fake client, and §7.1 re-runs it against real Prisma.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                      | Doc deliverable (same PR)                                                                                                                                    |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `PUBLIC_API.md:4370` lists "cache-key isolation" among what the multi-tenancy plugin provides. Verified from source: the prefix is stamped into `ctx.state` and **no package reads it**. The document describes a capability that does not exist.                           | Make the claim true rather than delete it (§3.1). The shipped cache middleware becomes tenant-aware, so `PUBLIC_API.md` keeps the phrase and gains the mechanism beside it.                   | `PUBLIC_API.md` Multi-Tenancy summary states the isolation is applied by `cacheMiddleware` reading `ctx.request.tenant`, not by the `cache.prefix` string.   |
| C2 | `packages/database-plugin/README.md:175` promises "`%` and `_` in the searched value are always data, never wildcards" for **all four** adapters. False for Prisma on every connector, and unachievable for Prisma on SQLite (§1.1).                                        | Repair three connectors and state the SQLite limit explicitly rather than keep an unqualified promise.                                                                                        | README `contains` paragraph rewritten with the per-connector position; `PUBLIC_API.md` Database section gains the same caveat and the `provider` option row. |
| C3 | The ROADMAP M70b row names packages `(cache-plugin, multi-tenancy-plugin, session-plugin, database-plugin, exceptions)` but its own body assigns X4-6, whose register row names `feature-flags-plugin` and `common`. The list is incomplete.                                | Correct the ROADMAP row's package list to include `feature-flags-plugin` and `common`. This mirrors M70h, whose row was corrected the same way at plan time.                                  | ROADMAP M70b package list corrected; the row records the correction, as M70h's does.                                                                         |
| C4 | The register's X12-3 row names `exceptions` **and `cli`**, on the reasoning that the CLI templates emit the leaking middleware. Verified: the templates emit `errorHandler({ format: 'rfc9457' })` and pass no masking option.                                              | A safe **default** fixes every already-scaffolded project with no template edit and no regeneration, so `cli` is not touched (§3.6). The ROADMAP row's `cli`-free list is correct as written. | ROADMAP M70b row records that X12-3 closes without a `cli` change and why; CHANGELOG carries the behaviour change.                                           |
| C5 | `ErrorHandlerOptions.includeStackTrace` JSDoc (`error-handler.ts:48-52`) says "**Never** enable this in production", implying the stack is the sensitive part of an unhandled error. The message beside it — which carries the SQL and its bound parameters — is unguarded. | The message is the disclosure; the stack is secondary. Correct the JSDoc to say so and cross-reference `maskInternalErrors`.                                                                  | `includeStackTrace` JSDoc corrected; `PUBLIC_API.md` Exceptions options table gains `maskInternalErrors` and the corrected `includeStackTrace` text.         |

## 3. Design decisions

### 3.1 Cross-tenant cache disclosure (X4-1) — the key reads `ctx.request.tenant`, not a state key

- **Decision:** `cacheMiddleware` composes the cache key as
  `tenantSegment(ctx) + varySegment(ctx) + baseKey(ctx)`, where `baseKey` is the caller's `key`
  function when supplied and `defaultCacheKey` otherwise. `tenantSegment` reads
  `ctx.request.tenant?.id` — the field committed in `common` at `http.ts:53` — and is the empty
  string when absent. A new `vary?: (ctx: IRequestContext) => readonly string[]` option supplies any
  further discriminator. **No new `common` surface, no state key, no plugin-to-plugin import.**
- **Why:** the register's first-choice fix was to promote `multi-tenancy-plugin`'s state key into
  `common` on the `SECURITY_METADATA` precedent. Reading the source shows that is unnecessary:
  `IRequest.tenant` is _already_ the committed cross-package channel, it is _already_ what
  `tenantMiddleware` writes (`tenant-middleware.ts:95`), and every other consumer of tenancy reads
  it. Promoting a second channel for the same fact would give one datum two homes. Declining the
  precedent is the decision, and it is why this row costs no widening.
- **The tenant segment is length-prefixed** — `t:<id.length>:<id>|` — not merely concatenated.
  Tenant ids arrive from a header, a subdomain, a path segment or a JWT claim, so at least one
  resolver puts caller-influenced text into the key; a bare `acme|GET:/x` is forgeable by a tenant
  literally named `acme|GET:/x`. The length prefix makes the boundary unambiguous for any id.
- **The segment is applied around a custom `key` too**, not only around the default. A caller who
  supplies `key` in a tenant application would otherwise reproduce exactly the defect being fixed,
  silently, and §13.4 puts the secure choice in the default path. The cost is that an application
  deliberately sharing one cache entry across tenants now stores one entry per tenant — wasteful and
  **correct**, which is the right direction for the trade; no opt-out option is added, because its
  only honest consumer is a case no in-repo code has, and §4 forbids surface a real path does not
  read.
- **Fail-safe:** with no tenancy plugin registered, `ctx.request.tenant` is `undefined`, the segment
  is empty, and the key is byte-identical to today.
- **Test home:** `test/unit/cache-key.test.ts` (segment composition, length prefix, forged-id case,
  byte-identity with no tenant), and `test/integration/tenant-cache-isolation.test.ts` — a real
  kernel app registering both plugins, where `acme` and `globex` request one route and each receives
  its own body. That integration test is the one that would have caught the defect, and neither
  package's existing suite can host it.

### 3.2 `required: true` breaks operational probes (X4-2) — a default path exemption

- **Decision:** `MultiTenancyPluginOptions.exclude?: readonly (string | RegExp)[]`, matched against
  `ctx.request.path` (exact string equality, or `RegExp.test`). Default when the option is omitted:
  `['/live', '/ready', '/health', '/metrics', '/openapi.json', '/docs']` — the six read from the
  three plugins' own defaults in §1, not copied from the register. A matching path skips the
  middleware body entirely: no resolution, no stamping, no rejection, straight to `next()`.
- **Why skip the whole body rather than only the requirement:** a probe has no tenant to resolve, so
  running the resolver chain for it can only produce a wasted lookup and, with the JWT resolver, a
  spurious warning. Skipping is also the only variant a reader can predict from the option's name.
- **Why a default rather than an empty default:** the failure is that M39's generated Kubernetes
  manifests point liveness and readiness at `/live` and `/ready` and send no headers, so a
  required-tenant deployment never becomes ready. An opt-in exemption leaves that broken for
  everyone who does not read the note. `exclude: []` restores the current behaviour exactly, and
  that is the documented escape for an application whose own routes sit on those paths.
- **Test home:** `test/unit/tenant-middleware.test.ts` (default list, custom string, custom RegExp,
  `[]` restoring rejection, non-excluded path still 400) and
  `test/integration/required-tenant-probes.test.ts` — a kernel app with `required: true` plus
  `HealthPlugin`, asserting `/live` and `/ready` answer `200` with no header while a business route
  still answers the rejection status.

### 3.3 A session is not bound to its tenant (X4-3) — bind on commit, compare on read

- **Decision:** `SessionPluginOptions.tenantBinding?: boolean`, **default `true`**. When the session
  commits and `ctx.request.tenant?.id` is present, the id is sealed into the session payload under
  the reserved key `__setu_tenant`. On a later request, when the session carries a bound tenant
  **and** the request resolves a tenant, a mismatch short-circuits with `403` before the handler
  runs. When one of the two is absent, nothing is compared.
- **Why the default is `true` and is still not a behaviour change for anyone else:** binding only
  ever happens when a tenant is resolved, so an application with no tenancy plugin never writes the
  key, never has one to compare, and is inert. The only application whose behaviour changes is one
  where a session minted under tenant A is presented under tenant B — which is precisely the
  cross-tenant write the row records, CSRF token included. Making that opt-in would leave the
  documented composition of two first-class capabilities exploitable by default.
- **Reserved key, not a `common` widening:** `SessionData` is `Record<string, unknown>`
  (`session.ts:23`), so the binding is ordinary session data. `ISession` gains no member. The key is
  documented as reserved; `clear()` and `regenerate()` drop it and the next commit re-binds, which
  is correct — a regenerated session is a new session and should adopt the current tenant.
- **The mismatch response is a `ctx.response.status(403).json({ error, message })` short-circuit**,
  deliberately the same non-conforming shape as the tenant rejection it sits beside
  (`tenant-middleware.ts:107`). No plugin may import `@setu-ts/exceptions` (§1, verified), so an
  `HttpError` is unavailable, and inventing a third body shape here would give M70f three patterns
  to converge instead of two. This is a deferral with a named owner, not an oversight.
- **Test home:** `test/unit/session-tenant-binding.test.ts` (binds on commit, no bind without a
  tenant, match passes, mismatch 403, `tenantBinding: false` restores the old behaviour, `clear()`
  re-binds) and `test/integration/session-tenant-cross-write.test.ts` — the register's reproduction
  driven through a kernel app: sign in under `acme`, replay the cookie with `globex`, assert `403`
  and assert the write did **not** land.

### 3.4 Feature flags have no tenant dimension (X4-6) — a scoping field, not a second allowlist

- **Decision:** three additions. `FlagContext.tenantId?: string` in `common` (optional, so
  source-compatible for every caller and every implementor).
  `FlagDefinition.tenants?: readonly
  string[]` in the plugin. And `evaluateFlag` gains one rule,
  ahead of every existing rule: **if `tenants` is present and the context's `tenantId` is not in it,
  the flag is `false`.** If the tenant matches, or `tenants` is absent, evaluation continues through
  the committed precedence unchanged.
- **Why a restriction rather than an allowlist:** `users` grants (it overrides `enabled: false`).
  Modelling `tenants` the same way would let a user allowlist cross a tenant boundary, which in a
  milestone about tenant isolation is the wrong direction. As a restriction it composes cleanly —
  "this flag exists for these tenants, and within them the existing user and percentage rules apply"
  — and it is inert when absent, so no committed evaluation changes.
- **`createFlagGuard` populates `tenantId` from `ctx.request.tenant?.id`** when the caller supplies
  no explicit `context`, mirroring how it already derives `userId` from `ctx.request.user?.id`
  (`feature-flag-middleware.ts:48-52`). This is the wiring that matters: the register's finding is
  that the documented call shape silently evaluates `false` for every tenant, and the guard is the
  one site holding both the flag service and the request.
- **`IFlagStore` is NOT reshaped.** The register's fix suggested per-tenant definitions from the
  store. That changes a published port for every provider and every custom store to buy something
  the `tenants` field already expresses. Named in §9.
- **Test home:** `test/unit/flag-evaluator.test.ts` (absent `tenants` unchanged; matching tenant
  falls through to `users`/`percentage`/`enabled`; non-matching tenant is `false` even with the user
  allowlisted and `enabled: true`; no `tenantId` against a scoped flag is `false`) and
  `test/unit/feature-flag-middleware.test.ts` (guard derives `tenantId`, explicit `context` still
  wins).

### 3.5 Prisma `contains` treats `%`/`_` as wildcards (X12-1) — escape where provable, refuse where not

- **Decision:** the Prisma `contains` arm escapes `\`, `%` and `_` through the **shared**
  `escapeLikePattern`, and which behaviour applies is decided by the connector:
  - `postgresql`, `postgres`, `mysql`, `sqlserver`, `cockroachdb` — escape. Their `LIKE` defaults
    the escape character to backslash, which §1.1's PostgreSQL measurement confirms end to end.
  - `sqlite` — **throw** `UnsupportedFilterOperatorError` from the translation, naming the operator,
    the connector, and the adapters that do support it. §1.1 proves Prisma emits no `ESCAPE` clause
    and SQLite defines no default, so a literal `contains` is not expressible through Prisma's
    filter API on SQLite. Returning wrong rows quietly is the defect; returning a named error is the
    repair.
  - connector not determined — throw the same error, naming the `provider` option as the fix.
- **How the connector is known:** `PrismaAdapterOptions.provider?: PrismaSqlProvider` is the
  explicit answer. When omitted, `connect()` reads the client's active provider structurally — a
  `{ _activeProvider?: unknown }` read narrowed with `typeof === 'string'`, never a cast to `any` —
  and stores it. Probed on Prisma 7.9.1: `_activeProvider === 'sqlite'` for the SQLite adapter. The
  field is underscore-prefixed and therefore not a stability promise, which is exactly why the
  explicit option exists and why an unrecognised value refuses rather than assumes.
- **The refusal is at translation time, not at `connect()`.** An application that never uses
  `contains` must not be blocked from starting because its connector could not be identified. This
  also matches the shape the repository already uses for a backend that cannot honour a contract
  (`LocalStorageProvider.getSignedUrl`, Kafka RPC).
- **`escapeLikePattern` moves out of `drizzle-adapter.ts` into a package-internal module and the
  duplicate is deleted** (§11.1). Both adapters live in `database-plugin`, so this is a shared
  internal utility, not a `common` promotion — and it removes a copy rather than creating the M30b
  `pemToDer` situation.
- **Breaking:** a Prisma+SQLite application using `contains` now throws where it previously returned
  wrong rows. CHANGELOG entry with migration text.
- **Test home:** `test/unit/prisma-adapter.test.ts` (each provider's translated `where`, asserted on
  the **escaped value** and not merely on the presence of `contains`; the SQLite throw; the
  unknown-provider throw; explicit `provider` overriding detection; structural detection from a fake
  client), plus `test/unit/like-escape.test.ts` for the extracted helper, plus the cross-adapter
  conformance test in §3.7.

### 3.6 Every 500 discloses the failing SQL and its parameters (X12-3) — mask by default

- **Decision:** `ErrorHandlerOptions.maskInternalErrors?: boolean`, **default `true`**. It applies
  to, and only to, a caught value that was **not** an `HttpError` and whose resulting status is
  `>= 500`. For those, the body's `detail` becomes the status title (`'Internal Server Error'`) and
  the raw message is dropped from the response. The **log is unaffected** — `logError` runs on the
  unmasked error, before the response error is built, so `logErrors: true` still records the SQL,
  the parameters and the cause chain.
- **Why a deliberately thrown `HttpError` is never masked:**
  `internalServerError('Payment gateway
  timed out')` is a message the developer chose for the
  client. `instanceof HttpError` is exactly the line between "the developer wrote this for a caller"
  and "this escaped from a driver", and it is already the discriminator at `error-handler.ts:117`.
  Masking the former would break a legitimate released pattern with no security benefit.
- **Why the default is `true` even though it is a behaviour change:** the framework already
  disagrees with itself — `graphql-plugin` ships `maskInternalErrors: true` by default and lists it
  under Security, so the same application masks an error behind `/graphql` and discloses the
  identical error behind a REST route. The name and the default are chosen to match it. A default of
  `false` would leave every already-scaffolded project leaking, since the CLI templates emit the
  middleware with no options bag.
- **This closes X12-3 with no `cli` change** (C4): every generated project picks the fix up by
  upgrading the package.
- **Breaking:** CHANGELOG entry with migration text; `maskInternalErrors: false` restores the
  previous body verbatim.
- **Test home:** `test/unit/error-handler.test.ts` — a thrown driver-shaped `Error` whose message
  contains a SQL statement and parameter values, asserting the response body **does not contain**
  them (the register's note is that the existing suite asserts what `detail` _is_ and never what it
  must not contain) while an injected logger **did** receive them; an `HttpError` 500 passing
  through unmasked; a 4xx unaffected; `maskInternalErrors: false` restoring the message; and one
  test driving both `format: 'rfc9457'` and the default format under `maskInternalErrors: true`, per
  the two-entry-points rule.

### 3.7 One query, every adapter — the conformance suite that would have caught X12-1

- **Decision:** add `test/unit/filter-conformance.test.ts` to `database-plugin`: a table of
  `FilterExpression` cases (including `%`, `_`, `\`, a bare `%`, and an empty `in`) run through
  **every** adapter's translation, asserting they agree on the answer or refuse explicitly. The
  Memory adapter evaluates rows directly, so it is the reference answer.
- **Why:** the register's third suggestion, and the durable one. Nothing in the suite currently runs
  one query against two backends and compares — `adapter-contract.test.ts` checks port conformance
  (M52c's concern), not answer conformance. Four of X12's steps would have failed this test.
- **Test home:** itself; it is the regression gate for §3.5 and the reason a future adapter cannot
  reintroduce the divergence.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                      | Kind  | Consumer / real code path that READS it                                                                                                                  |
| ---------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlagContext.tenantId` (`common`)                    | field | `evaluateFlag` (`flag-evaluator.ts`) reads it for the `tenants` rule; `createFlagGuard` writes it from `ctx.request.tenant?.id`.                         |
| `FlagDefinition.tenants` (`feature-flags`)           | field | `evaluateFlag`'s new first rule. Also read by the `ConfigProvider`/`MemoryProvider` round-trip tests through the real evaluator.                         |
| `UnsupportedFilterOperatorError` (`database-plugin`) | class | Thrown by the Prisma `contains` arm; caught/asserted by `prisma-adapter.test.ts` and `filter-conformance.test.ts`; documented for consumer `instanceof`. |
| `PrismaSqlProvider` (`database-plugin`)              | type  | The `provider` option's type; named in `PUBLIC_API.md` so an application can annotate its own config.                                                    |

No symbol is added to `cache-plugin`, `multi-tenancy-plugin`, `session-plugin` or `exceptions`
barrels — every change in those four is an **option field** on an already-exported options
interface, or internal. Checked: `vary`, `exclude`, `tenantBinding` and `maskInternalErrors` all
hang off types already exported and already documented in `PUBLIC_API.md`.

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                                                     | Behavior (per implementation)                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheMiddlewareOptions.vary`            | `cacheMiddleware` key composition (`cache-middleware.ts:57`) | Returned strings join the key after the tenant segment, each length-prefixed. Omitted → empty segment, key unchanged.                                                                        |
| `MultiTenancyPluginOptions.exclude`      | `tenantMiddleware` first statement                           | String → exact `ctx.request.path` equality; RegExp → `test`. Match → `next()` with no resolution. Omitted → the six operational defaults. `[]` → nothing excluded.                           |
| `SessionPluginOptions.tenantBinding`     | `sessionMiddleware` commit path and load path                | `true` (default) → seal `__setu_tenant` on commit when a tenant is resolved; compare on load; `403` on mismatch. `false` → neither seal nor compare.                                         |
| `ErrorHandlerOptions.maskInternalErrors` | `errorHandler` catch block, after `logError`                 | `true` (default) → non-`HttpError` with status ≥ 500 gets a generic `detail`. `false` → previous behaviour. Never applies to an `HttpError` or to a 4xx.                                     |
| `PrismaAdapterOptions.provider`          | `PrismaAdapter.connect()` and the `contains` arm             | Explicit connector. Omitted → structural detection from the client; undetermined → `contains` throws naming this option. Only `contains` reads it; no other operator is connector-sensitive. |

## 5. Implementation files

| File                                                                      | Purpose                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/cache-plugin/src/utils/cache-key.ts`                            | `defaultCacheKey` unchanged; add `tenantSegment`, `varySegment`, `composeCacheKey` (length-prefixed).    |
| `packages/cache-plugin/src/middleware/cache-middleware.ts`                | Key site calls `composeCacheKey` around the default or custom key function.                              |
| `packages/cache-plugin/src/interfaces/index.ts`                           | `CacheMiddlewareOptions.vary`.                                                                           |
| `packages/multi-tenancy-plugin/src/interfaces/index.ts`                   | `MultiTenancyPluginOptions.exclude`.                                                                     |
| `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts`       | Exclusion check + the default operational path list, hoisted to module scope (compiled once, §14).       |
| `packages/session-plugin/src/options.ts`                                  | `SessionPluginOptions.tenantBinding`; resolved into `ResolvedSessionConfig`.                             |
| `packages/session-plugin/src/middleware/session-middleware.ts`            | Bind on commit; compare on load; `403` short-circuit.                                                    |
| `packages/session-plugin/src/services/…` (binding helper)                 | Reserved-key read/write in one place, so commit and load cannot disagree about the key.                  |
| `packages/common/src/services/feature-flags.ts`                           | `FlagContext.tenantId`.                                                                                  |
| `packages/feature-flags-plugin/src/interfaces/index.ts`                   | `FlagDefinition.tenants`.                                                                                |
| `packages/feature-flags-plugin/src/evaluation/flag-evaluator.ts`          | The tenant-scope rule, ahead of the existing precedence.                                                 |
| `packages/feature-flags-plugin/src/middleware/feature-flag-middleware.ts` | Derive `tenantId` from `ctx.request.tenant?.id`.                                                         |
| `packages/database-plugin/src/query/like-escape.ts`                       | **New.** `escapeLikePattern`, moved out of the Drizzle adapter; the duplicate there is deleted.          |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`        | Import the shared helper; delete the local copy.                                                         |
| `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts`          | Connector resolution in `connect()`; escaping or refusal in the `contains` arm.                          |
| `packages/database-plugin/src/errors.ts`                                  | `UnsupportedFilterOperatorError`.                                                                        |
| `packages/database-plugin/src/index.ts`                                   | Barrel: `UnsupportedFilterOperatorError`, `PrismaSqlProvider`.                                           |
| `packages/exceptions/src/middleware/error-handler.ts`                     | `maskInternalErrors`; masked response error built after `logError`; `includeStackTrace` JSDoc corrected. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache-plugin/test/unit/cache-key.test.ts`                             | `utils/cache-key.ts`                               | `composeCacheKey(ctx)` — byte-identical to today with no tenant; tenant segment length-prefixed; a tenant id containing `\|` and a digit prefix cannot forge another tenant's key; `vary` strings appended in order.                                                                           |
| `cache-plugin/test/unit/cache-middleware.test.ts`                      | `middleware/cache-middleware.ts`                   | Custom `key` still receives the tenant segment; `bypass` unaffected; HIT/MISS paths keyed per tenant.                                                                                                                                                                                          |
| `cache-plugin/test/integration/tenant-cache-isolation.test.ts`         | both, in composition                               | Real `createApplication` with `MultiTenancyPlugin` + `CachePlugin`; `acme` then `globex` on one route; each gets its own body; reversing the order reverses nothing (both correct). Fails without the fix.                                                                                     |
| `multi-tenancy-plugin/test/unit/tenant-middleware.test.ts`             | `middleware/tenant-middleware.ts`                  | `tenantMiddleware({ options: { required: true, exclude } })` — default six paths pass; a non-excluded path still rejects; string and RegExp entries; `exclude: []` restores rejection on `/live`.                                                                                              |
| `multi-tenancy-plugin/test/integration/required-tenant-probes.test.ts` | plugin + middleware                                | Kernel app, `required: true`, `HealthPlugin` registered: `/live` and `/ready` are `200` with no header; a business route is `400`.                                                                                                                                                             |
| `session-plugin/test/unit/session-tenant-binding.test.ts`              | binding helper, `middleware/session-middleware.ts` | Seals only when a tenant is resolved; match passes; mismatch `403` and the handler never runs (short-circuit rule); `tenantBinding: false` inert; `clear()`/`regenerate()` re-bind on next commit.                                                                                             |
| `session-plugin/test/integration/session-tenant-cross-write.test.ts`   | session + tenancy in composition                   | The register's reproduction: `acme` cookie replayed with `globex` header is `403`, and the store shows **no** row written. Fails without the fix.                                                                                                                                              |
| `feature-flags-plugin/test/unit/flag-evaluator.test.ts`                | `evaluation/flag-evaluator.ts`                     | `evaluateFlag(flag, def, ctx)` — absent `tenants` byte-identical to committed precedence; non-matching tenant `false` even with `users` allowlisted and `enabled: true`; matching tenant falls through.                                                                                        |
| `feature-flags-plugin/test/unit/feature-flag-middleware.test.ts`       | `middleware/feature-flag-middleware.ts`            | Guard derives `tenantId` from `ctx.request.tenant?.id`; explicit `options.context` still wins; no tenant → field omitted (never `undefined`, per `exactOptionalPropertyTypes`).                                                                                                                |
| `database-plugin/test/unit/like-escape.test.ts`                        | `query/like-escape.ts`                             | Input→output shown literally for `%`, `_`, `\`, and a mixed value; identity for a value with no metacharacter.                                                                                                                                                                                 |
| `database-plugin/test/unit/prisma-adapter.test.ts`                     | `adapters/prisma/prisma-adapter.ts`                | Translated `where` asserted on the **escaped** value per provider; `sqlite` throws `UnsupportedFilterOperatorError`; unknown provider throws naming `provider`; explicit option beats detection; structural detection from a fake client.                                                      |
| `database-plugin/test/unit/filter-conformance.test.ts`                 | all four translation paths                         | One case table across Memory/Prisma/Drizzle/D1-shaped translation: agree, or refuse explicitly. The §3.7 regression gate.                                                                                                                                                                      |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts`        | drizzle arm (existing)                             | Unchanged behaviour after the helper extraction — pins the move is a no-op for Drizzle.                                                                                                                                                                                                        |
| `exceptions/test/unit/error-handler.test.ts`                           | `middleware/error-handler.ts`                      | A driver-shaped `Error` carrying SQL + params: the body carries **neither** the statement **nor** the values while an injected logger receives both; `HttpError` 500 unmasked; 4xx unaffected; `maskInternalErrors: false` restores; both `format` arms under the non-default masking setting. |
| `exceptions/test/integration/error-handler-app.test.ts`                | handler in a kernel app                            | Through `app.fetch` (not `inject`, which surfaces no headers): `application/problem+json` retained while masked.                                                                                                                                                                               |

External-dependency note: the Prisma arm has no real-import test to add — M66 made `prismaClient` a
required injected option, so there is no lazy `import()` in this path. The connector-detection
branch is therefore unit-tested against a fake client, and §7.1 drives the real one.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70b-tenant-isolation, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.8
```

Plus the constructs the gates do not catch, over every package this milestone touches:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/{cache,multi-tenancy,session,feature-flags,database}-plugin/src packages/exceptions/src packages/common/src
```

### 7.1 Beyond the gates — what must be driven for real

Five of the six rows are compositions or real-backend behaviours that no in-package unit test can
reach, and each is the reason its row shipped green in the first place:

1. **X4-1 / X4-3** — a real kernel application registering both plugins, per §6. These are the two
   integration tests, and each must be observed **failing without its fix**.
2. **X12-1** — the escaped `contains` re-run against **real Prisma on real PostgreSQL** (the
   register's own reproduction), and against **real Prisma on SQLite** confirming the named throw
   rather than wrong rows. §1.1's probe harness is the starting point; it is scratch and is not
   committed.
3. **X12-3** — a real driver error (a duplicate-unique insert) thrown through a real application, so
   the assertion is about an actual driver message rather than a hand-written string.
4. **X4-2** — the generated Kubernetes probe paths against a `required: true` app, since the
   deliverable is "a rolling deploy becomes ready".

### 7.2 Negative controls — each observed failing, then reverted

| # | Control                                                                | Expected failure                                                                                |
| - | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 | Drop the tenant segment from `composeCacheKey`                         | `tenant-cache-isolation` serves `acme`'s body to `globex`.                                      |
| 2 | Replace the length prefix with a bare `:` join                         | The forged-tenant-id case in `cache-key.test.ts` fails.                                         |
| 3 | Apply the tenant segment only to the default key, not a custom one     | The custom-`key` case in `cache-middleware.test.ts` fails — the documented workaround's trap.   |
| 4 | Compare the session tenant only, without binding on commit             | `session-tenant-cross-write` passes vacuously; assert it fails when binding is removed instead. |
| 5 | Escape the Prisma value on the SQLite arm instead of throwing          | The real-SQLite step in §7.1 returns `back\slash` for `%` — §1.1's measured wrong answer.       |
| 6 | Default `maskInternalErrors` to `false`                                | The disclosure test fails while every pre-existing exceptions test stays green.                 |
| 7 | Make the `tenants` rule an allowlist (grant) rather than a restriction | The "user allowlisted in another tenant" case in `flag-evaluator.test.ts` returns `true`.       |

## 8. Risks & mitigations

- **Cache keys change for every tenant-aware application on upgrade** → a one-time cold cache, not a
  correctness problem. Called out in the CHANGELOG so an operator expects the miss spike rather than
  investigating it.
- **`_activeProvider` is an underscore-private Prisma field and may move.** → the failure is a named
  throw pointing at the `provider` option, never a silent wrong answer; the option exists precisely
  for that day; and a unit test pins the detection-failure branch, so a Prisma upgrade that removes
  the field surfaces as a red test rather than as bad search results.
- **The default `exclude` list could un-protect an application route that happens to sit on
  `/health` or `/metrics`.** → documented, and `exclude: []` is the exact restore. The alternative
  (no default) leaves M39's generated manifests broken for everyone, which is the worse failure.
- **Masking could hide a diagnostic an operator relies on** → only when `logErrors: false` is _also_
  set, which is the configuration that already logs nothing. Documented together in the options
  table so the pair is visible.
- **Scope: six rows across seven packages is wide for one branch.** → they share one thesis and one
  release gate (the ROADMAP's reason for a closeout milestone), and the packages do not interact
  except through the two integration tests that are the point. Mitigation is ordering: X4-1 and X4-3
  first (they carry the security thesis and the hardest tests), then X12-3, then X12-1, then X4-2,
  then X4-6.

## 9. Out of scope

- **X4-8** — short-circuiting middleware emitting `{error, message}` instead of the configured RFC
  9457 body. **M70f** owns it, and §3.3 deliberately adds its new short-circuit in the same
  non-conforming shape so M70f converges one pattern rather than two.
- **X11-2** — nothing is logged when `errorHandler` is absent. **M70f**. §3.6 relies on the existing
  log path and does not widen it.
- **Reshaping `IFlagStore` to return per-tenant definitions** (the register's fuller X4-6 fix). A
  published port change for every provider and custom store, to express what
  `FlagDefinition.tenants` already expresses. If a per-tenant _store_ is wanted later it is its own
  milestone.
- **A tenant dimension for the audit trail (X4-7)** and the other "every capability is blind to the
  tenant" rows the register groups with these. Named in the register's cross-cutting section;
  distributed across M70c/M70f/M70j.
- **`IResponse.html()` (X4-11)** and the `csrf: {}` JSON-mutation trap (X4-5), both X4 rows and
  neither in this workstream's ROADMAP row.
- **Making `contains` case sensitivity uniform.** M68 established it follows the column's collation
  on a `LIKE` backend and documented it in three sites; no portable operator can override that, and
  this milestone does not reopen it.
