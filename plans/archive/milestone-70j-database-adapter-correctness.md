# Milestone 70j — Database adapter correctness (`@setu-ts/database-plugin`)

> **Status:** Complete (PR #177). Branch: `feat/m70j-database-adapter-correctness`. Archived on
> completion; all work (implementation + fixes) stayed on this one branch.

## 0. Objective & scope

Close the six `smoke/DEFECTS.md` rows the register assigns to this workstream, all of which are one
theme: **an adapter that reports success while doing something other than what its contract says.**
`IDatabaseService.query()` cannot work at all on the Drizzle adapter, because the adapter calls
`execute()` with an argument shape no Drizzle driver accepts (X12-2). The **default** Memory adapter
silently accepts an unknown `select` / `orderBy` column that both real backends reject by name
(X12-5). The Drizzle registry refuses a composite-key table at `connect()` even when only the typed
query builder needs it (X4-9). Drizzle's and Prisma's required options are optional fields on a
nested bag, so omitting them is a runtime throw rather than a compile error (D7) — and the published
Prisma registration snippet is the v6 constructor, which does not compile against a real v7 client
(X12-4). `transactionTimeout` is a read, public option documented nowhere (X12-6).

One defect found while reading the source for the above is fixed with them, because it is the same
class and the same package: with `logQueries: true` the service's logging wrapper calls
`ds.count(where)` and **drops the `filter` argument**, so `repo.count({ filter })` silently ignores
the filter — a "one capability, one implementation" split where the logged path and the unlogged
path answer differently.

- **In scope:** `packages/database-plugin` (`src` + tests), the doc corrections D7/X12-4/X12-6 force
  across `PUBLIC_API.md`, root `README.md`, `packages/database-plugin/README.md`,
  `packages/starters/*/README.md`, `AI_GUIDELINES.md` §12.2's one-line example, and the four
  forward-looking `ROADMAP.md` registration examples; `CHANGELOG.md`; `smoke/DEFECTS.md` status
  rows.
- **NOT this milestone:** X12-1 (Prisma `contains` wildcards) and X12-3 (SQL leaking into a 500
  body) — both already shipped, in M70b and M70f respectively. Memory-adapter uniqueness and column
  **type** enforcement — documented rather than implemented, see §3.3. Raw `query()` on
  `execute()`-less Drizzle instances — measured unfixable, see §3.2. `DatabaseService.query()`'s
  synchronous memory refusal — pre-existing, pinned by two committed tests, flagged in M52c and
  still out of scope.

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                                         | Verified surface / fact                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDataSource.count`                         | `packages/common/src/services/database.ts:207`                             | `count(where: Record<string, unknown>, filter?: FilterExpression): Promise<number>` — TWO parameters. `DatabaseService.wrapDataSource` (`services/database-service.ts:204`) declares `async count(where)` and calls `ds.count(where)`, dropping the second. |
| `IDataSource`                               | `packages/common/src/services/database.ts:154-208`                         | `findAll`/`findById`/`create`/`update`/`delete`/`count`. The data source owns evaluation end to end; `BaseRepository` must not re-apply any of it.                                                                                                          |
| `NormalizedQuery`                           | `packages/common/src/services/database.ts:122-135`                         | `where`, optional `filter`, `orderBy`, `limit` (`-1` unlimited), `offset`, `readonly select: readonly string[]`.                                                                                                                                            |
| `IDatabaseService.query`                    | `packages/database-plugin/src/interfaces/index.ts:181`                     | `query<T>(sql: string, params?: unknown[]): Promise<T[]>` — rows are OBJECTS (`T[]`), and `params` are "replaced positionally".                                                                                                                             |
| `PrismaAdapter.rawQuery`                    | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:252-257`   | `$queryRawUnsafe(sql, ...params)` — statement text passed through **verbatim**, params bound natively.                                                                                                                                                      |
| `D1Adapter.rawQuery`                        | `packages/cloudflare-plugin/src/database/d1-adapter.ts:225-229`            | `prepare(sql).bind(...params).all()` — statement text passed through **verbatim**, params bound natively. So the framework's `query()` contract is "the connector's own placeholders, positional params".                                                   |
| `DrizzleAdapter.rawQuery`                   | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:317-329` | Guards `typeof execute === 'function'` then calls `execute.call(db, { sql, params })`. Nothing checks the call shape.                                                                                                                                       |
| `DrizzleAdapter.connect` table check        | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:219-227` | Rejects any registered table without an `id` column, for EVERY table, at connect time.                                                                                                                                                                      |
| `createDrizzleDataSourceInner`              | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:463`     | Already calls `columnFor(drizzleTable, entity, 'id')` eagerly, which throws `Drizzle table '<entity>' has no 'id' column required by the database repository.` — so the lazy refusal X4-9 asks for already exists.                                          |
| `DatabasePluginOptions`                     | `packages/database-plugin/src/interfaces/index.ts:283`                     | `BuiltInDatabaseOptions \| CustomDatabaseOptions`; the built-in arm has `type?: 'prisma' \| 'drizzle' \| 'memory'` and `options?: DatabaseAdapterOptions`, so every adapter-specific field is optional on a nested bag.                                     |
| `DatabaseAdapterOptions.transactionTimeout` | `packages/database-plugin/src/interfaces/index.ts:376`                     | Declared and JSDoc'd. Read at `prisma-adapter.ts:167` (`timeout: this._options?.transactionTimeout ?? 30_000`). `grep -c transactionTimeout` is **0** in both `packages/database-plugin/README.md` and `PUBLIC_API.md`.                                     |
| `RestStarterOptions.database`               | `packages/starters/rest-starter/src/options.ts:113`                        | `database?: DatabasePluginOptions` — passed straight through at `src/app.ts:61`, so the starters inherit the tightened union with **no starter `src` change**.                                                                                              |
| `docs/migration-nestjs.md` Prisma fence     | `docs/migration-nestjs.md:455-472`                                         | Already passes `options: { prismaClient: myPrismaClient }`, so the M38 guide-fence gate is unaffected by the tightened Prisma arm. Checked because that gate compiles this file.                                                                            |
| npm `drizzle-orm@0.45.2` exports            | probed (`Object.keys`)                                                     | Exports `SQL`, `Param`, `sql`, and `sql` carries `.raw`, `.param`, `.join`, `.fromList`, `.identifier`, `.placeholder`, `.empty`.                                                                                                                           |
| Drizzle `execute()` accepted shapes         | probed against real `pg-proxy`                                             | `{ sql, params }` → **FAIL `query.getSQL is not a function`** (the defect, reproduced). Bare string → OK, no params. `sql.raw(text)` → OK, no params. `new SQL([raw, param, raw])` → OK, params bound.                                                      |
| Drizzle placeholder emission                | probed against real `pg-proxy`, `mysql-proxy`, `sqlite-proxy`              | A `Param` chunk renders `$1`,`$2`… on pg and `?` on mysql/sqlite, numbered in **chunk order**. So a user's ascending `$1 $2` (pg) or `?` (mysql/sqlite) statement round-trips byte-identical.                                                               |
| `sqlite-proxy` instance surface             | probed                                                                     | Has `all`/`get`/`run`, and **no `execute`**. `all()` on a raw statement returns **arrays** (`[["a",1]]`), not objects — the proxy protocol returns positional rows and drizzle has no field map for raw SQL.                                                |
| `pg-proxy` `execute()` return               | probed                                                                     | Returns the callback's `rows` array directly. `node-postgres` returns pg's `QueryResult` (`.rows`). The adapter's existing `result.rows ?? result` unwrap covers both — keep it.                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                                                | Doc deliverable (same PR)                                                                                                                                                                                |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `packages/database-plugin/README.md:24` and `PUBLIC_API.md:862` show `new PrismaClient()`; a real Prisma 7.9.1 generated client requires a driver adapter (`TS2554 Expected 1 arguments, but got 0`).                                                                                                                                                                | The code is right, the docs are wrong. Snippets move to `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.                                                            | Rewrite both snippets and add a "Prisma 7 setup" note naming the three undocumented prerequisites (driver-adapter package, `prisma.config.ts`, the adapter's `schema` option for a non-`public` schema). |
| C2 | `README.md:269`, `ROADMAP.md:574`, `PUBLIC_API.md:6334` show `DatabasePlugin({ type: 'prisma' })` with no client — one of them annotated "reads DATABASE_URL via the config capability". Since M66 the Prisma adapter **requires** `options.prismaClient` and throws at `connect()`.                                                                                 | The code is right. Every example gains an injected client; the false `DATABASE_URL` annotation is deleted.                                                                              | Corrected examples in all three files.                                                                                                                                                                   |
| C3 | `PUBLIC_API.md:1186,1192`, `PUBLIC_API.md:6100`, `ROADMAP.md:1312,5808,5830`, `packages/starters/full-stack-starter/README.md:199` configure Prisma with `url`. `DatabaseAdapterOptions.url` is `@deprecated` and **is not read by the Prisma adapter** (`interfaces/index.ts:311`). Two of them also put `url` at the top level, where no such field exists at all. | The deprecation is right; the examples are stale. All move to `options: { prismaClient }`.                                                                                              | Corrected examples in all four files.                                                                                                                                                                    |
| C4 | `AI_GUIDELINES.md:717` illustrates §12.2 with `DatabasePlugin({ type: 'prisma', client: prismaClient })`. There is no `client` option — it is `options.prismaClient`.                                                                                                                                                                                                | The code is right.                                                                                                                                                                      | One-line correction.                                                                                                                                                                                     |
| C5 | `packages/database-plugin/README.md` and `PUBLIC_API.md` both state that a Drizzle table registry's tables "must carry an `id` column", which X4-9 changes from a connect-time requirement to a repository-time one.                                                                                                                                                 | The new behaviour is the one to document: the registry accepts any table; a **repository** for an `id`-less table is refused by name; the typed query builder reaches the whole schema. | Reword both, in the same PR as the code change.                                                                                                                                                          |
| C6 | `DatabaseAdapterOptions.transactionTimeout` is public, JSDoc'd and read, and appears in neither the README options table nor `PUBLIC_API.md` (X12-6). CLAUDE.md's rule is that an exported surface and `PUBLIC_API.md` move together.                                                                                                                                | Document it.                                                                                                                                                                            | New row in the README options table and a sentence in `PUBLIC_API.md` naming the 30 s default and Prisma's ~5 s one.                                                                                     |
| C7 | `packages/database-plugin/README.md` says "only `IDatabaseService.query()` rejects" for `execute()`-less Drizzle instances, without saying why — which reads as an oversight a later milestone should fix. Measured (§1): it is not fixable, because `sqlite-proxy.all()` returns positional arrays and the contract promises objects.                               | Keep the rejection; state the measured reason so it is not re-opened.                                                                                                                   | One sentence in the README and in `PUBLIC_API.md`.                                                                                                                                                       |

## 3. Design decisions

### 3.1 Raw SQL on Drizzle — bind through a real `SQL` object, statement text preserved (X12-2)

- **Decision:** A new internal pure module `src/query/raw-statement.ts` exports
  `bindRawStatement(statement, params, tag)`, returning the chunk list a Drizzle `SQL` is built
  from. With no params it is a single `sql.raw(statement)` chunk — statement verbatim, which is what
  Prisma and D1 already do. With params it scans the statement for placeholder tokens, splits on
  them, and interleaves `sql.param(value)`; the adapter then calls `execute(new SQL(chunks))`. `SQL`
  and `sql` are read from the already-loaded `npm:drizzle-orm@0.45.2` namespace at `connect()`,
  added to the existing `DrizzleOperators` bag and validated by the existing
  `typeof … !== 'function'` gate, so a namespace missing them fails at connect with the existing
  named error rather than at first query.
- **Why:** Both other adapters pass the statement text through verbatim and bind params natively, so
  that is the contract. Drizzle renumbers `Param` chunks in encounter order and renders them
  dialect-natively (`$N` on pg, `?` on mysql/sqlite — measured in §1), so an ascending-placeholder
  statement round-trips byte-identical while a driver never sees an interpolated value. Passing the
  bare string would work today and **silently drop `params`**, which is worse than the current
  failure.
- **Scanner rules:** the scan skips `'…'` (with `''` escape), `"…"` (with `""` escape), `` `…` ``,
  `--` line comments, nested `/* … */` block comments, and PostgreSQL `$tag$ … $tag$` dollar quotes,
  so a `?` inside a string literal is never mistaken for a placeholder. Tokens are `?` (positional)
  and `$` followed by digits (numbered, so `$1` may repeat and binds `params[0]` each time). Mixing
  the two forms, or a placeholder count that disagrees with `params.length`, throws a named error
  **before** the statement reaches the driver — a mis-bind is silent, a refusal is not.
- **Test home:** `test/unit/raw-statement.test.ts` (scanner branches), and
  `test/integration/real-drizzle-adapter.test.ts` + `test/integration/drizzle-query-sqlite.test.ts`
  drive `query()` through the REAL Drizzle SQL generator, the second one executing against a real
  `node:sqlite` engine.

### 3.2 `execute()`-less Drizzle instances keep rejecting `query()` (X12-2 boundary)

- **Decision:** unchanged behaviour; only the diagnostic and the docs change, to state the measured
  reason.
- **Why:** measured, not assumed — `sqlite-proxy` has no `execute` but does have `all()`, and
  `all()` on a raw statement returns **positional arrays** (`[["a",1]]`) because the proxy protocol
  returns array rows and drizzle has no field map for raw SQL. `IDatabaseService.query<T>` promises
  row objects, which Prisma and D1 both return. Routing through `all()` would have swapped a loud
  failure for a silent shape divergence — exactly the defect class this milestone closes.
- **Test home:** `test/integration/drizzle-query-sqlite.test.ts` asserts the rejection against the
  real `execute`-less instance, so the boundary is pinned by the driver rather than by a fake.

### 3.3 Memory adapter refuses an unknown `select` / `orderBy` column (X12-5)

- **Decision:** `select` and `orderBy` fields are validated against the entity's **observed** column
  set — the union of own keys across the rows the store currently holds (the transaction overlay's
  effective rows inside a UoW). An unknown field throws
  `Memory adapter: entity '<entity>' has no '<field>' column …`, mirroring Drizzle's named refusal.
  When the store holds **no rows at all** the check is skipped, because there are neither
  observations to judge against nor rows to return, and rejecting an ordinary query against an empty
  table would be wrong. `where` and `filter` fields are deliberately NOT validated.
- **Why:** the register's preferred fix, and the two divergences it names as worth fixing. `where`
  is excluded with cause: the memory adapter cannot distinguish "unknown column" from "column that
  is absent on every row", and `where: { deletedAt: undefined }`-shaped queries against a sparse
  store are meaningful — returning no rows is a defensible answer, whereas ordering by a field no
  row carries returns rows in an arbitrary order and projecting one silently changes the response
  shape. Uniqueness and column types stay unenforced because the adapter is never given a schema;
  they get a documented guarantee list instead (the register's fix #2).
- **Test home:** `test/unit/memory-adapter-columns.test.ts`, plus a parity assertion in
  `test/unit/filter-conformance.test.ts`.

### 3.4 Drizzle registry validates `id` lazily, at repository construction (X4-9)

- **Decision:** `connect()` keeps rejecting a registry entry that is not an object, and stops
  rejecting one without an `id` column. The refusal moves to the point a data source is built, which
  is where `createDrizzleDataSourceInner` already calls `columnFor(table, entity, 'id')`.
- **Why:** `IRepository`'s `findById`/`update`/`delete` are single-key by contract, so a
  composite-key table genuinely cannot have a repository — but the registry was enforcing the
  repository's precondition on tables only the typed query builder reads, which made the whole
  registry all-or-nothing. No new code path is needed: the lazy refusal already exists and is
  already named.
- **Test home:** `test/unit/drizzle-adapter-columns.test.ts` — connect succeeds with a composite-key
  table present, `createDataSource` for it throws by name, and the typed builder reaches it.

### 3.5 Adapter-specific options become compile-time required per arm (D7)

- **Decision:** `BuiltInDatabaseOptions` stays exported and keeps its documented role, but becomes
  the union of three new exported arms — `MemoryDatabaseOptions` (`type?: 'memory'`),
  `PrismaDatabaseOptions` (`type: 'prisma'`, `options: PrismaAdapterOptions`) and
  `DrizzleDatabaseOptions` (`type: 'drizzle'`, `options: DrizzleAdapterOptions`). Two new exported
  interfaces narrow `DatabaseAdapterOptions`: `PrismaAdapterOptions` requires `prismaClient`,
  `DrizzleAdapterOptions` requires `drizzleInstance` and `drizzleTables`.
  `DatabasePluginOptions = BuiltInDatabaseOptions | CustomDatabaseOptions` is unchanged.
- **Why:** the `'custom'` arm already proves the pattern — `adapter` is required by the union, "so a
  registration that forgets it is a compile error rather than a startup throw". Prisma is included
  with Drizzle because M66 made `prismaClient` required at runtime and it is the identical defect;
  leaving it as a runtime-only throw in a milestone named "adapter correctness" would be
  inconsistent, and it is what turns the six stale doc sites in §2 from silent lies into checked
  ones. Keeping the `BuiltInDatabaseOptions` name (rather than removing it) means a consumer that
  annotated against it and passes a memory config still compiles.
- **Breaking:** type-level only, and only for a registration that **already threw at startup**. It
  ships with CHANGELOG migration text.
- **Test home:** `test/unit/plugin-options-types.test.ts` (compile-only `@ts-expect-error`
  assertions), plus the runtime guards that stay tested through the adapter classes directly.

### 3.6 `logQueries` no longer drops the `count` filter

- **Decision:** `DatabaseService.wrapDataSource`'s `count` takes and forwards both parameters.
- **Why:** `IDataSource.count(where, filter?)` (§1). With `logQueries: true` the wrapper is the data
  source the repository sees, so `repo.count({ filter })` returned the unfiltered-by-`filter` count
  — a different answer from the same call with logging off. Every existing test constructs the
  service without `logQueries`, which is why it survived.
- **Test home:** `test/unit/database-service-coverage.test.ts` — the same `count({ where, filter })`
  driven with logging ON and OFF must return the same number, and the test fails without the fix.

## 4. Exported surface — every symbol names its consumer

| Exported symbol          | Kind      | Consumer / real code path that READS it                                                                                                                                                 |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrismaAdapterOptions`   | interface | The `options` field of `PrismaDatabaseOptions`; `DatabasePlugin` accepts it and `buildAdapterOptions` reads `prismaClient` from it. Application code annotating a Prisma configuration. |
| `DrizzleAdapterOptions`  | interface | The `options` field of `DrizzleDatabaseOptions`; `DrizzleAdapter.resolveDb`/`resolveTables` read both required fields.                                                                  |
| `MemoryDatabaseOptions`  | interface | Arm of `BuiltInDatabaseOptions`; selected by `DatabasePlugin` when `type` is absent or `'memory'`.                                                                                      |
| `PrismaDatabaseOptions`  | interface | Arm of `BuiltInDatabaseOptions`; `createAdapter`'s `'prisma'` case.                                                                                                                     |
| `DrizzleDatabaseOptions` | interface | Arm of `BuiltInDatabaseOptions`; `createAdapter`'s `'drizzle'` case.                                                                                                                    |
| `BuiltInDatabaseOptions` | type      | **Already exported** — now the union of the three arms above. Read by `DatabasePluginOptions` and by `RestStarterOptions.database`.                                                     |

No symbol is removed, and no other barrel entry changes. Pinned by
`test/unit/barrel-exports.test.ts`, which already asserts the exact published surface.

`bindRawStatement` and the memory column check are **internal** — not barrel-exported, unit-tested
through their own modules, and consumed by `DrizzleAdapter.rawQuery` and `MemoryAdapter`
respectively.

### 4.1 Options — every option names its consumer

| Option                                                 | Consumer                                                          | Behavior (per implementation)                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PrismaAdapterOptions.prismaClient` (now required)     | `PrismaAdapter.connect` (`prisma-adapter.ts`)                     | Unchanged at runtime — already required and already throws when absent. The change is that omitting it is now a compile error.                   |
| `DrizzleAdapterOptions.drizzleInstance` (now required) | `DrizzleAdapter.resolveDb` (`drizzle-adapter.ts:379`)             | Unchanged at runtime. Omitting it is now a compile error.                                                                                        |
| `DrizzleAdapterOptions.drizzleTables` (now required)   | `DrizzleAdapter.connect` / `resolveTables`                        | Still rejected at connect when empty or holding a non-object; **no longer** rejected for a table without an `id` column (§3.4).                  |
| `DatabaseAdapterOptions.transactionTimeout`            | `PrismaAdapter` interactive transaction (`prisma-adapter.ts:167`) | Existing behaviour, newly documented: raises Prisma's ~5 s interactive-transaction default; defaults to 30 000 ms. Unread by Memory and Drizzle. |

No option is added. `transactionTimeout` is an existing option gaining documentation, and the
`buildAdapterOptions` copy loses an unnecessary `as Record<string, unknown>` cast now that the field
is (and always was) declared.

## 5. Implementation files

| File                                      | Purpose                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                            | Export the five new option types (§4). Nothing removed.                                                                  |
| `src/query/raw-statement.ts`              | **New.** Pure placeholder scanner + chunk builder for Drizzle raw SQL (§3.1). Internal.                                  |
| `src/adapters/drizzle/drizzle-adapter.ts` | `rawQuery` builds a real `SQL`; `SQL`/`sql` join the operator bag at connect; connect stops requiring `id` (§3.1, §3.4). |
| `src/adapters/memory/memory-adapter.ts`   | Both data-source paths validate `select` / `orderBy` against observed columns (§3.3).                                    |
| `src/query/query-builder.ts`              | Pure `unknownColumnError` the memory adapter calls, over a non-exported `observedColumns` (§3.3).                        |
| `src/services/database-service.ts`        | `wrapDataSource.count` forwards `filter` (§3.6).                                                                         |
| `src/interfaces/index.ts`                 | The per-arm option union (§3.5); JSDoc for the changed Drizzle `id` rule and the documented `transactionTimeout`.        |
| `src/plugin/database-plugin.ts`           | Accepts the tightened union; drops the stale `transactionTimeout` cast; example JSDoc corrected to a v7-shaped client.   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                  | src covered                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/raw-statement.test.ts` (new)                                                                                                                                                                    | `src/query/raw-statement.ts`            | `bindRawStatement(statement, params, tag)`: no params → one raw chunk, text verbatim; `?` positional; `$N` numbered incl. a repeated `$1`; a `?` inside `'…'`, `"…"`, `` `…` ``, `--`, `/* */` (nested) and `$tag$…$tag$` is NOT a placeholder; count mismatch, index gap and mixed forms each throw by name. |
| `test/integration/real-drizzle-adapter.test.ts`                                                                                                                                                            | `drizzle-adapter.ts` `rawQuery`         | Through the REAL pg SQL generator: `service.query('select … where n > $1', [1])` reaches the driver as `$1` with `params: [1]`, and returns row objects. Reverting to `{ sql, params }` reproduces `query.getSQL is not a function`.                                                                          |
| `test/integration/drizzle-query-sqlite.test.ts`                                                                                                                                                            | `drizzle-adapter.ts` `rawQuery` refusal | Against the REAL `execute`-less `sqlite-proxy` instance over a real `node:sqlite` engine: `query()` rejects with the named guidance (§3.2), while repositories and the typed builder still work.                                                                                                              |
| `test/unit/drizzle-adapter-columns.test.ts` (new)                                                                                                                                                          | `drizzle-adapter.ts` connect + factory  | `connect()` succeeds with a composite-key table in the registry; `createDataSource('TenantFlag')` throws `has no 'id' column`; a non-object registry entry still fails at connect; the typed handle still resolves.                                                                                           |
| `test/unit/memory-adapter-columns.test.ts` (new)                                                                                                                                                           | `memory-adapter.ts`, `query-builder.ts` | Unknown `select` and unknown `orderBy` throw by name on the direct path AND inside a transaction overlay; a known field still works; an EMPTY store accepts both without throwing; `where`/`filter` on an unknown field still return `[]` rather than throwing.                                               |
| `test/unit/filter-conformance.test.ts` (extended)                                                                                                                                                          | all four adapters                       | The existing one-query-through-every-adapter suite gains an unknown-`orderBy` row: Memory and Drizzle now refuse it the same way.                                                                                                                                                                             |
| `test/unit/database-service-coverage.test.ts` (extended)                                                                                                                                                   | `database-service.ts` `wrapDataSource`  | `count({ where, filter })` returns the SAME number with `logQueries: true` and with it off; the logged call receives BOTH arguments. Fails without §3.6.                                                                                                                                                      |
| `test/unit/plugin-options-types.test.ts` (new)                                                                                                                                                             | `src/interfaces/index.ts`               | Compile-only: `DatabasePlugin({ type: 'prisma' })`, `DatabasePlugin({ type: 'drizzle' })` and `DatabasePlugin({ type: 'drizzle', options: { drizzleTables: {} } })` are each `@ts-expect-error`; a memory config with no `options`, and fully-specified prisma/drizzle configs, compile.                      |
| `test/unit/plugin.test.ts`, `plugin-coverage.test.ts`, `integration/database-plugin.test.ts`, `e2e/database-application.test.ts` (updated; the e2e already passed full Drizzle options and needed no edit) | `database-plugin.ts`                    | Existing registrations gain the now-required options. Runtime "missing option throws" cases move to constructing the adapter class directly, which still accepts `DatabaseAdapterOptions \| undefined`.                                                                                                       |
| `test/unit/barrel-exports.test.ts` (extended)                                                                                                                                                              | `src/index.ts`                          | The five new type exports are present and nothing else moved.                                                                                                                                                                                                                                                 |

External-dependency coverage: the two Drizzle integration files ARE the guarded real-import tests —
they import `npm:drizzle-orm@0.45.2` for real and run its actual SQL generator, so the fake-driver
unit tests are never the only path the suite runs. That is the exact gap X12-2 names as its cause.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70j-database-adapter-correctness, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # package catalog, export table, cross-file anchors
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.8
```

## 8. Risks & mitigations

- **The placeholder scanner mis-splits an exotic statement** → the scan only ever decides where to
  cut; a wrong count refuses loudly before the driver is touched, and values are always bound rather
  than interpolated, so a mis-scan can never become an injection. Every quoting form has its own
  unit test.
- **The memory column check rejects a legitimately sparse optional field** (no row carries
  `deletedAt` yet, and a caller projects it) → narrowed by validating against the union of keys over
  ALL rows rather than the first, skipped entirely on an empty store, restricted to `select` and
  `orderBy`, and documented in the README's guarantee list. The failure is loud and immediate,
  against the silent wrong answer it replaces.
- **The tightened union breaks a downstream registration** → only registrations that already threw
  at startup stop compiling; the starters pass `DatabasePluginOptions` straight through so no
  starter `src` changes; CHANGELOG carries migration text. The `deno task check` of the whole
  workspace plus the M38 guide-fence gate are the mechanical proof.
- **A doc correction lands in one file and not its twin** → `deno task check:docs` validates the
  README export table and cross-file anchors, and §2 lists every site by file:line so the sweep is
  enumerable rather than remembered.

## 9. Out of scope

- **Memory-adapter uniqueness and column-type enforcement** (the other two X12-5 divergences) — the
  adapter is never given a schema, so both are undecidable there. They get the documented guarantee
  list instead, which is the register's own fix #2. A schema-aware memory adapter would be its own
  milestone.
- **`DatabaseService.query()` throwing synchronously on the memory adapter** — pre-existing
  published behaviour pinned by two committed tests, flagged in M52c; still not this milestone's
  scope.
- **X12-1 and X12-3** — shipped in M70b and M70f.
- **A doc-fence gate over package READMEs** — X12-4 notes one would have caught the Prisma
  constructor. It cannot: compiling that snippet needs a generated Prisma client, which this repo
  does not and should not hold. Owned by nothing; recorded here so it is not re-raised as an
  oversight.
