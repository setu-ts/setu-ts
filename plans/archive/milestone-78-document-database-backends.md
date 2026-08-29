# Milestone 78 — MongoDB backend (`@setu-ts/database-plugin`)

> **Status:** Complete (PR pending). Branch: `feat/m78-document-database-backends`. `main` is
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR. The implementation and verification evidence are recorded below.

## 0. Objective & scope

Serve a document store under the existing `CAPABILITIES.DATABASE` capability by adding a first-class
`'mongodb'` arm to `DatabasePluginOptions`, backed by a new `MongoAdapter` over the native
**`npm:mongodb` driver**. The boundary is the portable contract as it stands today: the adapter
implements all six `IDataSource` methods and all six `NormalizedQuery` members natively, and refuses
by name the one member of `IDatabaseAdapter` that is SQL-shaped (`rawQuery`). Nothing in `common`
changes and no capability token is added — this is one new union arm and one new adapter.

**The ROADMAP's first deliverable, the Prisma-Mongo probe, is TAKEN and it falsified the
hypothesis** — see §1's external-fact rows. The ROADMAP predicted "repositories would work while
`query()` failed"; in fact a Prisma v7 client for MongoDB **cannot be constructed at all**, so the
existing `PrismaAdapter` cannot serve Mongo on the toolchain this repo targets. That is what makes
this milestone an adapter rather than a documented configuration.

- **In scope:** the `MongoAdapter`; the `'mongodb'` arm on the discriminated options union;
  per-entity collection and primary-key mapping following the whole two-layer D1 precedent; `_id`
  identity mapping and ObjectId conversion; native translation of `where`, `filter`, `orderBy`,
  `limit`, `offset` and `select`; session-based transactions; a named refusal for `rawQuery`; and
  the four doc corrections in §2.
- **NOT this milestone:** composite keys, nested filter paths and cursor pagination are **M79** —
  Mongo's single `_id` needs none of them, so this milestone must not pull them forward. DynamoDB is
  **M80**, Cosmos DB **M81**, Cloud Bigtable **M82**. TTL, consistency level and secondary-index
  selection are excluded by M79's out-of-scope bullet and belong with the adapter that first needs
  them.

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                         | Verified surface / fact                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDataSource`                          | `packages/common/src/services/database.ts:141`                             | Exactly six methods: `findAll(NormalizedQuery)`, `findById(string \| number)`, `create(Partial<Record<string,unknown>>)`, `update(id, data)`, `delete(id): Promise<boolean>`, `count(where, filter?)`. No SQL anywhere. |
| `IDatabaseAdapter`                     | `packages/common/src/services/database.ts:280`                             | `extends IOrmAdapter` and adds `createDataSource(entity)`, `beginTransaction(): Promise<IAdapterTransaction>`, `rawQuery<T>(sql, params?)`. `rawQuery` is the ONLY SQL-shaped member.                                   |
| `IOrmAdapter`                          | `packages/common/src/services/database.ts`                                 | Lifecycle only: `connect`, `disconnect`, `isReady`, `beginTransaction`. Confirms the M10 finding still holds.                                                                                                           |
| `IAdapterTransaction`                  | `packages/common/src/services/database.ts`                                 | `extends ITransaction` (`commit`, `rollback`) plus `createDataSource(entity)`.                                                                                                                                          |
| `NormalizedQuery`                      | `packages/common/src/services/database.ts:122`                             | `where` (equality record), `filter?`, `orderBy` (record of direction), `limit` (`-1` = unlimited), `offset`, `select`. All six are REQUIREMENTS on the adapter, per the contract's own JSDoc.                           |
| `FilterComparison`                     | `packages/common/src/services/database.ts:81`                              | Four arms; operators `eq`, `contains`, `gt \| gte \| lt \| lte`, `in`. `field` is a flat `string` in every arm (`:83`, `:88`, `:93`, `:98`) — nested paths are M79.                                                     |
| `DatabasePluginOptions`                | `packages/database-plugin/src/interfaces/index.ts`                         | `BuiltInDatabaseOptions \| CustomDatabaseOptions`, discriminated on `type`. Existing arms: `'prisma'` (`:299`), `'drizzle'` (`:315`), `'custom'` (`:353`), `'memory'` (default).                                        |
| `createAdapter` switch                 | `packages/database-plugin/src/plugin/database-plugin.ts:150`               | Four cases; `'memory'` is `default`. A new arm is one `case` plus one union member.                                                                                                                                     |
| `D1EntityMapping` / `D1AdapterOptions` | `packages/cloudflare-plugin/src/database/d1-adapter.ts:50-83`              | `tables?: Record<entityName, { table?: string; primaryKey?: string }>`, collapsed by `resolveTarget` (`:237`) into an internal, unexported target the builders consume. This is the two-layer shape to follow.          |
| `CAPABILITIES.DATABASE`                | `packages/common/src/tokens.ts`                                            | Already committed. **No new token**; `createCapabilityToken` forbids colons, and the named-connection form is `database.<name>` (dots).                                                                                 |
| `PrismaSqlProvider` `'mongodb'` arm    | `packages/database-plugin/src/interfaces/index.ts:43`, `PUBLIC_API.md:921` | Published export carrying `'mongodb'`, with `PASSTHROUGH_PROVIDERS` (`adapters/prisma/prisma-adapter.ts:40`) existing solely to hold it. Unreachable on Prisma v7 — see C1.                                             |
| `UnsupportedFilterOperatorError`       | `packages/database-plugin/src/errors.ts:34`                                | The only exported error class in the package; the refuse-by-name precedent.                                                                                                                                             |
| `MemoryAdapter.rawQuery`               | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:448`       | Rejects with a plain `Error`, does not throw synchronously. The shape a Mongo refusal must match (and M70j's synchronous-throw defect is the trap to avoid).                                                            |

### 1.1 External facts — measured against the real packages, not remembered

| Fact                                                                                                                                                                  | How established                                                                                                          | Consequence for this plan                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Prisma v7 cannot connect to MongoDB.** `PrismaClientOptions` is a two-arm union: `{ accelerateUrl }` or `{ adapter: runtime.SqlDriverAdapterFactory }`.             | Read from the generated `generated/prisma/internal/prismaNamespace.ts:673-716` after a real `prisma generate` at 7.10.0. | The Prisma route is closed; this milestone is an adapter.                                                        |
| `@prisma/adapter-mongodb` **does not exist** at any tag (404). The eight adapters at 7.10.0 are all SQL.                                                              | `npm view` per adapter name.                                                                                             | No driver-adapter route exists.                                                                                  |
| `prisma generate` **succeeds** for `provider = "mongodb"` — failure appears only at client construction.                                                              | Ran it; client emitted to `./generated/prisma`.                                                                          | The doc correction in C1 must say the failure is late, or a reader will conclude Mongo works.                    |
| Prisma states MongoDB "did not make the Prisma 7 release" and points users at **v6.19**; support returns in Prisma 8.                                                 | Prisma upgrade guide and v7 changelog.                                                                                   | Pinning v6 contradicts M66's v7 requirement; waiting on v8 is not a plan. Recorded in C2.                        |
| `mongodb` driver: `insertOne` → `{ acknowledged, insertedId }` with `insertedId` an `ObjectId`.                                                                       | Real driver against the running replica set.                                                                             | `create()` composes the returned document rather than re-reading.                                                |
| **`findOne({_id: "<24-hex string>"})` MISSES** where `_id` is an `ObjectId`.                                                                                          | Same probe — conversion is mandatory, not defensive.                                                                     | Drives §3.4.                                                                                                     |
| `find(filter, { sort, skip, limit, projection })` serves `orderBy`/`offset`/`limit`/`select` natively.                                                                | Same probe: sorted desc, skipped 1, limited 2, projected 2 fields.                                                       | All six `NormalizedQuery` members map; nothing is emulated in JavaScript.                                        |
| **`findOneAndUpdate` returns the document directly**, not `ModifyResult{value}`.                                                                                      | Same probe on driver 6.21.0 AND 7.6.0.                                                                                   | `update()` reads the result directly; the older `.value` shape would be `undefined`.                             |
| `deleteOne` → `{ deletedCount }`; transactions via `startSession()` roll back correctly.                                                                              | Same probe; abort left 0 rows.                                                                                           | `delete(): Promise<boolean>` is `deletedCount > 0`; §3.6 uses sessions.                                          |
| `ObjectId.isValid` accepts **only** 24-hex — `'abcdefghijkl'` (12 chars) is `false`.                                                                                  | `deno eval` against the real driver.                                                                                     | The conversion rule in §3.4 is a clean test, not a heuristic with a 12-byte edge case.                           |
| Driver CRUD behaviour is **identical on `mongodb@6.21.0` and `@7.6.0`** across all nine probed shapes, but v7.6.0 sends invalid handshake metadata under `deno test`. | Reproduced against the real Mongo 8 service; v6.21.0 connects and runs under the project's test runner.                  | Pin `npm:mongodb@^6.21.0` for the lazy import; injected clients from either major remain supported structurally. |
| **Transactions require a replica set.**                                                                                                                               | The probe's replica set is `rs0`; a standalone `mongod` rejects `startTransaction`.                                      | §3.6 refuses at `beginTransaction()`, never at `connect()`.                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                            | Resolution (picked side)                                                                                                                                                                                                                                                                                                                | Doc deliverable (same PR)                                                                                                                                                                                                                                                                |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:921` documents `'mongodb'` as a live arm of the exported `PrismaSqlProvider`, and `PASSTHROUGH_PROVIDERS` exists solely to serve it — but no Prisma v7 client for MongoDB can be constructed, so the arm is unreachable in practice. | **Keep the arm, document it as unreachable.** It is a published export and §9.2 governs: removal needs a working replacement path, and the replacement is a different adapter, not a different provider string. The `contains`/`$regex` reasoning behind `PASSTHROUGH_PROVIDERS` also stays correct for any future Prisma-Mongo client. | `PUBLIC_API.md` gains a note on the `'mongodb'` provider arm stating it is unreachable on Prisma v7 (generation succeeds; construction fails), naming the `'mongodb'` **adapter arm** as the supported route. A `@deprecated`-style JSDoc note on the union member, without removing it. |
| C2 | `ROADMAP.md` M78 frames the probe as deciding between "an adapter, a documented configuration, or a `'custom'`-arm example", and its in-scope bullet leans `'custom'`-arm.                                                                          | **First-class `'mongodb'` arm**, at the maintainer's direction (2026-08-29). A `'custom'`-arm example would leave every application hand-constructing the adapter and would keep the backend out of `DatabasePluginOptions`' discriminated union, where a missing per-arm option is a compile error (the M30/M50/M52c precedent).       | `ROADMAP.md` M78 in-scope bullet rewritten to record the probe's result and the arm decision, replacing the conditional "if Mongo comes back cheap" framing.                                                                                                                             |
| C3 | `ROADMAP.md` M78 states "a Mongo filter path through Prisma is already designed, documented and shipped, which narrows the probe below rather than invalidating it".                                                                                | True as written but now misleading: the path is shipped and unreachable.                                                                                                                                                                                                                                                                | Same ROADMAP edit adds one sentence recording that the path cannot execute on Prisma v7, cross-referencing C1.                                                                                                                                                                           |
| C4 | `ROADMAP.md` M78 says the probe "has not been taken" and is "this milestone's first deliverable".                                                                                                                                                   | Taken during planning, before the rest of the plan was written — which is what the ROADMAP asked for.                                                                                                                                                                                                                                   | ROADMAP records the probe as taken with its result, so a reader does not re-run it.                                                                                                                                                                                                      |

## 3. Design decisions

### 3.1 Backend route — native driver, not Prisma

- **Decision:** `MongoAdapter` talks to the `mongodb` driver directly. Prisma is not involved.
- **Why:** measured — a Prisma v7 client for MongoDB cannot be constructed (§1.1). The alternatives
  are pinning Prisma v6.19, which contradicts M66's v7 requirement and the package's own documented
  setup, or waiting for Prisma 8, which is a different product with a different CLI. A native driver
  also removes the Prisma Accelerate dependency the v7 union would otherwise imply.
- **Test home:** `test/integration/real-mongo-adapter.test.ts` drives CRUD through the adapter
  against the CI Mongo service; no Prisma package appears in the dependency graph.

### 3.2 Arm shape and client seam

- **Decision:** a `'mongodb'` member of the discriminated union with
  `options.mongo?: MongoAdapterOptions`, and the client supplied **inject-or-lazy** (§12.2):
  `MongoAdapterOptions.client` accepts a structural `IMongoClient`, and absent it the adapter lazily
  performs a literal `import('npm:mongodb@^6.21.0')` and constructs one from
  `MongoAdapterOptions.url`.
- **Why:** the discriminated union makes a missing `url`-and-`client` pair a compile error rather
  than a startup throw; the literal specifier satisfies M70e's recurrence gate (a computed specifier
  is refused by `scripts/npm-specifier-audit.ts`).
- **Test home:** `test/unit/barrel-exports.test.ts` checks the arm's public type behaviour, and
  `test/unit/mongo-client-seam.test.ts` covers the guarded real lazy import.

### 3.3 Identity mapping — `_id` ↔ the configured primary key

- **Decision:** documents are returned with the mapped primary-key name (default `'id'`) carrying
  the `_id` value as a **string**, and `_id` is removed from the returned record. On write, a
  supplied primary-key field is translated to `_id`. Per-entity overrides live in
  `MongoAdapterOptions.collections`, a `Record<entityName, MongoEntityMapping>` with
  `collection?: string` and `primaryKey?: string` — the D1 two-layer shape, collapsed by an internal
  unexported target the query builder consumes.
- **Why:** `IRepository`/`IDataSource` callers address `id`; leaking `_id` would make every consumer
  Mongo-aware, and returning an `ObjectId` instance would break `JSON.stringify` round-tripping in
  handlers. Following D1's whole shape rather than one type of it is the ROADMAP's stated precedent.
- **Test home:** `test/unit/mongo-mapping.test.ts` asserts both directions and the default.

### 3.4 ObjectId conversion for `findById`/`update`/`delete`

- **Decision:** a `string` id is converted to `ObjectId` when `ObjectId.isValid(id)` is true, and
  used raw otherwise. `MongoEntityMapping.idType?: 'objectId' | 'raw'` forces the branch explicitly.
- **Why:** measured — a raw 24-hex string does not match an `ObjectId` `_id` (§1.1), so conversion
  is mandatory. `isValid` is exactly a 24-hex test (12-char strings are rejected), so the automatic
  rule is precise. The genuinely ambiguous case is a collection whose `_id` values are 24-hex
  **strings**; no runtime test can distinguish it, which is why the override exists rather than
  being guessed.
- **Test home:** `test/unit/mongo-mapping.test.ts` covers both automatic branches and both forced
  ones, with the ambiguous-collection case named.

### 3.5 `rawQuery` — refused by name

- **Decision:** `rawQuery` rejects with a new exported `UnsupportedRawQueryError` naming the adapter
  and pointing at the injected client for native commands. It **rejects**, never throws
  synchronously.
- **Why:** MongoDB has no SQL. Emulating one would be the silent-divergence defect M70j closed; the
  `MemoryAdapter` precedent is to refuse. A named exported class rather than a bare `Error` so a
  consumer can `instanceof` it, matching `UnsupportedFilterOperatorError`. Synchronous throws from a
  `Promise`-typed method are the M52b/M52c/M70j defect class and are explicitly avoided.
- **Test home:** `test/unit/mongo-adapter.test.ts` asserts the rejection and that it is not
  synchronous (`expect(() => adapter.rawQuery('x')).not.toThrow()` before awaiting).

### 3.6 Transactions — sessions, and a late, named refusal

- **Decision:** `beginTransaction()` opens a driver session and calls `startTransaction()`;
  `commit`/`rollback` map to `commitTransaction`/`abortTransaction`, and the session is ended in a
  `finally`. A deployment without a replica set fails **here**, with the driver's own error wrapped
  in `MongoTransactionUnavailableError` naming the replica-set requirement — never at `connect()`.
- **Why:** transactions require a replica set (§1.1), but a standalone `mongod` is a legitimate
  deployment for an application that never opens one. Probing at `connect()` would cost a round trip
  on every boot and would refuse a working configuration — the M52 lesson that a health probe must
  not perform binding I/O, applied to startup.
- **Test home:** `test/unit/mongo-adapter.test.ts` covers the session contract, commit/rollback and
  the named non-replica-set refusal through the injected client seam. The CI Mongo service is
  intentionally standalone, so its real-driver integration suite exercises CRUD rather than a
  transaction a standalone deployment cannot support.

### 3.7 `contains` — regex-escaped, which is the inverse of the SQL case

- **Decision:** `contains` compiles to `{ $regex: escapeRegex(value), $options: '' }`, where
  `escapeRegex` escapes the regex metacharacters `.*+?^${}()|[]\`.
- **Why:** `PASSTHROUGH_PROVIDERS` correctly records that Mongo needs **no LIKE escaping**, because
  `%` and `_` are literal there. The native driver has the opposite hazard: `.` and `*` ARE special,
  so an unescaped search for `3.5` matches `315`. Missing this would be the same class of wrong
  answer M70b's X12-1 fixed from the other direction, and it is invisible to any test whose fixture
  has no metacharacter in it.
- **Test home:** `test/unit/mongo-query.test.ts` includes a value containing `.` and `*` with a
  negative control row that an unescaped pattern would also match. Case sensitivity follows the
  collection's collation and is documented, not overridden — the M68 precedent.

### 3.8 Filter translation and its two edge semantics

- **Decision:** `eq`/`gt`/`gte`/`lt`/`lte`/`in` map to `$eq`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`, and
  `and`/`or` to `$and`/`$or`. An **empty `in`** compiles to a match-nothing predicate; an `in` list
  **containing `null`** keeps `null` in the `$in` array, which Mongo matches for both a null value
  and a missing field, and that difference is documented.
- **Why:** M68 had to decide both cases for SQL and they do not carry over unchanged — SQL's `IN`
  never matches `NULL` whereas Mongo's `$in: [null]` also matches absent fields. Leaving it
  undecided is how an adapter silently disagrees with its siblings.
- **Test home:** `test/unit/mongo-query.test.ts`, plus a row in the existing
  `filter-conformance.test.ts` so every adapter is asserted to agree or refuse.

### 3.9 Lifecycle

- **Decision:** `connect()` calls the driver's `connect()` and records readiness; `isReady()`
  returns that flag without I/O; `disconnect()` closes the client and clears it.
- **Why:** matches the `IOrmAdapter` contract exactly, and keeps the `database` health indicator
  free of per-probe I/O (the M52/M70c principle).
- **Test home:** `test/unit/mongo-adapter.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                    | Kind      | Consumer / real code path that READS it                                                                                               |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `MongoAdapter`                     | class     | `createAdapter`'s new `case 'mongodb'` in `plugin/database-plugin.ts`; also constructible by an application for the `'custom'` arm.   |
| `MongoAdapterOptions`              | type      | The `'mongodb'` union arm; read by `MongoAdapter`'s constructor and by application code annotating its configuration.                 |
| `MongoEntityMapping`               | type      | `MongoAdapterOptions.collections` values; consumed by the internal target resolver.                                                   |
| `IMongoClient`                     | interface | The injection seam in `MongoAdapterOptions.client`; implemented structurally by the real driver and by the test double.               |
| `IMongoObjectIdCtor`               | interface | The optional injected-client companion in `MongoAdapterOptions.objectIdCtor`; preserves native ObjectId conversion without an import. |
| `UnsupportedRawQueryError`         | class     | Thrown by `MongoAdapter.rawQuery`; consumers `instanceof` it. Exported for the same reason `UnsupportedFilterOperatorError` is.       |
| `MongoTransactionUnavailableError` | class     | Thrown by `MongoAdapter.beginTransaction` on a non-replica-set deployment; distinguishes a configuration fault from a driver fault.   |

### 4.1 Options — every option names its consumer

| Option                             | Consumer                             | Behavior (per implementation)                                                                                                                                                    |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MongoAdapterOptions.url`          | `MongoAdapter.connect` lazy path     | Connection string used to construct a client when none is injected. Required in the union arm unless `client` is supplied.                                                       |
| `MongoAdapterOptions.client`       | `MongoAdapter.connect`               | An already-constructed `IMongoClient`. When present the lazy `import()` never runs — the seam that keeps the branching unit-testable.                                            |
| `MongoAdapterOptions.objectIdCtor` | `MongoAdapter.connect`               | The injected client's `ObjectId` constructor. It preserves automatic 24-hex conversion without importing the driver; omitted only when the collection uses raw ids.              |
| `MongoAdapterOptions.database`     | `MongoAdapter`'s collection resolver | Database name. Absent, the one encoded in `url` is used; absent from both, `connect()` fails at startup naming the option.                                                       |
| `MongoAdapterOptions.collections`  | internal target resolver (§3.3)      | Per-entity `{ collection?, primaryKey?, idType? }`. An unmapped entity uses the entity name as the collection and `'id'` as the primary key — zero-config default, the D1 shape. |
| `MongoEntityMapping.idType`        | §3.4 conversion                      | `'objectId'` forces conversion, `'raw'` forbids it, absent uses `ObjectId.isValid`.                                                                                              |

## 5. Implementation files

| File                                      | Purpose                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                            | Barrel: adds the seven symbols in §4.                                                                                          |
| `src/adapters/mongo/mongo-adapter.ts`     | `MongoAdapter` — lifecycle, `createDataSource`, `beginTransaction`, `rawQuery` refusal.                                        |
| `src/adapters/mongo/mongo-data-source.ts` | `IDataSource` implementation: the six methods over one collection.                                                             |
| `src/adapters/mongo/mongo-query.ts`       | Pure translation of `NormalizedQuery` → driver `filter` + `find` options; `FilterExpression` → Mongo operators; `escapeRegex`. |
| `src/adapters/mongo/mongo-mapping.ts`     | `MongoEntityMapping` → internal target; `_id` ↔ primary-key document mapping; ObjectId conversion.                             |
| `src/adapters/mongo/mongo-client.ts`      | `IMongoClient` structural facade and the `adaptMongoModule` / `loadMongoModule` inject-or-lazy seam.                           |
| `src/interfaces/index.ts`                 | The `'mongodb'` union arm and `MongoAdapterOptions` (modified).                                                                |
| `src/plugin/database-plugin.ts`           | One new `case 'mongodb'` (modified).                                                                                           |
| `src/errors.ts`                           | The two new error classes (modified).                                                                                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/mongo-adapter.test.ts`                        | `mongo-adapter.ts`     | Lifecycle against an injected `IMongoClient`; `rawQuery` **rejects** with `UnsupportedRawQueryError` and does not throw synchronously; `isReady()` performs no I/O. Calls type-check against `IDatabaseAdapter`.                                                                                                                                            |
| `test/unit/mongo-data-source.test.ts`                    | `mongo-data-source.ts` | All six `IDataSource` methods against a fake client that honours the real driver's shapes — `insertOne` → `{acknowledged,insertedId}`, `findOneAndUpdate` → the document directly, `deleteOne` → `{deletedCount}`. A double that returns `ModifyResult{value}` would be a contract-violating fixture (the recurring root cause) and is explicitly not used. |
| `test/unit/mongo-query.test.ts`                          | `mongo-query.ts`       | Every `NormalizedQuery` member and `FilterComparison` operator; `and`/`or`; equality conjunction; escaped `contains`; empty `in`; `in` containing `null`; `limit: -1` producing no limit.                                                                                                                                                                   |
| `test/unit/mongo-mapping.test.ts`                        | `mongo-mapping.ts`     | `_id` → `id` on read and back on write; `_id` absent from returned records; per-entity `collection`/`primaryKey` overrides; automatic and forced ObjectId branches; unmapped-entity defaults.                                                                                                                                                               |
| `test/unit/mongo-client-seam.test.ts`                    | `mongo-client.ts`      | `adaptMongoModule` against a fake module; injected-vs-lazy branching; and the guarded real lazy import.                                                                                                                                                                                                                                                     |
| `test/integration/real-mongo-adapter.test.ts`            | all Mongo `src`        | Guarded real `import('npm:mongodb@^6.21.0')` plus create → read-back → update → count → projection → delete against the standalone CI Mongo service. Read-back is mandatory per the M10 lesson.                                                                                                                                                             |
| `test/integration/filter-conformance.test.ts` (extended) | `mongo-query.ts`       | Mongo joins the existing cross-adapter conformance table — every adapter agrees or refuses by name.                                                                                                                                                                                                                                                         |
| `test/unit/barrel-exports.test.ts` (extended)            | `src/index.ts`         | The seven new symbols are exported; internal helpers and the resolved target type are NOT (the M56 defect class).                                                                                                                                                                                                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m78-document-database-backends, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree — a new adapter is new published surface
```

The guarded suites need a real replica set:

```bash
MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0' deno task test
```

`he-mongo` (`mongo:8`, `--replSet rs0`) serves it locally. CI gains a `mongo` service container and
`test/apps-gate.test.ts` pins it, so a dropped service fails rather than silently skipping — the M53
rule that a guarded suite which can skip in CI is a guarded suite that will.

## 8. Risks & mitigations

- **A test double that does not honour the real driver's return shapes** would hide a real defect —
  the root cause behind M37b, M53 and M55. Mitigation: the fake in §6 reproduces the shapes measured
  in §1.1, and the guarded real-Mongo suite is the backstop.
- **A standalone `mongod` in CI would make the transaction suite pass vacuously**, since
  `beginTransaction` would refuse and a lenient assertion could read that as success. Mitigation:
  the suite asserts a **committed** write is visible and a **rolled-back** one is not; both require
  a working replica set, so a standalone deployment fails the suite rather than skipping it.
- **Regex metacharacters in `contains`** are invisible to any fixture without one (§3.7).
  Mitigation: the negative-control row.
- **Prisma 8 may restore MongoDB**, making a second Mongo route exist. Mitigation: nothing here
  blocks that — the `'mongodb'` adapter arm and the `PrismaSqlProvider` `'mongodb'` provider string
  are independent, and C1's note names which is which.
- **Driver major drift**: `npm:mongodb@^6.21.0` is pinned because v7.6.0 is incompatible with
  `deno test`; applications may inject either compatible driver major through the structural seam.
  Mitigation: measured identical across both majors on every shape used (§1.1); the injected path is
  structural, so it does not care.

## 9. Out of scope

- **Composite keys, nested filter paths and cursor pagination** — **M79**. Mongo's single `_id`
  needs none of them, and pulling them forward would let one backend shape a portable contract.
- **DynamoDB (M80), Cosmos DB (M81), Cloud Bigtable (M82).**
- **TTL indexes, read/write concern and secondary-index selection** — excluded by M79's out-of-scope
  bullet; an application reaches the injected client directly, exactly as it does for a Prisma raw
  query.
- **Aggregation pipelines and change streams** — no portable contract member expresses them, and
  inventing one for a single adapter is the `poolSize` defect.
- **Restoring a Prisma-backed Mongo path** — blocked upstream; if Prisma 8 restores it, that is its
  own milestone and C1's note is the pointer.
