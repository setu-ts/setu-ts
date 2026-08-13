# Milestone 68 — Contract Gaps

> **Status:** Complete (PR pending). Branch: `feat/68-contract-gaps`. `main` is protected — all
> implementation and fixes stay on this branch until it merges through one PR.

## 0. Objective & scope

Close the four smoke-workspace contract gaps without creating parallel abstractions: add an
additive, portable repository filter expression and `findOne`, reject duplicate method/path
registrations at their source, expose the plugin that registered each router entry, and make
AuthPlugin RBAC configuration optional for JWT-only applications. The filter contract lives in
`common`, while every in-repository consumer that evaluates it is changed in this milestone:
database-plugin's repository plus Memory, Prisma, and Drizzle adapters, and cloudflare-plugin's D1
adapter.

- **In scope:** Common query and routing contract additions; database and D1 adapter translations;
  kernel ownership attribution and duplicate refusal; AuthPlugin's JWT-only configuration; public
  documentation, README corrections, and regression tests.
- **NOT this milestone:** New database backends, nested relation filters, case-insensitive collation
  policy, full-text search, query parsing from HTTP input, automatically exempting authentication
  paths, changes to route matching precedence, and changing the released
  `findAll({ where: { field: value } })` call shape.

## 1. Contracts verified from SOURCE

| Reference                     | Source                                                                                                                          | Verified surface / fact                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database backend port         | `packages/common/src/services/database.ts:78-159`                                                                               | `NormalizedQuery.where` and `IDataSource.count` are equality maps today; each adapter owns evaluation end to end.                                                            |
| Repository contract           | `packages/database-plugin/src/interfaces/index.ts:22-91`                                                                        | `IRepository` has `findById`, `findAll`, CRUD, `exists`, and `count`, but no `findOne`.                                                                                      |
| Query normalization           | `packages/database-plugin/src/query/find-options.ts:24-45`, `packages/database-plugin/src/query/query-builder.ts:31-104`        | Public `FindOptions` and `CountOptions` own the caller-facing `where`; `normalizeQuery` and `normalizeCountOptions` form the single repository-to-adapter translation point. |
| Base repository delegation    | `packages/database-plugin/src/repositories/base-repository.ts:60-108`                                                           | `findAll` delegates one normalized query to the source and must not re-apply filtering, pagination, or projection.                                                           |
| Memory evaluation             | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:185-250`, `299-309`                                             | Both transactional and committed reads call the shared equality matcher.                                                                                                     |
| Prisma translation            | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:44-60`, `322-349`                                               | The structural delegate accepts Prisma `where`; current adapter forwards the equality record unchanged.                                                                      |
| Drizzle translation           | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:96-108`, `392-483`                                            | Drizzle operators are explicitly injected and `predicateFor` currently produces equality conjunctions from a record.                                                         |
| D1 translation                | `packages/cloudflare-plugin/src/database/d1-data-source.ts:60-102`, `packages/cloudflare-plugin/src/database/d1-sql.ts:103-164` | D1 turns the normalized filter into parameterized SQL and validates identifiers before interpolation.                                                                        |
| Router contract               | `packages/common/src/plugin.ts:54-132`                                                                                          | `RouteInfo` exposes method, path, and definition; `IRouterApi.listRoutes()` exposes all entries but no owner.                                                                |
| Router implementation         | `packages/kernel/src/router/router.ts:55-92`, `240-245`                                                                         | `#entryMap` keys on method plus path and `set` currently replaces the earlier entry.                                                                                         |
| Plugin registration cursor    | `packages/kernel/src/application/application.ts:157-176`, `289-298`                                                             | Startup already tracks `registeringPlugin` around each `plugin.register(ctx)`, allowing route ownership to be captured at registration time.                                 |
| Auth options and registration | `packages/auth-plugin/src/interfaces/index.ts:66-75`, `packages/auth-plugin/src/plugin/auth-plugin.ts:123-138`                  | RBAC is required by the type and always constructs and registers `RbacService` under the authorization token.                                                                |
| Public barrels                | `packages/common/src/index.ts:85-151`, `packages/auth-plugin/src/index.ts:27-55`                                                | `RouteInfo`, database contracts, and `AuthPluginOptions` already reach consumers through package barrels, so every added public symbol requires docs and a barrel assertion. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                             | Resolution                                                                                                               | Doc deliverable                                                                                                     |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP says M68 names common, kernel, and auth only, while its S5 requirement says every adapter translates the shared filter. The source shows four adapter families across database-plugin and cloudflare-plugin. | Treat database-plugin and cloudflare-plugin as required S5 consumers, without changing the roadmap package heading.      | Document all affected package behavior in PUBLIC_API and the two affected package READMEs.                          |
| C2 | `PUBLIC_API.md` describes repository filtering as a `where` equality map and omits `findOne`; source implements the same restriction.                                                                                | Preserve equality-map calls and document the additive expression form, `findOne` semantics, and each supported operator. | Update DatabasePlugin's repository interface and examples in PUBLIC_API, plus `packages/database-plugin/README.md`. |
| C3 | `PUBLIC_API.md` says AuthPlugin options include RBAC but does not say it is required; source makes it mandatory even where authorization is unused.                                                                  | Make RBAC optional and document that authorization is absent unless an RBAC configuration is supplied.                   | Update AuthPlugin registration and exports notes in PUBLIC_API and `packages/auth-plugin/README.md`.                |
| C4 | `PUBLIC_API.md` describes route introspection but not ownership, while `RouteInfo` currently contains no owner.                                                                                                      | Add an additive `owner?: string` field, populated only for routes registered during a plugin's `register()` call.        | Update common and kernel API-reference contract notes in PUBLIC_API.                                                |

## 3. Design decisions

### 3.1 Portable filter expression and lookup

- **Decision:** Preserve `where: { field: value }` equality maps and add `filter?: FilterExpression`
  to `FindOptions` and `CountOptions`. `FilterExpression` is a discriminated tree with comparison
  leaves (`eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`) and composition nodes (`and`, `or`).
  `NormalizedQuery` carries both its existing equality `where` and an optional normalized `filter`.
  `IRepository.findOne(options?)` delegates through the same one-source `findAll` path with a forced
  `limit: 1`, returning its first row or `null`.
- **Why:** An additive `filter` field keeps every released equality-map call source-compatible and
  avoids reserving user entity field names such as `or`. A discriminated expression is unambiguous
  for adapters and supports composition without raw SQL. `findOne` has one evaluation path, so all
  adapter semantics remain aligned.
- **Test home:** `query-builder.test.ts`, `base-repository.test.ts`, the four adapter suites, D1
  SQL/data-source suites, and a database application integration test.

### 3.2 Adapter translation boundary

- **Decision:** `common` supplies only the zero-dependency filter types. Database-plugin owns the
  pure memory evaluator and the Prisma and Drizzle expression translators; D1 owns its SQL
  expression builder. Every value remains a bound parameter in D1. Each implementation supports the
  declared operators for scalar field values; `contains` is substring matching in Memory, Prisma,
  Drizzle, and SQLite D1, while `in` with an empty list compiles to a match-nothing predicate
  without binding values.
- **Why:** Common cannot import an ORM or SQL dialect, and each adapter already owns query
  evaluation. Keeping translation beside each adapter retains the established
  no-plugin-imports-plugin boundary and makes unsupported translation impossible to hide behind a
  generic cast.
- **Test home:** `memory-adapter.test.ts`, `prisma-adapter.test.ts`, `drizzle-adapter.test.ts`,
  `d1-sql.test.ts`, and `d1-data-source.test.ts`; real Drizzle and SQLite-backed D1 integrations
  exercise the generated predicate, not just a call record.

### 3.3 Duplicate route refusal

- **Decision:** `Router.#registerMethod` checks its method/path key before mutating `#routes`,
  `#entryMap`, or Hono, and throws an error that includes the duplicate method and path. Distinct
  methods on the same path and distinct path patterns remain legal. A failed registration leaves the
  existing route dispatchable.
- **Why:** The router is the only common chokepoint for programmatic routes, grouped routes, and
  decorated routes. Refusing before the Hono stub is added prevents a half-registered state.
- **Test home:** `packages/kernel/test/unit/router.test.ts` and a kernel application integration
  test that registers a plugin route plus an application route at the same key.

### 3.4 Route ownership introspection

- **Decision:** Extend public `RouteInfo` with optional `owner`. `Application` passes a synchronous
  owner reader into `Router`; while the plugin loop is executing it returns the active plugin name,
  and it returns `undefined` for routes registered directly by application code or outside plugin
  registration. `Router` snapshots that value into every entry, including nested groups;
  `listRoutes()` returns it unchanged.
- **Why:** The application already maintains the exact registration cursor for environment
  declarations. Reusing it attributes ownership accurately without a second registry, a new
  capability token, or an unbounded global route-label API. Optionality makes the public addition
  source-compatible and honestly represents application-owned routes.
- **Test home:** router unit tests cover snapshot and groups; an application integration test proves
  two plugin owners and one application route are distinguishable through the public
  `app.router.listRoutes()` API.

### 3.5 JWT-only AuthPlugin

- **Decision:** Make `AuthPluginOptions.rbac` optional. When absent, AuthPlugin registers only JWT
  and authentication services and its `provides` list names only those two tokens. When present, it
  constructs `RbacService`, registers the authorization token, and retains all existing RBAC
  behavior. Authorization guard factories keep their current missing-capability failure if an
  application calls one without configuring RBAC.
- **Why:** A JWT-only application has no authorization model to configure. Omitting the token when
  RBAC is absent keeps token declarations truthful and makes use of guards fail loudly instead of
  providing a permissive fake authorization service.
- **Test home:** `auth-plugin.test.ts`, `auth-integration.test.ts`, `guards.test.ts`, and the auth
  barrel-export test.

## 4. Exported surface — every symbol names its consumer

| Exported symbol       | Kind                                      | Consumer / real code path that reads it                                                                   |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `FilterExpression`    | common type                               | `FindOptions.filter`, `CountOptions.filter`, `NormalizedQuery.filter`, and all adapter translators.       |
| `FilterComparison`    | common type                               | The comparison arm of `FilterExpression`; read by the memory, Prisma, Drizzle, and D1 translators.        |
| `FilterOperator`      | common type                               | Constrains `FilterComparison.operator`; read by every adapter translation switch.                         |
| `RouteInfo.owner`     | additive common interface member          | `Router.listRoutes()` produces it; applications and plugins consume it through `IRouterApi.listRoutes()`. |
| `IRepository.findOne` | additive database-plugin interface method | `BaseRepository.findOne` implements it and applications call it for unique-column lookups.                |

### 4.1 Options — every option names its consumer

| Option                   | Consumer                                              | Behavior per implementation                                                                                                                        |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FindOptions.filter`     | `normalizeQuery` then each `IDataSource.findAll`      | Equality `where` is conjoined with the expression; Memory evaluates rows, Prisma and Drizzle build native predicates, D1 builds parameterized SQL. |
| `CountOptions.filter`    | `normalizeCountOptions` then each `IDataSource.count` | Uses the same filter semantics as `findAll`, without ordering, pagination, or projection.                                                          |
| `AuthPluginOptions.rbac` | `AuthPlugin`                                          | Present: constructs and registers RBAC authorization. Absent: does not create or provide authorization.                                            |

## 5. Implementation files

| File                                                               | Purpose                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/database.ts`                         | Add documented filter-expression types and carry optional filter data through `NormalizedQuery`.          |
| `packages/common/src/plugin.ts`                                    | Add optional `RouteInfo.owner` documentation.                                                             |
| `packages/common/src/index.ts`                                     | Re-export new common filter types.                                                                        |
| `packages/database-plugin/src/query/find-options.ts`               | Add caller-facing filter options and re-export common expression types.                                   |
| `packages/database-plugin/src/query/query-builder.ts`              | Normalize optional filters and provide the pure in-memory evaluator used only by the Memory adapter.      |
| `packages/database-plugin/src/interfaces/index.ts`                 | Add documented `IRepository.findOne`.                                                                     |
| `packages/database-plugin/src/repositories/base-repository.ts`     | Implement `findOne` through the existing normalized-data-source path.                                     |
| `packages/database-plugin/src/adapters/memory/memory-adapter.ts`   | Evaluate equality maps and expression trees for committed and transaction-overlay reads and counts.       |
| `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts`   | Translate expressions into Prisma `where` input and extend the structural delegate boundary.              |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts` | Load the required Drizzle operators and translate expressions to a native predicate.                      |
| `packages/cloudflare-plugin/src/database/d1-sql.ts`                | Compile expressions into parenthesized, bound SQLite predicates and use them for select and count.        |
| `packages/cloudflare-plugin/src/database/d1-data-source.ts`        | Pass the widened normalized query and count filter to the D1 SQL builder.                                 |
| `packages/kernel/src/router/router.ts`                             | Reject duplicate keys before registration and snapshot owner data into entries and introspection results. |
| `packages/kernel/src/application/application.ts`                   | Supply Router with the existing active-plugin registration cursor.                                        |
| `packages/auth-plugin/src/interfaces/index.ts`                     | Make RBAC optional and document the absent-authorization behavior.                                        |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                   | Conditionally provide and register the authorization service.                                             |
| `PUBLIC_API.md`                                                    | Update common, kernel, database, and auth public-contract documentation and examples.                     |
| `packages/database-plugin/README.md`                               | Document portable filter expressions and `findOne`.                                                       |
| `packages/auth-plugin/README.md`                                   | Document JWT-only setup and the optional RBAC arm.                                                        |

## 6. Test plan

| Test file                                                                | src covered                                              | Key assertions                                                                                                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database-plugin/test/unit/query-builder.test.ts`               | `query/find-options.ts`, `query/query-builder.ts`        | Equality calls normalize unchanged; every leaf and composition branch evaluates correctly in memory; empty `in` matches no rows.                                                   |
| `packages/database-plugin/test/unit/base-repository.test.ts`             | `interfaces/index.ts`, `repositories/base-repository.ts` | `findOne(options?)` passes a one-row normalized query to its source and returns the row or `null`; it does not re-filter the adapter output.                                       |
| `packages/database-plugin/test/unit/memory-adapter.test.ts`              | `adapters/memory/memory-adapter.ts`                      | Committed and transactional `findAll` and `count` apply equality plus expression filtering, then preserve sort, page, and projection behavior.                                     |
| `packages/database-plugin/test/unit/prisma-adapter.test.ts`              | `adapters/prisma/prisma-adapter.ts`                      | Fake delegate observes the exact Prisma expression for all leaves and nested composition; legacy equality map retains its existing delegate call.                                  |
| `packages/database-plugin/test/unit/drizzle-adapter.test.ts`             | `adapters/drizzle/drizzle-adapter.ts`                    | Injected operators receive real table columns and the expected nested predicate calls for reads and counts.                                                                        |
| `packages/database-plugin/test/integration/real-drizzle-adapter.test.ts` | `adapters/drizzle/drizzle-adapter.ts`                    | A real Drizzle query returns only rows selected by `contains`, comparison, membership, and composition.                                                                            |
| `packages/database-plugin/test/e2e/database-application.test.ts`         | Public database surface                                  | A kernel application writes rows, looks one up with `findOne({ filter })`, and reads the expected result through `IDatabaseService`.                                               |
| `packages/cloudflare-plugin/test/unit/database/d1-sql.test.ts`           | `database/d1-sql.ts`                                     | SQL is parenthesized correctly, all values are bound, empty membership is match-nothing, identifier validation remains enforced, and select/count share predicate semantics.       |
| `packages/cloudflare-plugin/test/unit/database/d1-data-source.test.ts`   | `database/d1-data-source.ts`                             | Source forwards widened filter data to D1 statements for regular and transaction-scoped reads and counts.                                                                          |
| `packages/cloudflare-plugin/test/integration/d1-database.test.ts`        | D1 database path                                         | SQLite-backed D1 executes every advertised filter operator and `findOne` through the public repository contract.                                                                   |
| `packages/kernel/test/unit/router.test.ts`                               | `router/router.ts`                                       | Duplicate same-method/path registration throws without replacing the first route; verb and pattern distinctions remain valid; ownership snapshots and grouped routes are reported. |
| `packages/kernel/test/integration/route-ownership.test.ts`               | `application/application.ts`, public routing contract    | Public introspection reports two plugin owners and leaves a direct application route owner absent; a cross-origin duplicate fails at application startup.                          |
| `packages/auth-plugin/test/unit/auth-plugin.test.ts`                     | `interfaces/index.ts`, `plugin/auth-plugin.ts`           | JWT-only options type-check, register two capabilities, and omit authorization; configured RBAC keeps the existing three-service result.                                           |
| `packages/auth-plugin/test/integration/auth-integration.test.ts`         | AuthPlugin behavior                                      | JWT authentication works with no RBAC; an authorization guard without its capability still fails rather than granting access.                                                      |
| `packages/common/test/unit/database-filter-contract.test.ts`             | `services/database.ts`, `index.ts`, `plugin.ts`          | Common public types compile through the barrel and `RouteInfo.owner` remains optional for existing producers.                                                                      |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/68-contract-gaps, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

After committing the milestone tree, also run `deno task publish:check` and
`deno task release:verify 0.1.0-alpha.7`. Exercise the public database path by writing rows and
reading an expression-filtered `findOne` result back; run the duplicate route case with a
plugin-originated and application-originated route; and prove the JWT-only plugin emits no
authorization capability.

## 8. Risks & mitigations

- Filter syntax that is convenient in one ORM but not portable could produce divergent results.
  Mitigate with one explicit common AST, adapter-level native-predicate assertions, and shared
  cross-adapter behavioral cases.
- SQL expression generation could interpolate values or create incorrect precedence. Mitigate with
  SQL-string plus bound-parameter tests, parentheses around every composition node, and the existing
  identifier allowlist.
- Adding required backend-port fields would break external adapter implementations. Mitigate by
  retaining the existing equality `where` member and adding the normalized expression as an optional
  member.
- Route ownership could accidentally report a later plugin for an earlier route. Mitigate by
  snapshotting the registration cursor in `#registerMethod`, then testing owner attribution after
  startup completes.
- Removing RBAC registration may surprise code that calls authorization guards. Mitigate by
  retaining the guards' existing missing-capability failure and documenting the needed RBAC
  configuration.

## 9. Out of scope

- Relation traversal, JSON-path filters, database-specific regex operations, and collation-specific
  case folding are deferred to a later repository-contract milestone.
- Authentication-path exemption policy remains application middleware design; M68 supplies plugin
  route ownership for that consumer but does not silently alter `authMiddleware` or guards.
- Automatic duplicate detection in CLI schematics is deferred: decorator paths are dynamic source
  metadata, while the kernel is the only complete runtime authority.
- Existing external adapters must opt into `NormalizedQuery.filter`; the optional contract field
  preserves compilation while their maintainers add native translation.
