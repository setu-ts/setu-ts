# Milestone 69 — Typed Drizzle Query Seam (`@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m69-typed-drizzle-query-seam`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

> **Code-review correction:** The original single unconstrained return type let a caller type a
> callback-scoped transaction as the full outer database. The shipped design uses overloads: service
> scope returns `TDatabase`, while UoW scope returns `DrizzleTransaction<TDatabase>` derived from
> the configured database's transaction callback parameter. This preserves exact query/result
> inference while excluding outer-only operations such as SQLite Proxy `batch()`.

> **Second code-review correction:** A free `TDatabase` remained forgeable, and the deferred bridge
> was unsafe for synchronous callback drivers. The final API creates one source-owned
> `DrizzleDatabase<TDatabase>` with `createDrizzleDatabase(database)` and requires that same witness
> at every `getDrizzle(scope, witness)` call. The witness correlates inferred type and runtime
> object; another database's witness is rejected. The factory accepts only transaction methods that
> do not permit synchronous callback results, explicitly excluding better-sqlite3/Bun/Expo/OP
> SQLite. An unwrapped structural instance is rejected at startup before a native transaction is
> invoked.

## 0. Objective & scope

Add one explicitly Drizzle-specific, generic accessor that returns the application's own injected
Drizzle database type from the registered `IDatabaseService` and the `IUnitOfWork` supplied to
`IDatabaseService.transaction()`. The outer accessor returns the configured instance; the Unit of
Work accessor returns the callback-scoped Drizzle transaction object, so native joins, aggregations,
relational queries, and other typed Drizzle builders share the same commit/rollback boundary as
repository operations. The portable repository and adapter contracts remain unchanged.

- **In scope:** `createDrizzleDatabase(database)` plus overloaded
  `getDrizzle(scope, databaseWitness)` access for outer services and UoWs;
  `DrizzleTransaction<TDatabase>` derived from the outer database's transaction callback; an
  internal symbol-keyed handle protocol among `DatabaseService`, `UnitOfWork`, and `DrizzleAdapter`;
  explicit wrong-adapter failures; accepting Drizzle SQLite/libsql-shaped instances that do not
  expose `execute`; a descriptive raw-query refusal on such instances; a real SQLite
  transaction/join/rollback proof; compile-time result inference assertions; barrel, README,
  PUBLIC_API, ARCHITECTURE, ROADMAP, CHANGELOG, and status documentation.
- **NOT this milestone:** A portable join/relation AST (a future relation-traversal milestone);
  changes to `IDataSource`, `IDatabaseAdapter`, `IAdapterTransaction`, `IDatabaseService`, or
  `IUnitOfWork`; Prisma relation traversal; Memory/D1 join emulation; transaction configuration,
  nested transaction/savepoint APIs, or migrations; constructing a Drizzle driver for the
  application; a new package dependency or capability token.

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                                                                                     | Verified surface / fact                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITransaction` / `IOrmAdapter`             | `packages/common/src/services/database.ts:14-60`                                                                                                       | `ITransaction` exposes only `commit` and `rollback`; `IOrmAdapter` is lifecycle plus `beginTransaction`, not a native query-handle carrier.                                                                                                                                         |
| `IDataSource`                              | `packages/common/src/services/database.ts:137-207`                                                                                                     | The portable data seam is bound to one entity and contains only `findAll`, `findById`, `create`, `update`, `delete`, and `count`; it cannot honestly model a join.                                                                                                                  |
| `IAdapterTransaction` / `IDatabaseAdapter` | `packages/common/src/services/database.ts:209-281`                                                                                                     | The transaction handle adds only `createDataSource(entity)`; the backend adds non-transactional `createDataSource`, `beginTransaction`, and `rawQuery`. No native ORM instance is exposed.                                                                                          |
| `IUnitOfWork` / `IDatabaseService`         | `packages/database-plugin/src/interfaces/index.ts:98-184`                                                                                              | `IUnitOfWork` declares only `getRepository`; `IDatabaseService.transaction` narrows its callback to that interface. The public raw-query escape is untyped SQL and not transaction-scoped.                                                                                          |
| Drizzle options                            | `packages/database-plugin/src/interfaces/index.ts:283-342`                                                                                             | `drizzleInstance` is injected as `unknown`; `drizzleTables` maps entity names to real table definitions. The package does not construct a dialect-specific driver.                                                                                                                  |
| Drizzle structural boundary                | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:18-61`, `342-371`                                                                    | `DrizzleInstance` currently requires `select`, writes, `execute`, and `transaction`; runtime validation rejects a missing `execute`, which excludes SQLite/libsql drivers even though repository builders do not need it.                                                           |
| Drizzle transaction bridge                 | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:230-286`                                                                             | `beginTransaction` receives Drizzle's native `tx`, closes over it in a returned object, and exposes only a scoped data-source factory plus commit/rollback. The two-deferred bridge keeps the callback open until finalization.                                                     |
| Drizzle raw query                          | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:288-295`                                                                             | `rawQuery` alone requires `instance.execute`; this requirement can be checked at that call without refusing otherwise valid Drizzle instances at startup.                                                                                                                           |
| Database transaction orchestration         | `packages/database-plugin/src/services/database-service.ts:78-100`                                                                                     | `DatabaseService` begins one adapter transaction, constructs one `UnitOfWork`, builds every scoped repository from `txn.createDataSource`, and commits or rolls back that same handle. This is the single place to pass adapter identity into the UoW.                              |
| Concrete Unit of Work                      | `packages/database-plugin/src/unitOfWork/unit-of-work.ts:10-58`                                                                                        | The already-exported class stores the transaction privately as `ITransaction`; it has no native handle accessor. Its public `commit`/`rollback` methods are separate from the interface received by transaction callbacks.                                                          |
| Drizzle real integration precedent         | `packages/database-plugin/test/integration/real-drizzle-adapter.test.ts:10-195`                                                                        | Tests pin `npm:drizzle-orm@0.45.2`; `sqlite-proxy` plus `node:sqlite` already executes real generated SQLite SQL, and comments explicitly record that the current adapter refuses the instance only because it lacks `execute`.                                                     |
| Package barrel                             | `packages/database-plugin/src/index.ts:11-60`                                                                                                          | `getDrizzle` does not exist. `DrizzleInstance` is not a package export, so callers should preserve their actual driver type with `typeof drizzleDb`, not a lossy framework stand-in.                                                                                                |
| Database capability token                  | `packages/common/src/tokens.ts:39-50`, `150-189`                                                                                                       | The canonical token is `database`; named registrations use dot-separated lowercase kebab-case segments. M69 adds no token. Existing `database` and `database.<name>` grammar remains unchanged; colons remain illegal.                                                              |
| Named registration behavior                | `packages/database-plugin/src/plugin/database-plugin.ts:67-87`                                                                                         | Default registration provides `CAPABILITIES.DATABASE`; named instances provide `database.<name>` and derive plugin name `database-plugin.<name>`. The accessor reads a resolved service/UoW and does not create another provider, so duplicate-provider constraints are unaffected. |
| Drizzle transaction API                    | `npm:drizzle-orm@0.45.2`, upstream `drizzle-orm/src/sqlite-proxy/session.ts`                                                                           | The pinned package's SQLite proxy starts with `BEGIN`, hands a typed `SQLiteProxyTransaction` to the callback, then sends `COMMIT` or `ROLLBACK`; query builders on that object use the same session. This supports a real SQLite atomicity proof without a database server.        |
| External package specifiers                | `packages/database-plugin/test/integration/real-drizzle-adapter.test.ts:12-31`, `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:153` | The exact pinned runtime/test specifiers are `npm:drizzle-orm@0.45.2`, `npm:drizzle-orm@0.45.2/sqlite-proxy`, and `npm:drizzle-orm@0.45.2/sqlite-core`; production already lazy-loads `npm:drizzle-orm@0.45.2`. No CLI package or invented alias is needed.                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                                | Doc deliverable (same PR)                                                                                                                 |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md:1264` says database-plugin has “no raw SQL in public API”, while committed `IDatabaseService.query` is public at `packages/database-plugin/src/interfaces/index.ts:151-160` and documented in `PUBLIC_API.md:942-952`.                                                                                                                                                                | Source and PUBLIC_API are authoritative: raw SQL remains a released backend-specific escape hatch; M69 adds a separate typed Drizzle escape hatch and does not pretend these escape hatches are portable repository API.                                | Correct the database-plugin Rules row in `ARCHITECTURE.md` and describe the typed/native boundary.                                        |
| C2 | `ARCHITECTURE.md:1264` says Prisma and Drizzle are both “injected or lazy-loaded”; source requires the application-created Prisma client and injected Drizzle instance. Only Drizzle query operators are lazily imported.                                                                                                                                                                              | Preserve source behavior established by M66: ORM clients/instances are injected; only Drizzle operators load from `npm:drizzle-orm@0.45.2`.                                                                                                             | Correct the database-plugin Rules row in `ARCHITECTURE.md`.                                                                               |
| C3 | `PUBLIC_API.md:858-864`, `packages/database-plugin/README.md:65-78`, and source validation say Drizzle needs an injected instance, but only source reveals the extra `execute` requirement that rejects every SQLite/libsql-shaped instance. ROADMAP requires this milestone to decide rather than inherit it.                                                                                         | Relax startup validation to the builder/transaction methods repository and typed access actually need. Keep `execute` optional and make only `IDatabaseService.query()` fail descriptively when the configured instance lacks it.                       | Document accepted driver shape and raw-query limitation in `PUBLIC_API.md`, `packages/database-plugin/README.md`, and the relevant JSDoc. |
| C4 | `IDatabaseService.migrate` JSDoc at `packages/database-plugin/src/interfaces/index.ts:162-168` claims Prisma db-push, Drizzle schema sync, and Memory no-op, while `DatabaseService.migrate` at `packages/database-plugin/src/services/database-service.ts:119-124` always rejects because adapters deliberately do not expose migrations. `PUBLIC_API.md:949` repeats the method without the refusal. | Preserve implemented M52c behavior: programmatic migrations are unsupported; each ORM owns migrations through its CLI. This milestone does not add migrations.                                                                                          | Correct interface JSDoc and the DatabasePlugin contract note in `PUBLIC_API.md`; add no migration code.                                   |
| C5 | ROADMAP asks for “a typed accessor returning the Drizzle instance” but its existing `DrizzleInstance` structural stand-in erases join-result inference.                                                                                                                                                                                                                                                | The exported service overload returns the caller-supplied application type; the UoW overload returns its structurally derived callback transaction type. The internal structural stand-in remains internal and is never exported as either result type. | Add exact overloads, `DrizzleTransaction<TDatabase>`, examples, and inference explanation to `PUBLIC_API.md` and the package README.      |

## 3. Design decisions

### 3.1 One overloaded accessor with a correlated typed witness

- **Decision:** Export `createDrizzleDatabase(database)` and service/UoW overloads of
  `getDrizzle(scope, databaseWitness)`. The service overload returns `TDatabase`; the UoW overload
  returns `DrizzleTransaction<TDatabase>`, which structurally derives the first parameter of the
  configured database's transaction callback. Applications create one witness beside plugin
  configuration and pass it at both call sites. Both results preserve the application's
  schema/dialect inference, while the UoW result excludes outer-only operations such as SQLite
  Proxy's `batch()`. Do not export or return the adapter's structural `DrizzleInstance` type, and do
  not add a second outer/UoW helper.
- **Second-review correction:** The final overloads infer `TDatabase` from the required
  `DrizzleDatabase<TDatabase>` witness created by `createDrizzleDatabase(database)`, rather than
  accepting a free generic. The adapter stores the witness's exact runtime object and every scope
  carries that identity with its query object. A mismatched witness throws. This is the smallest
  public correction that makes compile-time/runtime identity correlated without casts.
- **Why:** The service registry token cannot carry an application-specific generic, and changing the
  committed portable interfaces to mention Drizzle would break direct implementors or make an
  optional method that contradicts the required throw. One explicitly generic helper keeps the
  backend-specific escape hatch in the owning plugin, accepts both committed interface types, and
  gives application code an exact source-owned witness without widening common. Deriving the
  callback parameter and inferring it through the witness prevents callers from selecting the
  complete outer database type for a transaction object whose runtime surface is narrower.
- **Test home:** `packages/database-plugin/test/unit/drizzle-query.test.ts` asserts outer identity,
  transaction identity, and failures;
  `packages/database-plugin/test/integration/drizzle-query-sqlite.test.ts` uses
  `assertType<IsExact<...>>` on a real joined result.

### 3.2 Internal symbol protocol, not a common-contract widening or mutable global

- **Decision:** Add a non-barrel-exported `DRIZZLE_QUERY_HANDLE` symbol and internal provider type
  in `query/drizzle-query.ts`. `DatabaseService` and `UnitOfWork` implement the symbol-keyed read
  path; `DrizzleAdapter` and each returned Drizzle transaction handle supply the native object
  behind the same internal symbol. `getDrizzle` is the only public reader and narrows structurally
  before invoking it. No `WeakMap`, module-global registry, public class member, or `common` field
  is added.
- **Why:** This passes the exact callback-scoped object without exposing it through
  `IAdapterTransaction`, avoids mutable hidden global state and garbage-lifetime questions, and
  keeps the internal mechanism unnameable from the package barrel. The same provider route serves
  outer and transactional access, so the two entry points cannot drift.
- **Test home:** `drizzle-query.test.ts`, `database-service.test.ts`, `unit-of-work.test.ts`, and
  `drizzle-adapter.test.ts` assert the protocol through the exported helper rather than importing
  the symbol from application-style tests.

### 3.3 Wrong adapter and invalid-scope behavior is always a named throw

- **Decision:** `DatabaseService` passes its configured `DatabaseAdapterType` into every
  `UnitOfWork`. Both provider implementations check it before reading a handle. Prisma, Memory, and
  Custom services/UoWs throw
  `Drizzle query access requires adapter 'drizzle'; configured adapter is '<type>'.` A structural
  `IDatabaseService` or `IUnitOfWork` not created by this package throws
  `Drizzle query access requires a database-plugin service or unit of work.` Never return
  `undefined`, and never guess that a custom adapter wrapping Drizzle is the built-in Drizzle arm.
- **The adapter type reaches `UnitOfWork` as an OPTIONAL third constructor parameter, and that is a
  released-API constraint rather than a style choice.** `UnitOfWork` is exported from the package
  barrel (`packages/database-plugin/src/index.ts:51`) and is a documented public class
  (`PUBLIC_API.md:1045`), so its constructor is released surface: a REQUIRED third parameter would
  break every external `new UnitOfWork(transaction, repoFactory)` call, which AI_GUIDELINES §9.4
  forbids doing silently. `DatabaseService` always supplies it — it already stores `_adapterType`
  (`packages/database-plugin/src/services/database-service.ts:57`), so no new plumbing is needed at
  the service end. A `UnitOfWork` constructed WITHOUT it (only reachable by an external caller
  building one directly) is not a plugin-created scope, so `getDrizzle` throws the SAME
  invalid-scope error as an external structural fake — deliberately not the wrong-adapter error,
  which would name a configured adapter that was never configured. The added optional parameter is a
  CHANGELOG entry under Added, not a breaking change.
- **Why:** The failure points to configuration instead of producing a later `undefined.select`
  error. A `'custom'` adapter promises only `IDatabaseAdapter`; treating its private implementation
  as Drizzle would invent an unsupported contract.
- **Test home:** `drizzle-query.test.ts` covers service and UoW failures for all three non-Drizzle
  adapter labels plus an external structural fake; `database-application.test.ts` exercises the
  public service-registry path.

### 3.4 Relax `execute` only at the startup boundary

- **Decision:** Make `DrizzleInstance.execute` optional and remove it from `validateInstance`'s
  required-method list. Keep `select`, `insert`, `update`, `delete`, and `transaction` required.
  `DrizzleAdapter.rawQuery` checks `execute` at call time and rejects with
  `Configured Drizzle instance does not support raw execute(); use Drizzle's typed query builder for this driver.`
  when absent. Existing instances with `execute` preserve current raw-query behavior.
- **Why:** Repository operations, transactions, and the new typed seam use builders rather than
  `execute`. Rejecting a fully usable SQLite/libsql instance at `connect()` makes the new seam dead
  for the ROADMAP's required real-SQLite proof. Moving the check to its sole consumer follows
  interface segregation without weakening any operation that actually needs the method.
- **Test home:** `drizzle-adapter.test.ts` proves connect and repository/transaction use without
  `execute`, raw-query refusal without it, and unchanged raw-query output with it;
  `drizzle-query-sqlite.test.ts` boots the real SQLite proxy through `DrizzleAdapter` with no cast.

### 3.5 Real transaction proof and compile-time inference are separate acceptance properties

- **Decision:** Build an in-memory `node:sqlite` database and a real
  `npm:drizzle-orm@0.45.2/sqlite-proxy` instance with two `sqliteTable` definitions. Inside
  `IDatabaseService.transaction`, create a row through a UoW repository, obtain the native
  transaction with `getDrizzle(uow, databaseWitness)`, execute a typed `innerJoin`, and assert the
  uncommitted row is visible. Throw a sentinel, then query through the outer typed handle and assert
  the repository write is absent. In the same test module, use `@std/testing/types` `assertType` and
  `IsExact` to require the awaited join result to equal the selected application row type.
- **Why:** A fake can record that two methods were called but cannot prove transaction visibility or
  rollback. Runtime SQL alone cannot prove that the public helper retained Drizzle's inferred result
  type; both properties are the milestone's substance.
- **Test home:** `packages/database-plugin/test/integration/drizzle-query-sqlite.test.ts`.

### 3.6 Public surface, dependencies, tokens, and lifecycle stay narrow

- **Decision:** The new package-barrel values are `createDrizzleDatabase` and `getDrizzle`; the
  accompanying type-only exports are `DrizzleDatabase` and `DrizzleTransaction`. Add no option,
  class, error export, capability token, manifest export, dependency, health behavior, or lifecycle
  hook. The one change to existing released surface is the OPTIONAL third `UnitOfWork` constructor
  parameter from §3.3; every existing call shape keeps compiling and behaving identically. Continue
  the existing exact production import `npm:drizzle-orm@0.45.2`. Test specifiers stay as they are
  today and are NOT silently re-pinned: `real-drizzle-adapter.test.ts` uses the exact
  `npm:drizzle-orm@0.45.2` plus its `sqlite-proxy`/`sqlite-core` subpaths, while the guarded
  `real-import.test.ts` deliberately uses the RANGE `npm:drizzle-orm@^0.45.2`, since it exists to
  prove a real installed package resolves rather than to pin a build. Existing default/named plugin
  names and `database` / `database.<name>` tokens are byte-identical.
- **Why:** Every proposed extra surface would have no independent consumer. The application already
  owns the instance and table schema; the missing capability is only access to the transaction's
  typed native object.
- **Test home:** `barrel-exports.test.ts`, existing `plugin.test.ts`, and `database-plugin.test.ts`
  pin the one-symbol addition and unchanged registration behavior.

### 3.7 Promise-aware transaction policy

- **Decision:** `createDrizzleDatabase()` accepts only database types whose transaction method does
  not accept a callback returning a non-Promise marker. This includes the supported SQLite Proxy,
  libsql, and PostgreSQL-style asynchronous callbacks and excludes the pinned better-sqlite3, Bun
  SQLite, Expo SQLite, and OP SQLite declarations, which return callback results synchronously.
  `DrizzleAdapter.connect()` additionally requires the source-owned witness shape, so untyped raw
  configuration is rejected before transaction work. At `beginTransaction()`, returning the exact
  callback Promise proves a synchronous implementation; the adapter rejects before returning a UoW
  handle, so even deliberately wrapped JavaScript cannot run application work after native commit.
- **Why:** The imperative adapter contract cannot safely hold a synchronous native callback open
  while later UoW work awaits. Returning the deferred Promise from such a callback commits before
  that work starts. Explicit refusal is therefore the only robust contract-compatible strategy.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                | Kind             | Consumer / real code path that READS it                                                                                                                                                                |
| ---------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createDrizzleDatabase(database)`              | generic function | Application startup creates the source-owned identity/type witness accepted by Drizzle configuration and both accessor overloads; synchronous callback driver types fail this call.                    |
| `getDrizzle(scope, databaseWitness)` overloads | generic function | Application query code passes the configured witness to run typed outer or transaction-scoped joins/aggregates; the real SQLite integration drives both scopes and proves their distinct static types. |
| `DrizzleDatabase<TDatabase>`                   | interface        | Configuration and accessor arguments correlate the exact inferred type with the runtime object identity.                                                                                               |
| `DrizzleTransaction<TDatabase>`                | type alias       | The UoW overload and application type annotations derive Drizzle's callback transaction type without a production Drizzle import.                                                                      |

No existing package export is removed, renamed, or retyped. The exported `UnitOfWork` class gains
one OPTIONAL constructor parameter (§3.3), which is source-compatible with every existing call.
`DrizzleInstance`, `DRIZZLE_DATABASE`, `DRIZZLE_QUERY_HANDLE`, and the provider type remain internal
and are deliberately absent from `src/index.ts`.

### 4.1 Options — every option names its consumer

| Option                                            | Consumer                                                                    | Behavior (per implementation)                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None added (checked)                              | Not applicable                                                              | `getDrizzle` reads the existing `DatabaseAdapterOptions.drizzleInstance`; its value is now a typed witness rather than a raw instance.                                           |
| Existing `DatabaseAdapterOptions.drizzleInstance` | `DrizzleAdapter.resolveDb` and, through its internal provider, `getDrizzle` | Required for `type: 'drizzle'`; the witness's concrete application type is returned unchanged by the outer accessor, and its callback transaction type is returned inside a UoW. |
| Existing `DatabaseConnectionOptions.name`         | `DatabasePlugin` only                                                       | Registration remains `database` for default and `database.<name>` for named connections; it does not affect accessor behavior after the service is resolved.                     |

## 5. Implementation files

| File                                                               | Purpose                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database-plugin/src/query/drizzle-database.ts`           | Define the cycle-free typed witness, synchronous-driver compile-time guard, and package-private configured-database identity key.                                                                                                                             |
| `packages/database-plugin/src/query/drizzle-query.ts`              | Define documented public `getDrizzle` overloads and `DrizzleTransaction`, re-export the witness factory/type, and implement the internal query-handle protocol, narrowing, and stable error messages.                                                         |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts` | Supply outer and transaction-scoped native handles; make `execute` optional at validation and guard only `rawQuery`.                                                                                                                                          |
| `packages/database-plugin/src/services/database-service.ts`        | Supply the service-level handle, pass adapter identity to UoWs, and keep transaction orchestration on the existing handle.                                                                                                                                    |
| `packages/database-plugin/src/unitOfWork/unit-of-work.ts`          | Supply the UoW-level handle and produce named wrong-adapter failures without widening `IUnitOfWork`; accept the adapter type as an OPTIONAL third constructor parameter, because this class is released public surface (§3.3).                                |
| `packages/database-plugin/src/interfaces/index.ts`                 | Correct the false `migrate()` JSDoc and type the existing Drizzle configuration slot as the source-owned witness.                                                                                                                                             |
| `packages/database-plugin/src/index.ts`                            | Export both witness/accessor values and both accompanying public types.                                                                                                                                                                                       |
| `packages/database-plugin/README.md`                               | Document witness creation, typed outer/UoW examples, SQLite/libsql acceptance, synchronous-driver refusal, raw-query limitation, and exports.                                                                                                                 |
| `PUBLIC_API.md`                                                    | Add the exact helper signature, transaction join example, failure behavior, driver shape, and migration truth; update the export table.                                                                                                                       |
| `ARCHITECTURE.md`                                                  | Correct the database-plugin dependency/escape-hatch rules and describe why the seam is Drizzle-specific rather than portable.                                                                                                                                 |
| `ROADMAP.md`                                                       | On completion, mark M69 complete and retain the relation-traversal deferral.                                                                                                                                                                                  |
| `CLAUDE.md`                                                        | On completion, add the M69 Current status evidence summary and repoint Next milestone to M40.                                                                                                                                                                 |
| `CHANGELOG.md`                                                     | Record the additive typed Drizzle accessor, the newly accepted no-`execute` Drizzle driver shape, and `UnitOfWork`'s optional third constructor parameter — all under Added, since none of the three breaks an existing call; state the raw-query limitation. |

### 5.1 Implementation sequence

1. Add the cycle-free witness module and `query/drizzle-query.ts` with the internal protocol,
   correlated generic accessor, and exact failures.
2. Teach `DrizzleAdapter` to provide outer/transaction handles and separate builder validation from
   raw `execute` capability.
3. Thread the existing adapter type into `UnitOfWork`; implement service/UoW provider methods while
   leaving committed interfaces unchanged.
4. Export `createDrizzleDatabase`, `getDrizzle`, `DrizzleDatabase`, and `DrizzleTransaction`; add
   JSDoc and the barrel assertion before writing application examples.
5. Add unit tests for identity, all wrong-adapter paths, external fakes, missing `execute`, and
   unchanged existing-driver behavior.
6. Add the real SQLite join/visibility/rollback and compile-time exact-result proof.
7. Ship C1-C5 documentation corrections, examples, changelog, tracking updates, and plan archival
   only when implementation and verification are complete.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                                                                                                                   | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database-plugin/test/unit/drizzle-query.test.ts`               | `query/drizzle-database.ts`, `query/drizzle-query.ts`                                                                         | `getDrizzle(service, witness)` returns the identical outer object; the UoW call returns the identical transaction object; a mismatched witness throws; Memory/Prisma/Custom errors name their configured adapter on service and UoW paths; an external `IDatabaseService`/`IUnitOfWork` fake gets the invalid-scope error; no call returns `undefined`.                                                                                |
| `packages/database-plugin/test/unit/drizzle-adapter.test.ts`             | `adapters/drizzle/drizzle-adapter.ts`                                                                                         | A structurally valid no-`execute` instance connects, opens a transaction, and exposes the exact native objects through the public helper path; `rawQuery<T>` rejects descriptively without `execute`; an instance with `execute` retains params/result behavior; all existing validation/commit/rollback branches remain covered.                                                                                                      |
| `packages/database-plugin/test/unit/database-service.test.ts`            | `services/database-service.ts`                                                                                                | Service handle access preserves identity and closed/transaction behavior; one adapter transaction still backs UoW repositories and native handle; callback success commits once and failure rolls back once. Calls type-check against unchanged `IDatabaseService.transaction<T>((uow: IUnitOfWork) => Promise<T>)`.                                                                                                                   |
| `packages/database-plugin/test/unit/unit-of-work.test.ts`                | `unitOfWork/unit-of-work.ts`                                                                                                  | Drizzle UoW exposes its transaction handle; all non-Drizzle labels throw the exact configured-adapter error; a UoW constructed with the pre-M69 two-argument shape still compiles, still serves repositories, and throws the INVALID-SCOPE error (never the wrong-adapter one, which would name an adapter nobody configured); repository factory and finalization guards remain unchanged. Calls type-check through the UoW overload. |
| `packages/database-plugin/test/unit/barrel-exports.test.ts`              | `index.ts`, `interfaces/index.ts`                                                                                             | The barrel exports the witness factory/type, accessor/transaction type, and all previously documented symbols; internal identity/query symbols, provider type, and structural `DrizzleInstance` do not leak. The corrected migration contract remains a doc-only change.                                                                                                                                                               |
| `packages/database-plugin/test/integration/drizzle-query-sqlite.test.ts` | `query/drizzle-query.ts`, `adapters/drizzle/drizzle-adapter.ts`, `services/database-service.ts`, `unitOfWork/unit-of-work.ts` | Real `npm:drizzle-orm@0.45.2/sqlite-proxy` over `node:sqlite` boots through the adapter without `execute`; a repository write is visible to a typed `innerJoin` inside the same UoW; a thrown sentinel rolls both back; outer access sees no row. `assertType<IsExact<Awaited<typeof joined>, ExpectedJoinRow[]>>(true)` proves exact selected-result inference rather than `unknown`/the structural stand-in.                         |
| `packages/database-plugin/test/e2e/database-application.test.ts`         | Public database package path                                                                                                  | A real kernel app resolves `IDatabaseService` from `CAPABILITIES.DATABASE`, obtains the outer handle, and runs a typed query; wrong-adapter resolution through the same public token names `memory`. Existing health and close behavior remain intact.                                                                                                                                                                                 |
| `packages/database-plugin/test/integration/real-import.test.ts`          | Production lazy import branch in `adapters/drizzle/drizzle-adapter.ts`                                                        | Unchanged by this milestone. It keeps loading the RANGE `npm:drizzle-orm@^0.45.2` (its existing specifier, deliberately not the exact production pin — it proves an installed package resolves); pure success/failure branching remains unit-covered rather than relying on a skip. No new external dependency loader is added.                                                                                                        |

### 6.1 Acceptance criteria

- `getDrizzle(databaseService, databaseWitness)` returns the exact injected outer instance.
- Inside `IDatabaseService.transaction`, `getDrizzle(uow, databaseWitness)` returns Drizzle's native
  callback transaction and a join sees repository writes made earlier in that same transaction.
- Throwing after the join rolls back the repository write; the outer handle proves it is absent.
- The real join's selected row type is exactly compile-time asserted at the documented
  `getDrizzle(scope, databaseWitness)` call shape, and is not `unknown`, `Record<string, unknown>`,
  or the internal `DrizzleInstance` stand-in. The service overload is exactly the configured outer
  type; the UoW overload is exactly `DrizzleTransaction<typeof drizzleDb>`, and a compile-time
  negative assertion proves SQLite Proxy's outer-only `batch()` is unavailable there. A second
  negative assertion proves an explicit forged database generic cannot reuse the honest witness.
- Memory, Prisma, Custom, and external structural scopes throw descriptive errors; none return
  `undefined`.
- A `UnitOfWork` built with the pre-M69 two-argument constructor still compiles and still serves
  repositories; only `getDrizzle` on it fails, with the invalid-scope error.
- A Drizzle SQLite/proxy instance with builders and `transaction` but no `execute` connects and uses
  repositories/native queries; only raw `IDatabaseService.query` rejects, while existing
  `execute`-capable instances remain behavior-identical.
- No `common` contract, capability token, plugin provider name, manifest export, or dependency is
  added; only the witness/accessor values and accompanying types join the package barrel, and the
  only change to existing released surface is `UnitOfWork`'s optional third constructor parameter.
- Every changed/new `src` file is at least 90% branch, function, and line coverage, with the public
  helper fully covered; docs and source agree on migrations, raw SQL, injection, and driver shape.

## 7. Verification gates

Plan gate during this Architect pass:

```bash
git branch --show-current   # MUST print feat/m69-typed-drizzle-query-seam, never main
deno task check:plan        # this plan lints clean
```

Implementation gates before completion:

```bash
git branch --show-current
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
deno task audit
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/database-plugin/src
```

Read the ANSI-stripped per-file table manually: every `packages/database-plugin/src` file must be at
least 90% on branch, function, and line; the command exit code is not evidence. The forbidden
construct grep must be empty (comments excepted). Run the real SQLite integration without a guard or
skip, and demonstrate its negative control by temporarily returning the outer instance for a UoW:
the uncommitted visibility/rollback test must fail, then pass after restoration.

Because this milestone changes a package, after committing the implementation tree run:

```bash
deno task publish:check
deno task release:verify 0.1.0-alpha.7
```

Both publish gates must exit 0 on the committed tree. Before reporting completion, update the M69
ROADMAP/CLAUDE status in the same branch, archive this single plan to
`plans/archive/milestone-69-typed-drizzle-query-seam.md`, and report the per-file coverage table,
empty grep, real SQLite behavioral evidence, and both publish-gate statuses. Do not push or open a
PR unless the maintainer explicitly asks in that turn.

## 8. Risks & mitigations

- TypeScript cannot derive an application database type through a string capability token. Mitigate
  by documenting only `typeof drizzleDb`, proving the service result and derived UoW transaction
  with `IsExact`, negatively asserting that the UoW excludes outer-only operations, returning the
  actual object identity, and never exporting a broad framework stand-in that appears safer than it
  is.
- A transaction accessor could accidentally return the outer database and silently escape rollback.
  Mitigate with one symbol provider on the adapter transaction itself and a real visibility plus
  rollback test whose outer-handle substitution is a required negative control.
- Relaxing `execute` could move a startup error to production traffic. Mitigate by relaxing only the
  method repository/native builders do not consume and rejecting at the sole raw-query call with an
  operation-specific message; existing `execute` paths retain regression coverage.
- Symbol-keyed members on exported concrete classes could leak through generated docs. Mitigate by
  keeping the symbol out of the barrel, adding a barrel negative assertion, and running
  `publish:check`/`deno doc` gates on the committed tree.
- A proxy fake could reproduce SQL strings but not transaction semantics. Mitigate by executing all
  statements against one real `DatabaseSync(':memory:')` engine and asserting both uncommitted
  visibility and post-rollback absence.
- Existing database docs contain stale claims adjacent to the new seam. Mitigate by shipping C1-C5
  as named deliverables rather than adding an example beside contradictions.
- Threading adapter identity into a class that is already published could break external callers
  silently — `UnitOfWork` is barrel-exported and documented, so its constructor is released surface.
  Mitigate by making the parameter optional, keeping the pre-M69 two-argument construction fully
  working under test, and routing a UoW built without it to the invalid-scope error rather than
  inventing a configured-adapter name (§3.3).

## 9. Out of scope

- Portable relation traversal, join ASTs, eager-loading contracts, and Memory/D1 relation registries
  belong to a future relation-traversal milestone; Prisma's declared-relation API cannot implement
  arbitrary SQL joins honestly.
- Drizzle aggregation helpers, join wrappers, query DTOs, and schema registration are not added: the
  returned application-owned Drizzle instance already supplies all of them with stronger types.
- Custom adapters are not auto-unwrapped even if they internally use Drizzle; a future custom-native
  handle protocol would require a backend-neutral contract and explicit approval.
- Raw SQL transaction scoping, nested/savepoint control, transaction isolation options, and
  programmatic migrations remain separate contract decisions.
- No live PostgreSQL, libsql, Turso, or D1 service is required; real SQLite establishes transaction
  semantics locally, while the existing pg-proxy suite continues to establish PostgreSQL SQL
  generation.
