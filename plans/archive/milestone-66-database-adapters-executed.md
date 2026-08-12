# Milestone 66 — Database Adapters That Have Been Executed (`@setu-ts/database-plugin`)

> **Status:** Complete (PR #156). Branch: `feat/m66-database-adapters-that-have-been-executed`.
> `main` is protected — all work (implementation + fixes) stays on this one branch until it merges
> via a single PR.

## 0. Objective & scope

Make the shipped Prisma and Drizzle adapters execute the driver APIs they claim to support. Prisma
v7 generated clients are application-local and reject the legacy `datasources` constructor option,
so the adapter will use the already-published `options.prismaClient` injection seam exclusively and
will fail clearly when it is absent. Drizzle will translate repository operations into real Drizzle
builder calls using real columns from the supplied table registry; it will no longer construct
placeholder columns or filter, order, paginate, project, or identify rows in memory. No database
contract, capability token, or barrel export changes.

- **In scope:** Prisma v7 injection-only behavior and documentation; a guarded real Prisma import
  proof; Drizzle table/column validation; driver-side Drizzle query construction for all
  `IDataSource` operations; guarded real Drizzle query-generation proof; adapter tests, fixtures,
  README, PUBLIC_API, ROADMAP, and the lockfile where package specifiers change.
- **NOT this milestone:** richer repository filters and `findOne` (M68); programmatic migrations
  (explicitly absent from `IDatabaseAdapter`); a new ORM driver, a database server integration
  suite, and application scaffolding (M67).

## 1. Contracts verified from SOURCE (not names)

| Reference                | Source (file:line)                                                     | Verified surface / fact                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDatabaseAdapter`       | `packages/common/src/services/database.ts:208`                         | The adapter must create per-entity data sources, begin transaction-scoped data sources, and execute raw queries; no migration member exists.         |
| `IDataSource`            | `packages/common/src/services/database.ts:108`                         | `findAll` receives a fully normalized query and is responsible for filtering, ordering, pagination, and projection; CRUD and count are asynchronous. |
| `NormalizedQuery`        | `packages/common/src/services/database.ts:78`                          | `where`, `orderBy`, `limit`, `offset`, and `select` are concrete values, with `-1` meaning unlimited.                                                |
| `BaseRepository`         | `packages/database-plugin/src/repositories/base-repository.ts:51`      | The repository normalizes once then delegates evaluation to the data source; adapters must not rely on it to post-process driver rows.               |
| `DatabasePlugin`         | `packages/database-plugin/src/plugin/database-plugin.ts:67`            | Built-in adapters are constructed with `options`, connected during async registration, and exposed only through `CAPABILITIES.DATABASE`.             |
| `DatabaseAdapterOptions` | `packages/database-plugin/src/interfaces/index.ts:278`                 | `prismaClient`, `drizzleInstance`, and `drizzleTables` already form the injection seams; no new option is necessary.                                 |
| Prisma adapter           | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:252`   | The current non-injected path imports Prisma v7 then passes the invalid legacy `datasources` constructor option.                                     |
| Drizzle adapter          | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:384` | Current reads select all rows and evaluate in memory; update/delete pass a fabricated `{ column: 'id', table }` value to `eq`.                       |
| Current package barrel   | `packages/database-plugin/src/index.ts:12`                             | Existing public symbols remain exported; this milestone adds none and removes none.                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | The README, plugin JSDoc, migration guide, and PUBLIC_API registration example show a Prisma URL-only registration, while the v7 adapter cannot execute that path. | The implementation and docs will require an application-created, generated Prisma v7 client through `options.prismaClient`. `url` remains source-compatible but is deprecated as a Prisma adapter input and is not advertised as a working connection mechanism. | Correct the package README, `DatabasePlugin` JSDoc, migration guide, and PUBLIC_API registration/options notes.                                |
| C2 | `DrizzleAdapter` JSDoc says it wraps a Drizzle instance while its data source evaluates reads in JavaScript and uses a fabricated column for writes.               | The driver query builder is authoritative: every filter, sort, page, projection, primary-key lookup, update, delete, and count uses a real column from `drizzleTables`.                                                                                          | Correct adapter JSDoc, README, and PUBLIC_API Drizzle notes to name the required table registry and supported generated-client injection path. |
| C3 | The M66 ROADMAP text is a current open work item, while the implementation will settle the precise backend behavior.                                               | Preserve the scope statement and flip its tracking row only on completion.                                                                                                                                                                                       | Update the M66 entry and Progress Tracking row during the completion commit.                                                                   |

## 3. Design decisions

### 3.1 Prisma v7 client ownership

- **Decision:** Target Prisma v7 and require `options.prismaClient`; remove the package-level
  `npm:@prisma/client` constructor path. The adapter validates and connects the injected generated
  client without constructing or importing it.
- **Why:** Prisma v7 generates the client to the application-selected output path. A JSR package
  cannot know or import that path, and the v7 constructor rejects the legacy URL override that the
  existing adapter sends. Injection is already public, works with a generated client, and keeps the
  heavyweight client application-owned.
- **Test home:** `test/unit/prisma-adapter.test.ts` proves absent and malformed clients reject
  descriptively; `test/integration/real-import.test.ts` loads the exact Prisma v7 package and proves
  the ungenerated package import has the expected generated-client failure instead of pretending it
  is usable.

### 3.2 Drizzle table and column resolution

- **Decision:** Treat each `drizzleTables[entity]` value as the sole source of real columns. Resolve
  `table.id` for primary-key operations and resolve every field requested by `where`, `orderBy`, and
  `select`; reject a missing column before issuing a driver operation.
- **Why:** Drizzle operators consume actual Column objects, not names or invented objects. The
  committed repository contract hard-codes primary-key operations by `id`, so a registered Drizzle
  table without an `id` column cannot honestly implement it.
- **Test home:** `test/unit/drizzle-adapter.test.ts` covers registered-table validation and each
  missing-column error; `test/integration/real-drizzle-adapter.test.ts` supplies a real `pgTable`
  and proves generated queries name its actual columns.

### 3.3 Drizzle query execution

- **Decision:** Build one Drizzle predicate from equality filters using `eq` and `and`, then apply
  it to select, update, delete, and count reads. Apply ordering through `asc` and `desc`, pagination
  through `limit` and `offset`, and projection through `select({ field: table.field })`. Read
  results from the builder rather than applying any JavaScript transform.
- **Why:** `IDataSource` assigns query evaluation to adapters, and Drizzle exposes each required
  operation through its builder API. One predicate builder prevents query behavior from diverging
  between `findAll` and `count`.
- **Test home:** `test/unit/drizzle-adapter.test.ts` records builder calls with a contract-faithful
  fake; `test/integration/real-drizzle-adapter.test.ts` uses the actual Drizzle operators and proxy
  driver to assert the generated SQL and parameters.

### 3.4 Drizzle write result semantics

- **Decision:** Use the driver’s returning-capable write path and return the driver’s persisted row;
  when a configured Drizzle dialect cannot return a row, throw a descriptive unsupported-operation
  error rather than returning input data or guessing a post-write row.
- **Why:** `IDataSource.create` and `update` promise persisted data, including generated fields.
  Returning input after an insert is a false success, and re-reading arbitrary rows is not an atomic
  substitute.
- **Test home:** `test/unit/drizzle-adapter.test.ts` covers row-return, no-row, and not-found paths;
  `test/integration/real-drizzle-adapter.test.ts` proves generated insert, update, and delete
  statements use the supplied primary-key column.

### 3.5 Real-import proof boundary

- **Decision:** Keep external-driver checks guarded, but make them discriminating. The Prisma test
  probes the exact v7 package and records the generated-client boundary. The Drizzle test
  dynamically imports the exact pinned Drizzle modules, builds a real table and a proxy client, then
  drives the public adapter data-source operations through the real SQL generator.
- **Why:** CI must not require a database server or credentials, but fake operators are incapable of
  detecting the placeholder-column defect. A proxy driver executes the actual Drizzle builder and
  observes its SQL without external I/O.
- **Test home:** `test/integration/real-import.test.ts` and new
  `test/integration/real-drizzle-adapter.test.ts`.

## 4. Exported surface — every symbol names its consumer

No new export is introduced and no existing export is removed. The existing barrel remains
unchanged; the table records the consumers that keep each published group live.

| Exported symbol                                                                                                                                                                                           | Kind                         | Consumer / real code path that READS it                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `DatabasePlugin`                                                                                                                                                                                          | factory                      | Application registration constructs it; its `register` creates and registers the database service. |
| `DatabaseService`                                                                                                                                                                                         | class                        | `DatabasePlugin.register` constructs it.                                                           |
| `BaseRepository`, `UnitOfWork`                                                                                                                                                                            | classes                      | `DatabaseService` constructs repositories and transaction-scoped units of work.                    |
| `MemoryAdapter`, `PrismaAdapter`, `DrizzleAdapter`                                                                                                                                                        | classes                      | `DatabasePlugin` selects built-in adapters; applications may inject or construct them directly.    |
| `PrismaRepository`, `DrizzleRepository`                                                                                                                                                                   | classes                      | Applications can bind an adapter data source to the public repository specializations.             |
| `createPrismaDataSource`, `createDrizzleDataSource`                                                                                                                                                       | functions                    | Applications and adapter transaction factories create a data source for an ORM entity.             |
| `IDatabaseService`, `IRepository`, `IUnitOfWork`                                                                                                                                                          | interfaces                   | Handlers resolve the database capability and type repositories and transactions.                   |
| `DatabasePluginOptions`, `BuiltInDatabaseOptions`, `CustomDatabaseOptions`, `DatabaseConnectionOptions`, `DatabaseAdapterOptions`, `DatabaseAdapterType`, `FindOptions`, `CountOptions`, `OrderDirection` | types                        | Application configuration and repository calls type-check against them.                            |
| `IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`, `NormalizedQuery`                                                                                                                               | re-exported common contracts | External backends and repository implementations consume the shared port.                          |
| `DataSource`                                                                                                                                                                                              | deprecated type alias        | Existing callers retain the historical import while new code uses `IDataSource`.                   |

### 4.1 Options — every option names its consumer

| Option                       | Consumer                             | Behavior (per implementation)                                                                                                    |
| ---------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `DatabasePluginOptions.type` | `DatabasePlugin.createAdapter`       | Chooses memory, Prisma, Drizzle, or custom adapter.                                                                              |
| `name`                       | `DatabasePlugin`                     | Derives the registered token and unique plugin name.                                                                             |
| `options.logQueries`         | `DatabaseService.wrapDataSource`     | Wraps every data-source operation with logger timing when a logger exists.                                                       |
| `options.prismaClient`       | `PrismaAdapter.resolveClient`        | Required Prisma v7 generated-client injection; it is structurally validated and connected.                                       |
| `options.drizzleInstance`    | `DrizzleAdapter.resolveDb`           | Required configured Drizzle driver instance; it is structurally validated.                                                       |
| `options.drizzleTables`      | `DrizzleAdapter` data-source factory | Maps entity names and requested fields to actual Drizzle columns.                                                                |
| `options.transactionTimeout` | `PrismaAdapter.beginTransaction`     | Sets the interactive transaction timeout.                                                                                        |
| `options.url`                | compatibility-only published option  | Retained without a runtime read for source compatibility; its Prisma use is deprecated and every doc points to client injection. |

## 5. Implementation files

| File                                      | Purpose                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/adapters/prisma/prisma-adapter.ts`   | Remove the invalid v7 lazy construction path; require and validate an injected generated client.                                           |
| `src/adapters/drizzle/drizzle-adapter.ts` | Represent the real builder chain, resolve actual columns, construct driver predicates and query builders, and return driver write results. |
| `src/interfaces/index.ts`                 | Correct option JSDoc for Prisma injection, URL compatibility, and the Drizzle table requirements without changing exported shapes.         |
| `src/plugin/database-plugin.ts`           | Correct the public factory example so it passes a generated Prisma client.                                                                 |
| `README.md`                               | Document executable Prisma and Drizzle configuration, including injection and table requirements.                                          |
| `PUBLIC_API.md`                           | Correct DatabasePlugin registration and adapter behavior notes.                                                                            |
| `docs/migration-nestjs.md`                | Replace the non-functional Prisma URL-only migration example.                                                                              |
| `ROADMAP.md`                              | Mark M66 complete only after every verification gate and behavioral proof passes.                                                          |
| `CLAUDE.md`                               | Record M66 completion and advance the Next milestone only in the completion commit.                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                            | src covered                                                               | Key assertions (and the signature each call type-checks against)                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/prisma-adapter.test.ts`                                                                                                                                   | `src/adapters/prisma/prisma-adapter.ts`                                   | `connect(): Promise<void>` rejects without `prismaClient`, accepts a complete injected client, and preserves CRUD, raw-query, and transaction behavior.                                                            |
| `test/unit/prisma-adapter-coverage.test.ts`                                                                                                                          | `src/adapters/prisma/prisma-adapter.ts`                                   | Covers malformed-client validation and all changed error paths to retain ≥90% branch/function/line coverage.                                                                                                       |
| `test/unit/drizzle-adapter.test.ts`                                                                                                                                  | `src/adapters/drizzle/drizzle-adapter.ts`                                 | `IDataSource.findAll`, `findById`, `create`, `update`, `delete`, and `count` build operations with registered columns, surface missing fields, return persisted rows, and preserve transaction/raw-query behavior. |
| `test/unit/drizzle-adapter-coverage.test.ts`                                                                                                                         | `src/adapters/drizzle/drizzle-adapter.ts`                                 | Covers builder branches, no-row write failures, unavailable returning support, and connect-time table validation.                                                                                                  |
| `test/unit/plugin-coverage.test.ts`                                                                                                                                  | `src/plugin/database-plugin.ts`, `src/interfaces/index.ts`                | Registers the Prisma arm with an injected client and retains exact optional-property handling in `buildAdapterOptions`.                                                                                            |
| `test/integration/real-import.test.ts`                                                                                                                               | `src/adapters/prisma/prisma-adapter.ts`                                   | Dynamically imports exact Prisma v7 and proves its generated-client boundary is explicit; the assertion fails if the test hides an import failure as a usable client.                                              |
| `test/integration/real-drizzle-adapter.test.ts`                                                                                                                      | `src/adapters/drizzle/drizzle-adapter.ts`                                 | Dynamically imports exact Drizzle modules, builds a real table and proxy driver, and drives `IDataSource` methods through generated SQL containing the real `id` and requested columns.                            |
| Existing `test/unit/*repository*.test.ts`, `test/unit/adapter-contract.test.ts`, `test/integration/database-plugin.test.ts`, `test/e2e/database-application.test.ts` | Unchanged public repository, adapter alias, plugin, and application paths | Re-run unchanged as regression coverage; no source file is added without a named test above.                                                                                                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m66-database-adapters-that-have-been-executed, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

After committing the implementation, run `deno task publish:check` and
`deno task release:verify 0.1.0-alpha.7`; inspect the real-Drizzle SQL proof and demonstrate its
failure when the old placeholder-column code is restored.

## 8. Risks & mitigations

- Prisma’s generated client cannot be created from a package-global import → require an
  application-injected generated client and make the absence error name that requirement.
- Drizzle drivers differ in supported returning semantics → return an actual driver row when the
  configured driver supports it; reject clearly when it cannot honor the `IDataSource` result
  contract.
- A structural fake can accept an invalid Drizzle expression → use a real table and proxy driver in
  the guarded integration test, and retain unit fakes only for deterministic branch coverage.
- Dynamic npm imports can be unavailable in an offline environment → guard only the real-import
  proof while unit tests cover every decision around the import and configuration boundary.

## 9. Out of scope

- M68 owns widening the equality-only repository-query contract with richer filters and a `findOne`
  operation.
- Supporting a Prisma v7 generated output path discovered by the plugin is not viable: output
  location belongs to the application, so the supported boundary remains `prismaClient` injection.
- A live PostgreSQL or MySQL service suite is not required for this milestone; the real Drizzle
  proxy proof exercises the actual SQL builder without introducing credentials or an external
  server.
