# Milestone 105 — Conditional writes on `IRepository` (`@setu-ts/database-plugin`, `@setu-ts/common`, `@setu-ts/cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m105-conditional-writes`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

A write that applies only while an equality predicate still holds on the row, so a check and the
write it guards are one operation rather than two. `IRepository` gains
`updateWhere(id, where, data)` and `deleteWhere(id, where)`; each backend runs them as ONE native
conditional operation, and a backend that cannot do so for a given data source omits the member, so
the repository refuses by name. Never an emulated check-then-write: that reproduces the defect this
milestone closes. The three first-party callers that document a check-then-write race (the M101c
tenant bridge, the M107 outbox store's transitions, the M108 inbox store's failure count and
release) switch over and keep their current two-call path only where the bound data source cannot
offer the member.

- **In scope:**
  - `WritePrecondition` and `writePreconditionProblem()` in `common`; optional `updateWhere?` /
    `deleteWhere?` on `IDataSource` (`common`) and on `IRepository` (`database-plugin`).
  - Native implementations on every built-in data source that can express the write atomically:
    memory, Prisma, Drizzle, MongoDB, DynamoDB, Cosmos DB, Bigtable (`database-plugin`) and D1
    (`cloudflare-plugin`), each on its non-transactional data source, plus the interactive-
    transaction data sources (Prisma, Drizzle, MongoDB).
  - `BaseRepository` implementations that refuse by name when the bound data source lacks the
    member, and `DatabaseService.wrapDataSource` forwarding both members (logged and classified).
  - One internal fallback helper used by the three stores; the tenant bridge, outbox store and inbox
    store switched over.
  - A per-adapter conformance table, negative controls reproducing the M101c race, and real-backend
    cases on every backend CI runs.
- **NOT this milestone:**
  - **Conditional writes inside a deferred-write transaction** (memory overlay, D1 batch, DynamoDB
    `TransactWriteItems`, Cosmos batch, Bigtable buffered row). The member is omitted there (§3.5).
    A commit-time condition (DynamoDB's per-item `ConditionExpression`, Cosmos batch `ifMatch`) is a
    different contract — the outcome is known only at commit, so the call cannot return it. **Not
    owned by the framework** (C4): in ASP.NET Core and NestJS this is an ORM feature (EF Core
    concurrency tokens at `SaveChanges`, TypeORM `@VersionColumn`, MikroORM `version` at `flush()`),
    and an application needing it uses its ORM through the existing seams
    (`getDrizzleDatabase`/`getDrizzleTransaction`, the application-supplied Prisma client, the
    injected document-store clients).
  - **Non-equality predicates** (`FilterExpression`, `IS NULL`, ranges). Equality on scalar
    `string`/`number` values covers every in-repo consumer. **Not owned by the framework** (C4), for
    the same reason: EF Core's `ExecuteUpdateAsync` with an arbitrary `Where`, TypeORM's query
    builder and MikroORM's `nativeUpdate` are where that lives.
  - **The outbox relay's fencing and multi-relay sweeping.** This milestone makes each outbox
    transition conditional on its expected status, which stops a stale relay regressing a row but
    not publishing it. A relay-instance fence and several relays at once are **M107b** (C5), which
    depends on this milestone.
  - **Making the members required.** Not planned: they stay optional permanently (§4).

## 1. Contracts verified from SOURCE (not names)

Line numbers are against `develop` at `864adfdf`. Each external backend fact marked _probed_ was
measured for this plan on 2026-10-10 against the local containers (PostgreSQL 16, the Bigtable
emulator, the Cosmos vnext emulator); the probe scripts are scratch and are not committed.

| Reference                                    | Source (file:line)                                                                                                                         | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDataSource`                                | `packages/common/src/services/database.ts:203`                                                                                             | Lives in **`common`** (M52c). Six required members; `update` (`:241`) throws on a missing key; `delete` (`:253`) answers `false`. `findPage?` (`:268`) is the precedent for an optional member whose absence means "cannot", refused by the repository.                                                                                                                                                                                               |
| Deferred-write transactions                  | `packages/common/src/services/database.ts:194-199`                                                                                         | The contract already states a transaction-scoped source may buffer writes and apply them at commit, with reads observing committed state.                                                                                                                                                                                                                                                                                                             |
| `EntityKey`                                  | `packages/common/src/services/database.ts:124`                                                                                             | `string \| number \| Readonly<Record<string, string \| number>>`; the key parameter type of every new member.                                                                                                                                                                                                                                                                                                                                         |
| `IRepository`                                | `packages/database-plugin/src/interfaces/index.ts:74`                                                                                      | Lives in **`database-plugin`**, not `common`. Members: `findById`, `findAll`, `findOne`, `create`, `update` (`throws` when absent), `delete`, `exists`, `count`, `findPage` (required since 0.2.0).                                                                                                                                                                                                                                                   |
| `BaseRepository`                             | `packages/database-plugin/src/repositories/base-repository.ts:48`, `:130-160`                                                              | Abstract class implementing `IRepository` over a `DataSource`. `findPage` refuses with `UnsupportedQueryFeatureError('cursor-pagination', …)` when `this._dataSource.findPage === undefined`, read without detaching the method.                                                                                                                                                                                                                      |
| `UnsupportedQueryFeatureError`               | `packages/database-plugin/src/errors.ts:290`                                                                                               | `(feature, adapter, message, options?)`; `feature` is a released field. Branded `501` only when `feature` is in `QUERY_SHAPE_FEATURES` (`:99`), which already holds `'cursor-pagination'`.                                                                                                                                                                                                                                                            |
| `DatabaseService.wrapDataSource`             | `packages/database-plugin/src/services/database-service.ts:433`, `:450`                                                                    | Wraps every data source unconditionally (classification + optional logging). Spreads own enumerable members, then overrides the six required ones; `findPage` is bound explicitly (`ds.findPage?.bind(ds)`) because a prototype member would otherwise be dropped.                                                                                                                                                                                    |
| `DrizzleAdapter.#countingCompletions`        | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:562`                                                                     | Second wrapper: re-creates every member found by `Object.entries(source)`. Carries a new member only because the inner Drizzle source is an object literal (own enumerable).                                                                                                                                                                                                                                                                          |
| `DatabaseTenantDataStore.update` / `.delete` | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts:247`, `:277`                                                           | `#ownedRow` (`findById` + tenant-column compare) then `repo.update(id, stripped)` / `repo.delete(id)`; the after-check at `:268` throws but the write has landed. Class JSDoc `:28-39` names M105 as the fix.                                                                                                                                                                                                                                         |
| Outbox store transitions                     | `packages/database-plugin/src/outbox/database-outbox-store.ts:252`, `:272`, `:295`                                                         | `markSent` / `markFailure` read the row, require `status === 'pending'`, then `update`/`delete` by id; `release` requires `'failed'`. `#find` (`:212`) treats a row of another `kind` as missing.                                                                                                                                                                                                                                                     |
| Inbox store failure count / release          | `packages/database-plugin/src/inbox/database-inbox-store.ts:220`, `:253`, `:284`                                                           | `#increment` reads `attempts`, writes `attempts + 1` by id (two calls); `release` reads, requires `'parked'`, then deletes or updates by id.                                                                                                                                                                                                                                                                                                          |
| Memory data source                           | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:828`, `:852`, `:632`                                                       | `updateEntity` / `deleteEntity` run with **no `await`** between find and write, so a sync check + write is atomic. The transaction overlay (`:632`) buffers and applies at commit — deferred.                                                                                                                                                                                                                                                         |
| `matchesWhere`                               | `packages/database-plugin/src/query/query-builder.ts:127`                                                                                  | `entity[key] !== expected` → `false`; strict equality, absent field never matches.                                                                                                                                                                                                                                                                                                                                                                    |
| Prisma model delegate                        | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:140`, `:813`, `:834`                                                       | Facade `update({ where, data })` / `delete({ where })`; `P2025` maps to not-found. _Probed_ on Prisma 7.10.0 + PostgreSQL 16: `update`/`delete` with `where: { id, userId }` emit ONE `UPDATE … WHERE (id = $2 AND "userId" = $3) RETURNING …` / `DELETE … RETURNING`; a non-matching predicate answers `P2025` and writes nothing. No facade change needed.                                                                                          |
| Drizzle data source                          | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:748`, `:762`, `:960`                                                     | `update`/`delete` build `eq` key predicates and `.returning()`; `predicateFor(table, entity, where, operators)` already compiles an equality map and throws on an unknown column (`columnFor`).                                                                                                                                                                                                                                                       |
| MongoDB data source                          | `packages/database-plugin/src/adapters/mongo/mongo-data-source.ts:126`, `:272`, `:283`                                                     | `buildIdFilter` + `findOneAndUpdate(filter, { $set }, { returnDocument: 'after' })` (null → missing); `deleteOne(filter)` → `deletedCount`. The same factory serves the session-bound transaction source (`MongoTransaction.createDataSource`, `:679`).                                                                                                                                                                                               |
| DynamoDB data source / facade                | `…/dynamo/dynamo-data-source.ts:224-305`; `…/dynamo/dynamo-client-types.ts:126`, `:144`                                                    | `update` sends `ConditionExpression: attribute_exists(pk)` with `ReturnValues: 'ALL_NEW'`; `delete` sends no condition. `DynamoUpdateItemCommandInput` and `DynamoDeleteItemCommandInput` both extend `DynamoConditionExpression` — the facade already carries a condition.                                                                                                                                                                           |
| Cosmos facade + replace path                 | `…/cosmos/cosmos-client-types.ts:109-128`, `:286-309`; `…/cosmos/cosmos-data-source.ts:453-474`, `:493`                                    | `replace(body, options?)` accepts `accessCondition: { type: 'IfMatch', condition: <_etag> }` and the data source already uses it; the facade's `delete()` takes **no options**. _Probed_ on the vnext emulator: `delete({ accessCondition: IfMatch })` with a stale `_etag` answers `412` and leaves the item; after delete-and-recreate under the same id, both `replace` and `delete` guarded by the original `_etag` answer `412`.                 |
| Bigtable row write                           | `…/bigtable/bigtable-client-types.ts:132-146`, `:187-200`; `…/bigtable/bigtable-scan.ts:368`; `…/bigtable/bigtable-data-source.ts:321-381` | `conditionalMutate(test, { onMatch })` is CheckAndMutateRow; `BigtableFilter` has a `condition: { test, pass? }` arm; `valueTest(target, field, value)` (internal) builds the byte-exact family/qualifier/value chain, `null` for an unaddressable field. _Probed_ on the emulator: a nested `condition { test: A, pass: B }` matches only when both columns hold their values; a missing column and an absent row answer `false` and create nothing. |
| D1 data source / SQL builders                | `packages/cloudflare-plugin/src/database/d1-sql.ts:340`, `:377`; `…/d1-data-source.ts:206`, `:320`                                         | `buildUpdate` → `UPDATE … SET … WHERE <key> RETURNING *`; `buildDelete` → `DELETE … WHERE <key> RETURNING <pk>`; `assertParamBudget` caps bound parameters. `createD1TransactionDataSource` buffers into a `batch()` — deferred.                                                                                                                                                                                                                      |
| Transaction data-source factories            | `…/prisma/prisma-adapter.ts:316`; `…/drizzle/drizzle-adapter.ts:479`; `…/mongo/mongo-data-source.ts:679`                                   | Prisma, Drizzle and MongoDB build the transaction-scoped source from the SAME factory as the plain one, over the transaction client / `tx` / session — so a member added to the factory is present in their transactions with no extra code.                                                                                                                                                                                                          |
| Versioning policy                            | `ROADMAP.md:13583`                                                                                                                         | From `0.9.0`, a member added to a published interface ships OPTIONAL with the required form deferred to a named minor, and the plan says which won. This plan deliberately departs from the deferral: the members stay optional permanently (C6, §3.3).                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                                                                                   |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M105 says `common` changes "only if a filter type must move there". `IDataSource` — the port every adapter implements — lives in `common` (`database.ts:203`), so `common` changes unconditionally.                                                                                        | `common` gains the two optional `IDataSource` members, `WritePrecondition` and `writePreconditionProblem`.                                                                                                                                                                                       | ROADMAP M105 `Package(s)` line names `packages/common` without the condition.                                                                                                                                               |
| C2 | ROADMAP M105 scope names only the tenant bridge, while the database-plugin README (`:176-178`, `:246-247`) and PUBLIC_API (`:2306`, `:2345`) promise that "Milestone 105's conditional write closes the window" for the outbox transitions and the inbox failure count.                            | The docs' promise wins: the outbox and inbox stores switch over in this milestone (§3.8). It is the same mechanism through the same helper, and leaving the promise unkept would leave three published sentences false. **Widened scope approved by the maintainer, 2026-10-10.**                | ROADMAP M105 scope + deliverables list the two stores; the four README/PUBLIC_API sentences are rewritten to describe the conditional path and its fallback.                                                                |
| C3 | ROADMAP M105 names "a Cosmos/Bigtable conditional mutation" for Cosmos. Cosmos offers no conditional delete on a predicate; its native guard is `IfMatch` on `_etag`.                                                                                                                              | Cosmos uses a read followed by an `_etag`-guarded `replace`/`delete` (§3.6). This is a version compare-and-swap, not a check-then-write: the probe shows a delete-and-recreate under the same id fails the guard with `412`.                                                                     | ROADMAP M105 scope bullet names `IfMatch` for Cosmos; PUBLIC_API states the per-adapter mechanism table.                                                                                                                    |
| C4 | ROADMAP M105 says "a `WHERE key = ? AND col = ?` statement … DynamoDB `ConditionExpression`" without saying whether deferred-write transactions are covered; `IDataSource` (`database.ts:191`) says D1, DynamoDB and Cosmos transactions defer writes.                                             | Deferred-write transactions omit the members (§3.5). Commit-time conditions and non-equality predicates are NOT owned by the framework: researched 2026-10-10, ASP.NET Core and NestJS leave both to the ORM (EF Core, TypeORM, MikroORM), and Setu already exposes its ORMs through seams (§0). | ROADMAP M105 gains a "Not covered, and not owned by the framework" bullet naming both, with the ORM precedent and the seams.                                                                                                |
| C5 | The ROADMAP M107 "One relay at a time" scope bullet said "The portable repository has no … conditional update (M105 adds the latter)" and "True fencing needs a conditional status write (M105)". After this milestone the status write IS conditional, but there is still no relay fencing token. | Status transitions become conditional here; relay fencing and multi-relay sweeping move to a new M107b, which depends on this milestone (§0).                                                                                                                                                    | The two M107 sentences are rewritten to say M105 made transitions conditional and to point at M107b; a new ROADMAP M107b section (with the MassTransit/Wolverine/CAP/NServiceBus prior art) and its Progress row are added. |
| C6 | ROADMAP "Versioning Policy From `0.9.0`" says an optional member's required form is deferred to a named minor.                                                                                                                                                                                     | Departed from deliberately, approved by the maintainer 2026-10-10: the members stay optional permanently, because a required form would break out-of-repo implementors while removing no fallback (§3.3).                                                                                        | The ROADMAP M105 scope bullet states "optional permanently" and why; no CHANGELOG entry is marked for a future minor.                                                                                                       |

## 3. Design decisions

### 3.1 The member signatures

- **Decision:** on `IDataSource` (`common`):

  ```ts
  updateWhere?(
    id: EntityKey,
    where: WritePrecondition,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown> | null>;
  deleteWhere?(id: EntityKey, where: WritePrecondition): Promise<boolean>;
  ```

  On `IRepository<Entity, Id>` (`database-plugin`):
  `updateWhere?(id: Id, where: WritePrecondition, data: Partial<Entity>): Promise<Entity | null>`
  and `deleteWhere?(id: Id, where: WritePrecondition): Promise<boolean>`.
- **Why:** `null` / `false` is "not matched", never a throw: a failed predicate is the expected
  outcome of the race the member exists for, not an error. A missing key and a failed predicate are
  deliberately the same answer — telling them apart needs a second read, which is itself racy and
  which no consumer needs (each consumer that must classify re-reads, §3.8).
- **Test home:** `conditional-write-conformance.test.ts` (both arms on every data source),
  `base-repository-conditional.test.ts`.

### 3.2 `WritePrecondition` is an equality map on scalar values

- **Decision:** `type WritePrecondition = Readonly<Record<string, string | number>>`. Every field
  must equal its value (`AND`); at least one field; no `null`, `boolean`, `Date`, object or array
  value; no field name that is empty, starts with `$`, or contains `.`. One pure function in
  `common`, `writePreconditionProblem(where: unknown, data?: unknown): string | undefined`, returns
  the reason a predicate (and, for an update, a payload with at least one own field) is refused,
  `undefined` when acceptable. A field naming a key column is allowed: it is CONJOINED with the key,
  never merged into it (§3.4), so a different value for the key column answers "not matched".
- **Why:** every in-repo consumer compares a string or a number (tenant id, `kind`, `status`,
  `attempts`). `null` differs across backends (SQL `= NULL` never matches), booleans differ in
  SQLite/D1 storage, and `$`-prefixed names are MongoDB operators (the M101c `$`-operator finding).
  A dotted name means four different things, measured from source: a nested path on MongoDB, one
  literal attribute on DynamoDB (`aliasPath` does not split a string, `dynamo-expression.ts:152`),
  one literal key on memory, and a refused identifier on D1 and Drizzle — so it is refused
  everywhere. Validation lives in `common` because two packages need the identical rule and §2.2
  forbids one importing the other (the M47 frame-codec precedent).
- **Test home:** `write-precondition.test.ts` (`common`), table of accepted and refused inputs.

### 3.3 Optional members, absence means "cannot", the repository owns the refusal

- **Decision:** both members are optional on `IDataSource` and on `IRepository`. `BaseRepository`
  always defines them; each first validates with `writePreconditionProblem` (rejecting with
  `UnsupportedQueryFeatureError('write-precondition', 'database-plugin', …)`, not branded), then, if
  the bound data source lacks the member, rejects with
  `UnsupportedQueryFeatureError('conditional-write', 'database-plugin', …)` before any I/O.
  `'conditional-write'` joins `QUERY_SHAPE_FEATURES` (branded `501`, like `'cursor-pagination'`).
  Every refusal is a rejection, never a synchronous throw.
- **Why:** this is the `findPage` shape (`base-repository.ts:145`). Optional rather than required
  per the versioning policy, and permanently so: a required form would break out-of-repo
  implementors while removing no fallback, since the deferred-write transaction sources (§3.5) keep
  refusing regardless. The ambiguity ("absent" vs "not offered") is resolved by the repository,
  which turns absence into one named error a caller can branch on.
- **Test home:** `base-repository-conditional.test.ts`.

### 3.4 Native mechanism per data source

- **Decision:** one operation per call, the predicate evaluated by the backend:

  | Data source     | `updateWhere`                                                                                                                                                                                                | `deleteWhere`                                                                  |
  | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
  | memory (non-tx) | synchronous find + `matchesWhere` + merge, no `await` between                                                                                                                                                | synchronous find + `matchesWhere` + splice                                     |
  | Prisma          | `delegate.update({ where: { ...keyWhere, AND: [where] }, data })`; `P2025` → `null`                                                                                                                          | `delegate.delete({ where: { ...keyWhere, AND: [where] } })`; `P2025` → `false` |
  | Drizzle         | `update().set(data).where(and(keyPreds, predicateFor(where))).returning()`; no row → `null`                                                                                                                  | `delete().where(and(…)).returning()`; `rows.length > 0`                        |
  | MongoDB         | `findOneAndUpdate({ $and: [idFilter, whereFilter] }, { $set }, { returnDocument: 'after' })`; an empty `$set` after key stripping → `findOne` on the same filter                                             | `deleteOne({ $and: [idFilter, whereFilter] })`                                 |
  | DynamoDB        | `UpdateItem` with `ConditionExpression: attribute_exists(pk) AND #w0 = :w0 …`, `ALL_NEW`; `ConditionalCheckFailedException` → `null`                                                                         | `DeleteItem` with the same condition; failed check → `false`                   |
  | Cosmos DB       | read → `matchesWhere` on the read → merge → `replace` with `IfMatch: _etag` (§3.6)                                                                                                                           | read → `matchesWhere` → `delete` with `IfMatch: _etag`                         |
  | Bigtable        | `conditionalMutate(test, { onMatch: [insert cells] })`, test = nested `condition` over a NEWEST-CELL test per field (family → column → `{ row: { cellLimit: 1 } }` → value range; §11 I1); then read the row | `conditionalMutate(test, { onMatch: [delete] })`                               |
  | D1              | `UPDATE … SET … WHERE <key> AND "col" = ?N … RETURNING *`; no row → `null`                                                                                                                                   | `DELETE … WHERE <key> AND … RETURNING <pk>`                                    |

  **The predicate is always CONJOINED with the key, never spread into it.** A spread such as
  `{ ...keyWhere, ...where }` lets a predicate field naming a key column REPLACE the key, so
  `updateWhere('x', { id: 'y' }, …)` would write row `y` — the M101c cross-row write returned
  through the fix; spreading the other way silently drops the predicate's key field instead. Every
  arm above is therefore an explicit conjunction (`AND`, `$and`, `and(...)`, a `WHERE … AND …`, a
  `ConditionExpression … AND …`, a nested Bigtable `condition`, `matchesWhere` beside the key
  match). **Every implementation calls `writePreconditionProblem` first** and rejects on a reason,
  because `createDrizzleDataSource`, `createPrismaDataSource` and each adapter's `createDataSource`
  are public and a direct caller never passes through `BaseRepository`.

  Field names go through each adapter's existing translation (Mongo field mapping and `_id`,
  DynamoDB attribute aliasing and marshalling, D1 `quoteIdentifier` and `assertParamBudget`, Drizzle
  `columnFor`). Prisma additionally refuses predicate fields named `AND`, `OR`, `NOT` or the
  configured compound-key field, which Prisma would read as operators. A Bigtable predicate field
  with no addressable column makes the call answer "not matched" with no RPC, matching that
  adapter's rule that constraining on a column that cannot exist matches nothing
  (`bigtable-scan.ts:355`). **The Bigtable test must compare the NEWEST cell only** (§11 I1):
  `valueTest` matches a value in any retained version, which is safe for the read push-down (a
  superset the client-side evaluator narrows) but unsafe for a write, where a historical `tenant_id`
  or `status` would satisfy the predicate — measured on the emulator. Each per-field chain caps to
  one cell after narrowing to the exact column and before the value range, matching the
  newest-version read in `bigtable-data-source.ts:83-90`. `valueTest` itself is unchanged.
- **Why:** every mechanism except Cosmos is a single statement or request whose predicate the server
  evaluates; Prisma's was confirmed to be one SQL statement by statement logging, and Bigtable's
  nested condition was confirmed on the emulator.
- **Test home:** `conditional-write-conformance.test.ts`; per-adapter real suites (§6).

### 3.5 Deferred-write transactions omit the members

- **Decision:** the memory transaction overlay, `createD1TransactionDataSource`, the DynamoDB
  transaction-buffer path, the Cosmos transaction source and the Bigtable buffered source do not
  define `updateWhere`/`deleteWhere`. A Unit of Work repository over one of them therefore refuses
  with `'conditional-write'` (§3.3). Prisma, Drizzle and MongoDB transaction sources carry the
  members, because they come from the same factory (§1).
- **Why:** a deferred write lands at commit, so the predicate's outcome is not known when the call
  returns; answering "matched" at buffer time would be an emulated check-then-write, the defect
  itself. DynamoDB and Cosmos do offer commit-time conditions, but that is a different contract (the
  outcome surfaces as a commit failure), and the framework does not own it (C4, §0).
- **Test home:** `conditional-write-conformance.test.ts` ("deferred transaction refuses" rows).

### 3.6 Cosmos: a version compare-and-swap, bounded

- **Decision:** read the item through the existing address resolution; if it is absent or
  `matchesWhere` fails, answer "not matched" without writing. Otherwise write guarded by the read's
  `_etag` (`replace` for an update, the whole merged document; `delete` with `accessCondition` for a
  delete). On `412` start again from the read, at most 3 times, then reject with the existing
  `CosmosConcurrentModificationError`. An update that would change a partition-key value is refused
  as today. The internal facade's `delete()` gains an optional `options` parameter carrying
  `accessCondition`.
- **Why:** Cosmos has no predicate-conditioned delete, and the `_etag` guard makes the write land
  only on the exact version checked — the probe shows a delete-and-recreate under the same id fails
  it. Always using `replace` (not the narrow `patch` path the plain `update` takes) keeps one
  mechanism for both arms and relies only on a guard the adapter already ships. The retry turns an
  unrelated concurrent edit into a re-check rather than a spurious "not matched".
- **Test home:** `cosmos-conditional-write.test.ts` (fake), `real-cosmos-adapter.test.ts` (guarded).

### 3.7 `DatabaseService` forwards both members

- **Decision:** `wrapDataSource` binds `ds.updateWhere?.bind(ds)` and `ds.deleteWhere?.bind(ds)`
  beside `findPage`, and when present defines wrapped members that log the operation and classify a
  driver rejection exactly as `update`/`delete` do. Absent on the source → absent on the wrapper.
- **Why:** the wrapper spreads only own enumerable members, so a class-based source would lose a
  prototype member and every conditional write would refuse exactly when `logQueries` is on — the
  M70j `count`-filter defect class. Classification is unconditional (M90f).
- **Test home:** `database-service-conditional.test.ts` (class-backed source, `logQueries` on and
  off).

### 3.8 One fallback helper; three stores switch over

- **Decision:** an internal `repositories/conditional-write.ts` exports
  `conditionalUpdate(repo, id,
  where, data)` and `conditionalDelete(repo, id, where)`, each
  answering
  `{ outcome: 'applied', row? } | { outcome: 'not-matched' } | { outcome: 'unsupported' }`.
  `'unsupported'` is returned when `repo.updateWhere` is absent, or when it rejects with
  `UnsupportedQueryFeatureError` whose `feature === 'conditional-write'` (which §3.3 guarantees
  precedes any I/O); every other rejection propagates. The consumers:
  - **Tenant bridge.** `update` → `conditionalUpdate(repo, id, { [col]: tenantId }, stripped)`;
    `delete` → `conditionalDelete(repo, id, { [col]: tenantId })`. No `#ownedRow` pre-read on the
    conditional path, but the existing after-check (`:268`) runs on BOTH paths: Bigtable's
    `updateWhere` reads the row back in a separate call after the atomic write (§3.4), so a row
    swapped in between could otherwise be handed back to the wrong tenant. `'not-matched'` → `null`
    / `false`. `'unsupported'` → today's two-call path, unchanged.
  - **Outbox store.** `markSent` / `markFailure` write with
    `{ kind: 'setu-outbox', status:
    'pending' }`, `release` with `status: 'failed'`. On
    `'not-matched'`, re-read with `#find` to classify into the existing outcomes (`missing`,
    `not-pending`, `not-failed`); if the re-read still shows the expected status, retry, at most 3
    times, then reject naming contention.
  - **Inbox store.** `#increment` writes `attempts + 1` with
    `{ kind: 'setu-inbox', attempts:
    <read value> }` as a compare-and-set, re-reading and
    retrying on `'not-matched'` (at most 5 times, then reject); a row whose `attempts` is not a safe
    integer keeps the two-call path. `release` uses `{ kind, status: 'parked' }` for both the delete
    and the discard update.
- **Why:** one implementation of "try conditional, else fall back" keeps the three stores from
  drifting on what counts as unsupported. Re-reading only after the write was refused is safe: no
  write depends on that read.
- **Test home:** `conditional-write-helper.test.ts`, `database-tenant-data-store.test.ts`,
  `outbox-store-conditional.test.ts`, `inbox-store-conditional.test.ts`.

### 3.9 Race tests: one state-based check for the fix, one injected race for the control

- **Decision:** the two paths need different setups, because the conditional path performs no
  ownership read for a hook to interleave with (§3.8):
  - **Conditional path (the fix):** state-based. Tenant A's row is deleted and tenant B's row is
    created under the same key BEFORE the call. Tenant A's `update`/`delete` through the bridge must
    answer `null`/`false`, and B's row must read back unchanged. Run on the memory adapter and on
    real PostgreSQL through Drizzle.
  - **Fallback path (the negative control):** a test data source wraps the memory adapter with
    `updateWhere`/`deleteWhere` stripped and, inside the bridge's ownership read (`findById`),
    deletes A's row and creates B's under the same key. The test observes the write landing on B's
    row — the M101c defect reproduced, proving the harness can see it.
  - **Key override (fix 1's control):** a conformance row whose predicate names the key column with
    a DIFFERENT value must answer "not matched" and leave both rows unchanged on every data source;
    reverting Prisma or Mongo to a spread merge makes it write the other row.
- **Why:** a race test whose hook never fires on the code under test passes whether or not the fix
  works. The state-based check is what the conditional path can actually be asked; the injected race
  is what proves the old path was broken and the harness can tell.
- **Test home:** `tenant-store-race.test.ts` (memory, both arms), `tenant-store-race-real.test.ts`
  (guarded, `POSTGRES_URL`, the state-based arm), `conditional-write-conformance.test.ts` (key
  override).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — both members are optional on `IDataSource` and on
`IRepository`, so no implementor and no caller breaks, and they stay optional permanently (§3.3) —
no required form is planned, so no CHANGELOG entry is marked for a future minor. The members ship in
the next release after merge: `0.9.0` if M105 lands before that cut, otherwise a `0.9.x` patch, and
every `@since` tag names that version.

| Exported symbol                                                                                 | Kind                         | Consumer / real code path that READS it                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WritePrecondition` (`common`)                                                                  | type                         | Parameter type of `IDataSource.updateWhere?`/`deleteWhere?`, `IRepository` members, every adapter implementation.                                                                           |
| `writePreconditionProblem` (`common`)                                                           | function                     | `BaseRepository.updateWhere`/`deleteWhere` and every data-source implementation (memory, Prisma, Drizzle, MongoDB, DynamoDB, Cosmos, Bigtable in database-plugin; D1 in cloudflare-plugin). |
| `IDataSource.updateWhere?` / `deleteWhere?`                                                     | interface members (`common`) | `BaseRepository` (reads presence and calls), `DatabaseService.wrapDataSource` (binds and forwards).                                                                                         |
| `IRepository.updateWhere?` / `deleteWhere?`                                                     | interface members            | `conditionalUpdate` / `conditionalDelete` (tenant bridge, outbox store, inbox store); application code.                                                                                     |
| `BaseRepository.updateWhere` / `deleteWhere`                                                    | class methods                | Every repository `DatabaseService.getRepository` and `IUnitOfWork.getRepository` return (`InternalRepo`).                                                                                   |
| `UnsupportedQueryFeatureError` (`feature` values `'conditional-write'`, `'write-precondition'`) | existing class, new values   | `conditionalUpdate`/`conditionalDelete` branch on `'conditional-write'`; `'write-precondition'` reaches the caller.                                                                         |

Not exported: `conditionalUpdate`, `conditionalDelete` (internal to `database-plugin`), the D1
`buildUpdateWhere`/`buildDeleteWhere` builders, the Cosmos facade's widened `delete(options?)`
signature (internal facade type). A `barrel-exports.test.ts` assertion in `common` pins the two new
exports, and one in `database-plugin` pins that the helper is NOT exported.

### 4.1 Options — every option names its consumer

| Option                                                                   | Consumer | Behavior (per implementation) |
| ------------------------------------------------------------------------ | -------- | ----------------------------- |
| None (checked) — this milestone adds no plugin, adapter or store option. | —        | —                             |

## 5. Implementation files

| File                                                                                                                       | Purpose                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/database.ts`                                                                                 | `WritePrecondition`; optional `updateWhere?`/`deleteWhere?` on `IDataSource` with per-arm JSDoc.   |
| `packages/common/src/services/write-precondition.ts`                                                                       | `writePreconditionProblem`.                                                                        |
| `packages/common/src/index.ts`                                                                                             | Barrel exports for the two new symbols.                                                            |
| `packages/database-plugin/src/interfaces/index.ts`                                                                         | Optional `IRepository` members.                                                                    |
| `packages/database-plugin/src/repositories/base-repository.ts`                                                             | `updateWhere`/`deleteWhere` with validation and the `'conditional-write'` refusal.                 |
| `packages/database-plugin/src/repositories/conditional-write.ts`                                                           | Internal `conditionalUpdate`/`conditionalDelete` fallback helper.                                  |
| `packages/database-plugin/src/errors.ts`                                                                                   | `'conditional-write'` added to `QUERY_SHAPE_FEATURES`.                                             |
| `packages/database-plugin/src/services/database-service.ts`                                                                | `wrapDataSource` forwards both members.                                                            |
| `packages/database-plugin/src/adapters/memory/memory-adapter.ts`                                                           | Non-transactional implementation.                                                                  |
| `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts`                                                           | Implementation in `createPrismaDataSourceInner` (also reached by transactions).                    |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                                         | Implementation in `createDrizzleDataSourceInner` (also reached by transactions).                   |
| `packages/database-plugin/src/adapters/mongo/mongo-data-source.ts`                                                         | Implementation (also reached by the session-bound transaction source).                             |
| `packages/database-plugin/src/adapters/dynamo/dynamo-data-source.ts`                                                       | Non-transactional implementation; buffer path omits the members.                                   |
| `packages/database-plugin/src/adapters/cosmos/cosmos-data-source.ts`, `cosmos-client-types.ts`, `cosmos-client.ts`         | Non-transactional implementation; facade `delete(options?)`.                                       |
| `packages/database-plugin/src/adapters/bigtable/bigtable-data-source.ts`, `bigtable-scan.ts`                               | Non-transactional implementation; a `preconditionTest` built from `valueTest`.                     |
| `packages/database-plugin/src/tenancy/database-tenant-data-store.ts`                                                       | Conditional path; class JSDoc limit narrowed to data sources lacking the member.                   |
| `packages/database-plugin/src/outbox/database-outbox-store.ts`                                                             | Conditional transitions.                                                                           |
| `packages/database-plugin/src/inbox/database-inbox-store.ts`                                                               | Conditional increment and release.                                                                 |
| `packages/cloudflare-plugin/src/database/d1-sql.ts`, `d1-data-source.ts`                                                   | `buildUpdateWhere`/`buildDeleteWhere`; non-transactional implementation; transaction source omits. |
| `PUBLIC_API.md`, `packages/database-plugin/README.md`, `packages/common/README.md`, `packages/cloudflare-plugin/README.md` | Members, per-adapter mechanism table, deferred-transaction refusal, C2 sentences, export tables.   |
| `ROADMAP.md`, `CHANGELOG.md`, `CLAUDE.md`                                                                                  | C1–C5 corrections, Progress row, `Unreleased` entry (Added), status entry.                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Every real-backend case is guarded with the BDD `ignore` option on its environment variable, never
an early return (the M70c trap). Every call below type-checks against the §3.1 signatures: a
`WritePrecondition` literal, an `EntityKey`, and a `Partial<…>` payload.

| Test file                                                                                                                                                                                             | src covered                                                               | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/write-precondition.test.ts`                                                                                                                                                | `write-precondition.ts`                                                   | Table of accepted inputs (one field, several fields, numbers) and refused inputs (empty, `null`, boolean, `Date`, object, array, `$`-prefixed name, dotted name, empty name, non-plain object, empty update payload), asserted as data.                                                                                                                                                                                                                                                                                                                                     |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                                                                                                                                         | `index.ts`                                                                | `WritePrecondition` (compile-time) and `writePreconditionProblem` are exported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/database-plugin/test/unit/base-repository-conditional.test.ts`                                                                                                                              | `base-repository.ts`, `errors.ts`                                         | Delegates when present; `'conditional-write'` refusal when absent, before any data-source call; `'write-precondition'` refusal on a bad predicate; refusals are rejections; `'conditional-write'` carries the `501` brand and `'write-precondition'` none.                                                                                                                                                                                                                                                                                                                  |
| `packages/database-plugin/test/unit/conditional-write-conformance.test.ts`                                                                                                                            | memory, Prisma, Drizzle, MongoDB, DynamoDB, Bigtable, Cosmos translations | One case table run over every data source (fakes recording the native call): matched update returns the row; predicate mismatch answers `null`/`false` and the store is unchanged; missing key answers the same; deferred-transaction sources lack both members (asserted per adapter as data); per-adapter "unknown column" outcome asserted as data; a predicate naming the key column with a DIFFERENT value answers "not matched" and writes no row; an invalid predicate passed straight to the data source (bypassing `BaseRepository`) is rejected by every adapter. |
| `packages/database-plugin/test/unit/cosmos-conditional-write.test.ts`                                                                                                                                 | `cosmos-data-source.ts`, `cosmos-client.ts`                               | `IfMatch` carried on `replace` and `delete`; `412` → re-read → success; three `412`s → `CosmosConcurrentModificationError`; predicate fails on the read → no write call; partition-key change refused.                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/database-plugin/test/unit/bigtable-conditional-write.test.ts`                                                                                                                               | `bigtable-data-source.ts`, `bigtable-scan.ts`                             | Nested `condition` test shape for one and three fields, with the newest-cell cap between column and value in every chain; unaddressable field → no RPC and "not matched"; a row whose predicate columns hold an OLD matching version under a NEWER non-matching one answers "not matched" and writes nothing, for update and delete (also in `real-bigtable-adapter.test.ts`).                                                                                                                                                                                              |
| `packages/database-plugin/test/unit/prisma-conditional-write.test.ts`                                                                                                                                 | `prisma-adapter.ts`                                                       | `where` conjoined with the scalar and compound key through `AND`, never spread (asserted on the delegate call); `AND`/`OR`/`NOT`/compound-field names refused; `P2025` mapped; other errors propagate.                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/database-plugin/test/unit/database-service-conditional.test.ts`                                                                                                                             | `database-service.ts`                                                     | Class-backed source: members forwarded with `logQueries` on and off; absent stays absent; a driver rejection is classified like `update`'s; the logged record carries no predicate or payload value (§10 S6).                                                                                                                                                                                                                                                                                                                                                               |
| `packages/database-plugin/test/unit/conditional-write-helper.test.ts`                                                                                                                                 | `conditional-write.ts`                                                    | Absent member → `'unsupported'`; `'conditional-write'` rejection → `'unsupported'`; any other rejection (including `'write-precondition'`) propagates; matched / not-matched mapping.                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/database-plugin/test/unit/database-tenant-data-store.test.ts` (extended)                                                                                                                    | `database-tenant-data-store.ts`                                           | Conditional path takes no ownership pre-read; the after-check runs on both paths (a returned row carrying another tenant's column throws); foreign tenant → `null`/`false`; fallback path unchanged (existing cases kept).                                                                                                                                                                                                                                                                                                                                                  |
| `packages/database-plugin/test/unit/tenant-store-race.test.ts`                                                                                                                                        | `database-tenant-data-store.ts`                                           | §3.9: state-based arm — B's row created under A's key before the call is left untouched and the call answers `null`/`false`; injected-race arm on the fallback path — the write lands on B's row (negative control).                                                                                                                                                                                                                                                                                                                                                        |
| `packages/database-plugin/test/unit/outbox-store-conditional.test.ts`                                                                                                                                 | `database-outbox-store.ts`                                                | Each transition sends the expected predicate; not-matched is classified as `missing`/`not-pending`/`not-failed` from the re-read; contention retry bound; fallback path unchanged.                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/database-plugin/test/unit/inbox-store-conditional.test.ts`                                                                                                                                  | `database-inbox-store.ts`                                                 | Two concurrent `recordFailure` calls on memory record two increments (fails on the old path); retry bound; non-integer `attempts` keeps the two-call path; `release` predicates.                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/database-plugin/test/unit/barrel-exports.test.ts` (extended)                                                                                                                                | `index.ts`                                                                | `conditionalUpdate`/`conditionalDelete` are NOT exported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/database-plugin/test/integration/tenant-store-race-real.test.ts`                                                                                                                            | Drizzle + tenant bridge                                                   | Guarded `POSTGRES_URL`: §3.9 state-based arm against real PostgreSQL through Drizzle; B's row reads back unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `real-drizzle-adapter.test.ts`, `real-prisma-adapter.test.ts`, `real-mongo-adapter.test.ts`, `real-dynamo-adapter.test.ts`, `real-bigtable-adapter.test.ts`, `real-cosmos-adapter.test.ts` (extended) | each adapter                                                              | Guarded on their existing variables: matched, mismatched and missing-key rows for both members against the real backend, read back through `findById`; Prisma also in a transaction. Cosmos is local-only (2.5 GB emulator), as today.                                                                                                                                                                                                                                                                                                                                      |
| `packages/cloudflare-plugin/test/unit/d1-conditional-write.test.ts`                                                                                                                                   | `d1-sql.ts`, `d1-data-source.ts`                                          | SQL text and bound parameters; parameter-budget refusal; transaction source lacks the members.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/cloudflare-plugin/test/integration/d1-database.test.ts` (extended)                                                                                                                          | D1 over real `node:sqlite`                                                | Statements executed: matched, mismatched, missing key; read back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Negative controls to run and revert during implementation, each observed failing: (1) the §3.9
bridge race with the conditional path removed; (2) `wrapDataSource` without the explicit bind
(class-backed source under `logQueries`); (3) Cosmos without `IfMatch` (the recreate case writes);
(4) the inbox increment without the `attempts` predicate (two concurrent failures record one); (5)
the helper treating every rejection as `'unsupported'` (a `'write-precondition'` error is swallowed
into the fallback); (6) Prisma or Mongo merging the predicate by spread (the key-override row writes
the other row); (7) the bridge's after-check removed from the conditional path (a Bigtable read-back
carrying another tenant's column is returned); (8) the Bigtable newest-cell cap removed (a
historical tenant or status matches and the write persists, on the real emulator).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m105-conditional-writes, never develop or main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test              # with the full-backend env block, so the guarded suites run
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on the committed tree
deno task release:verify <version>
```

This milestone changes cross-tenant write isolation, a trust boundary, so it is ALSO
security-audited before merge (`.roo/skills/security-audit/SKILL.md`): on the exact commit the PR
will merge, in a context that did not implement or fix it, against §10 below. The audit record goes
in the PR.

## 8. Risks & mitigations

- **A new optional member is silently dropped by a wrapper** (the M70j class) → §3.7 binds it
  explicitly and the class-backed test runs with logging on and off; `#countingCompletions` is
  covered because the Drizzle conformance rows run through `DrizzleAdapter.createDataSource`.
- **A conditional path that does not discriminate** (a test passing on the old code) → every race
  test carries the §6 negative control observed failing before it is reverted.
- **Encoded-value mismatch makes a predicate never match** (DynamoDB `dateAttributes`, Bigtable
  tagged values, a column written outside the framework) → the failure mode is "not matched", which
  writes nothing; the conformance and real suites read back to show the matched case writes, and
  PUBLIC_API states that the predicate compares the stored representation.
- **Retry loops masking a real contention problem** → each loop has a fixed bound and rejects with a
  message naming the entity and the contention, never spins.
- **A subclass of the exported `BaseRepository` already defining `updateWhere` with a different
  signature** → judged negligible (no in-repo subclass does; the class is documented as the adapter
  author's base); recorded in the CHANGELOG entry rather than treated as a break.

## 9. Out of scope

- Commit-time conditional writes inside deferred-write transactions (DynamoDB `TransactWriteItems`
  conditions, Cosmos batch `ifMatch`, D1 batch) — not owned by the framework; the ORM seams (C4).
- Non-equality and `null` predicates — not owned by the framework; the ORM seams (C4).
- Outbox relay fencing tokens and multi-relay sweeping — M107b (C5).
- Making `updateWhere`/`deleteWhere` required — not planned; optional permanently (§3.3).
- A `meta.changes`-style row count from `updateWhere`; the row (or `null`) is the result.

## 10. Design security review (recorded before implementation)

Recorded 2026-10-10, before any implementation, after one review of this plan against source (the
seven review fixes are already folded into §3–§7). The committed-tree audit (§7) checks the code
against this section; it does not write the threat model after the fact.

**Flows reviewed.**

- A tenant-scoped `update`/`delete` entering `DatabaseTenantDataStore`: the caller-supplied key and
  tenant id, the payload with the tenant column stripped, the conditional call, the read-back and
  the after-check (§3.8).
- A `WritePrecondition` passing through `writePreconditionProblem` into each of the eight
  implementations, and its translation into a native filter, condition expression or statement
  (§3.2, §3.4).
- The fallback decision: a member absent from the bound data source, the `'conditional-write'`
  refusal, and the helper choosing the two-call path (§3.3, §3.8).
- The outbox store's `markSent`/`markFailure`/`release` and the inbox store's failure count and
  `release`, each as a conditional write followed, on "not matched", by a classifying re-read.
- The Cosmos read → `_etag`-guarded write → `412` retry loop (§3.6).
- The log record `DatabaseService.wrapDataSource` emits for each call, leaving the process.

**Assets.**

- Tenant row isolation: a write made for tenant A never changes, deletes or returns a row whose
  tenant column names B.
- Row targeting: a conditional write changes at most the row its key names.
- The outbox's guarantees: a `sent` row is never regressed and a transition applies at most once.
- The inbox's failure count: every failure is counted, so `maxAttempts` parks when it says it will.
- Log integrity: no tenant id, predicate value or payload reaches a log line.
- Availability: no call loops, and no call grows memory with traffic.

**Attackers.**

- (A1) A caller acting for tenant A who chooses the key of the row being written — the M101c shape,
  where the caller reuses a key that tenant B's row now holds.
- (A2) Application code that forwards request input into a predicate's field names or values — the
  source of an operator injection (`$where`, `$ne`, a Prisma `AND`, a dotted path).
- (A3) A concurrent writer on the same key: a second request, a second relay, or a second consumer
  replica, racing the check against the write.
- (A4) A reader of logs.

**Approved budgets.** Per call: one validation pass over the predicate (bounded by its field count)
and ONE native write; Bigtable adds one read after the write. Cosmos: at most 3 rounds of one read
plus one guarded write, then `CosmosConcurrentModificationError`. Outbox: at most 3 conditional
attempts each followed by one re-read, then a named rejection. Inbox: at most 5 compare-and-set
rounds, then a named rejection. Nothing is cached and nothing in memory grows with traffic.

**Design-time findings.**

| #   | Finding                                                                                                                                                                          | Disposition                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | A1 reuses a key now held by tenant B's row, and A's write lands on it (the M101c race)                                                                                           | Fixed: one conditional operation keyed on the key AND the tenant column (§3.8); proven by the §3.9 state-based arm, with the injected race on the fallback as its control                                                                                                                                                                                                                            |
| S2  | A predicate field naming a key column replaces the key, so the write targets a different row (A1, A2)                                                                            | Fixed: the predicate is conjoined, never spread (§3.4); the key-override conformance row and control (6)                                                                                                                                                                                                                                                                                             |
| S3  | A predicate field or value becomes a query operator (A2)                                                                                                                         | Fixed: `writePreconditionProblem`, called by every implementation, refuses `$`-prefixed and dotted names, empty names and every non-scalar value; Prisma also refuses `AND`, `OR`, `NOT` and the compound-key field (§3.2, §3.4)                                                                                                                                                                     |
| S4  | Another tenant's row is returned to the caller after a correct write (A3)                                                                                                        | Fixed: the bridge's after-check runs on both paths (§3.8), because Bigtable reads the row back in a separate call; control (7)                                                                                                                                                                                                                                                                       |
| S5  | A caller believes a write was conditional while it silently ran as check-then-write                                                                                              | Fixed for every caller but the three first-party stores: absence is the named `'conditional-write'` refusal, before any I/O (§3.3). The three stores fall back on purpose and say so (S8)                                                                                                                                                                                                            |
| S6  | A tenant id, predicate value or payload reaches a log line (A4)                                                                                                                  | Fixed: the wrapper logs entity, operation and duration only, as `update` does today (`database-service.ts:540`); asserted in `database-service-conditional.test.ts`                                                                                                                                                                                                                                  |
| S7  | A retry loop spins under contention (A3)                                                                                                                                         | Fixed: fixed bounds per the budgets above, each ending in a named rejection                                                                                                                                                                                                                                                                                                                          |
| S8  | The three stores keep the documented check-then-write on a data source lacking the members                                                                                       | Accepted: refusing there would remove a working store from that backend. Every built-in non-transactional data source carries the members, so the fallback is reached only by an out-of-repo implementor; the bridge JSDoc and README say so                                                                                                                                                         |
| S9  | The native ORM seams (`getDrizzleDatabase`, the application's Prisma client, the injected document-store clients) bypass the validator                                           | Accepted: they are the application's own database access, outside this contract by design (§0)                                                                                                                                                                                                                                                                                                       |
| S10 | A predicate compares the STORED representation, so an encoding mismatch (DynamoDB `dateAttributes`, Bigtable tagged cells, a column written outside the framework) never matches | Accepted, and safe by direction: a mismatch answers "not matched" and writes nothing; PUBLIC_API states it                                                                                                                                                                                                                                                                                           |
| S11 | A tenant id or status a caller passes as the predicate value is itself attacker-chosen (A1)                                                                                      | Accepted, and unchanged by this milestone: the bridge trusts the tenant id its caller passes — `getRepository(ctx, …)` reads the middleware-resolved tenant (`multi-tenancy-service.ts:63`), while `getRepositoryFor(tenantId, …)` takes it as trusted input from application code (`:82`). The predicate only narrows a write and never widens one, so a wrong value at worst answers "not matched" |
| S12 | A Bigtable predicate matches a value the row HELD in an older retained cell version, not the one it holds now (A1, A3)                                                           | Fixed: every per-field test caps to the newest cell before comparing (§3.4, §11 I1); control (8)                                                                                                                                                                                                                                                                                                     |

**Obligations for the committed-tree audit.**

- Probe S1, S2, S3 and S4 with a positive control each (the legitimate call is served, the hostile
  one refused), on the memory adapter and on real PostgreSQL through Drizzle; probe S2 and S3 on the
  Prisma and Mongo implementations specifically, since those build filters as objects.
- Show negative controls (1), (6), (7) and (8) failing, then restored; (8) on the real Bigtable
  emulator with at least two retained versions per predicate column.
- Feed the refused-input table (S3) straight to each of the eight implementations, bypassing
  `BaseRepository`, and show every one rejects.
- Plant a canary tenant id, predicate value and payload field in a logged call under
  `logQueries: true` and show none appears in the captured log (S6).
- Drive each bounded loop to its bound and show the named rejection (S7).
- Confirm S8–S11 are stated where the plan says they are, and that no other caller of the fallback
  helper exists.

## 11. Corrections found during implementation

| #  | What the plan said                                                                                                                                                                                                      | What the source shows (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1 | §3.4 builds Bigtable's conditional predicate from the existing `valueTest`; §10 requires equality against the current row, preserving tenant isolation and preventing a stale outbox transition from regressing `sent`. | `packages/database-plugin/src/adapters/bigtable/bigtable-scan.ts:376-381` selects a family and qualifier, then tests the value across **all retained versions**. `packages/database-plugin/src/adapters/bigtable/bigtable-data-source.ts:83-90` reads only `versions[0]`, the newest value; `bigtable-client-types.ts:34-38` explicitly documents that representation. Thus the existing test can match an old tenant/status that the current row no longer carries.               | Stopped milestone implementation before changing production source. Probed the real emulator on 2026-10-10 with two retained versions per predicate column: historical `tenant_id = a`, `status = pending`; current `tenant_id = b`, `status = sent`. The planned nested condition returned `true` for the historical predicate and its mutation read back as persisted; the safety assertion failed. The smallest correction, proved in the same scratch probe, is to cap each test chain to its newest cell with `{ row: { cellLimit: 1 } }` **after** narrowing to its family and exact qualifier and **before** the value-range test. Both current-field predicates then matched and wrote, while the historical pair returned `false` without writing. The future `preconditionTest` must apply that cap rather than reuse `valueTest` unchanged; add retained-history update/delete cases and a negative control removing the cap to the Bigtable unit and real-backend cases. No new facade shape is needed (`BigtableFilter` already supports the row cell cap). Probe and logs are untracked scratch under `.tmp/`; no scratch was committed. |
| I2 | §3.8 sends the tenant bridge's `update` through `conditionalUpdate` with the payload stripped of the tenant column, and is silent about a payload that strips to nothing.                                               | `writePreconditionProblem` (`packages/common/src/services/write-precondition.ts`) refuses an empty update payload, so `update(tenant, entity, id, {})` or `{ tenant_id: … }` rejected with `'write-precondition'`, while the reference `MemoryTenantDataStore.update` (`packages/multi-tenancy-plugin/src/stores/memory-tenant-store.ts:160-181`) returns the owned row unchanged. Found by the milestone verification driver on memory, Drizzle/PostgreSQL, MongoDB and DynamoDB. | The bridge now answers `#ownedRow` (read-only, no write) when nothing remains after stripping, matching the reference store; a foreign tenant gets `null`. Unit test `update with nothing left after stripping answers the owned row and writes nothing` fails without the change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Implementation-stop evidence for I1 (not milestone verification):

```text
Test: rejects a historical tenant/status and serves the current tenant/status
Planned filter, exit 1:
  actual   { historicalMatched: true,  proof: "historical-write" }
  expected { historicalMatched: false, proof: "current-served" }
  FAILED | 0 passed | 1 failed (1 step)
Latest-cell cap before value test, exit 0:
  ok | 1 passed (1 step) | 0 failed
Both runs reached the real Bigtable emulator; neither ignored the test.
```
