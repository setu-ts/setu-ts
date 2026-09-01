# Milestone 81 — Azure Cosmos DB backend (`@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m81-cosmos-db-backend`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Ship a first-class Azure Cosmos DB backend for the NoSQL (SQL) API as a new `'cosmos'` arm of the
discriminated `DatabasePluginOptions` union, serving every member of the portable contract natively
where Cosmos has a native answer and refusing the remainder by name. The framework ships a
first-class Cloudflare backend and four cloud message brokers and has no Azure database story at
all; this closes that gap for the API that has no other route into the framework. M79's composite
keys, nested filter paths and keyset cursor are the contract this consumes — Cosmos is that
milestone's third consumer, and no `common` change is needed.

**The probe this milestone opens with was taken during planning and it decides the shape.** Measured
against the real emulator (`he-cosmos`, `azure-cosmos-emulator:vnext-preview`, 2026-09-01), the
`npm:mongodb@6.21.0` driver cannot speak to the NoSQL endpoint at all — the connection is closed
during handshake (P49) — so `MongoAdapter` cannot serve it and a native adapter over
`npm:@azure/cosmos@^4` is required. The other half of the probe is **unrunnable**, and that is
itself a finding: the only emulator image carrying a MongoDB endpoint
(`azure-cosmos-emulator:mongodb`) was built 2024-04-23 and now refuses to start with
`Error: The evaluation period has expired.`, and no vCore/Mongo emulator repository exists on MCR
(404 on every candidate name). So the Mongo-compatible API is **documented** as the existing
`'mongodb'` arm pointed at a Cosmos Mongo connection string, explicitly labelled unverified against
a live account — the M30b/M52 precedent for a capability that ships without a live backend to test
it — and it is not claimed as tested.

- **In scope:** the `CosmosAdapter` and its `'cosmos'` arm; the two-layer per-entity mapping
  (container name, primary-key field, partition-key path) with partition-key discovery from the
  container definition; native translation of all six `NormalizedQuery` members; keyset `findPage`;
  deferred-batch transactions scoped to one container and one partition-key value; refuse-by-name
  for `rawQuery`, a non-string id, a partition-key-changing update, and an out-of-scope batch; a
  guarded real-emulator suite; documentation of the Mongo-API route.
- **NOT this milestone:** request-unit budgeting, consistency levels, TTL and index-policy
  management (M79's out-of-scope list — each is spelled differently by every backend and belongs
  with the adapter that first needs it, and none has a second consumer); Cloud Bigtable is **M82**;
  DynamoDB is **M80** and is developed in parallel on its own branch, so this plan takes nothing
  from it and shares no file with it.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                         | Source (file:line)                                                         | Verified surface / fact                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDatabaseAdapter`                                                | `packages/common/src/services/database.ts:317`                             | Extends `IOrmAdapter`; adds `createDataSource(entity)`, `beginTransaction(): Promise<IAdapterTransaction>`, `rawQuery<T>(sql, params?)`                                                                                                                          |
| `IOrmAdapter`                                                     | `packages/common/src/services/database.ts:39`                              | `connect`/`disconnect`/`isReady`/`beginTransaction` — lifecycle only                                                                                                                                                                                             |
| `IDataSource`                                                     | `packages/common/src/services/database.ts:195`                             | Six members: `findAll`, `findById`, `create`, `update`, `delete`, `count`, plus the OPTIONAL `findPage?` at `:260`                                                                                                                                               |
| `IDataSource` deferred-write clause                               | `packages/common/src/services/database.ts:181-190`                         | The contract already sanctions a backend that buffers writes and applies them at commit, and requires it be documented (D1 is the worked example)                                                                                                                |
| `EntityKey`                                                       | `packages/common/src/services/database.ts:124`                             | `string \| number \| Readonly<Record<string, string \| number>>` — a composite key is a RECORD, never an array                                                                                                                                                   |
| `NormalizedQuery`                                                 | `packages/common/src/services/database.ts:155-179`                         | `where`, `filter?`, `orderBy`, `limit` (`-1` = unlimited, `:163`), `offset` (`:165`), `cursor?` (`:173`), `select`                                                                                                                                               |
| `PageResult`                                                      | `packages/common/src/services/database.ts:132`                             | `{ rows, nextCursor: string \| null }`; `nextCursor` is `null` exactly when the adapter fetched no more than `limit`                                                                                                                                             |
| `FilterExpression` / `FilterComparison`                           | `packages/common/src/services/database.ts:108` / `:76-104`                 | Four comparison arms; `field` is `string \| readonly string[]` (M79 nested path); the ordered arm accepts `string \| number \| Date`                                                                                                                             |
| Keyset machinery                                                  | `packages/common/src/services/cursor.ts:100,121,160,213,275,315`           | `encodeCursor`, `decodeCursor`, `resolveKeysetSort`, `keysetPredicate`, `sortFingerprint`, `mintNextCursor` — all pure, all reusable; `keysetPredicate` returns a `FilterExpression`, so an adapter that translates one gets paging with no new translation code |
| `normalizePageQuery` / `PageNormalizationError` / `projectFields` | `packages/database-plugin/src/query/query-builder.ts:85,53,273`            | Package-internal shared helpers the Mongo `findPage` already funnels through — the offset+cursor refusal (§3.10 of M79) lives in `normalizePageQuery`, not in each adapter                                                                                       |
| `UnsupportedQueryFeatureError`                                    | `packages/database-plugin/src/errors.ts:123`                               | `(feature, adapter, message)` — the shipped refuse-by-name class for a query member an adapter cannot serve                                                                                                                                                      |
| `UnsupportedRawQueryError`                                        | `packages/database-plugin/src/errors.ts:86`                                | The class `MongoAdapter.rawQuery` rejects with                                                                                                                                                                                                                   |
| `MongoAdapter` two-arm options union                              | `packages/database-plugin/src/interfaces/index.ts` (`MongoAdapterOptions`) | The precedent this arm copies: a union whose arms each require one of the two ways to supply a client, so supplying neither is a compile error                                                                                                                   |
| Adapter construction                                              | `packages/database-plugin/src/plugin/database-plugin.ts:152,168,186`       | `createAdapter` switches on the arm and `buildAdapterOptions` carries an untyped bag through, which is why each adapter constructor keeps a runtime guard as the backstop for that cast                                                                          |
| D1 deferred batch                                                 | `packages/cloudflare-plugin/src/database/d1-adapter.ts:114-119,206-226`    | The shipped precedent for "the platform offers atomicity only as a pre-declared batch": buffer every write, flush as one `batch()` at commit, discard on rollback                                                                                                |
| `MongoAdapter` connect/`#establish`                               | `packages/database-plugin/src/adapters/mongo/mongo-adapter.ts:88-133`      | The shipped shape this adapter copies: an in-flight attempt shared by concurrent callers and NEVER cached past settlement, and a client this adapter created is closed on failure while an injected one is not                                                   |

### 1.1 Facts measured against the real backend

Every row below was measured on `azure-cosmos-emulator:vnext-preview` at `http://127.0.0.1:8082/`
with `npm:@azure/cosmos@4` on 2026-09-01 (probe scripts kept in the session scratchpad; the
measurements are restated in the code comments that depend on them).

| #                      | Measured fact                                                                                                                              | What it decides                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| P49                    | The `mongodb` driver cannot connect to the NoSQL endpoint                                                                                  | A native adapter is required (§0)                                                                 |
| P2/P3/P4/P57           | A point read with the wrong or absent partition key answers **404 with `resource: undefined`**, and does not throw                         | §3.5 pk validation; §3.6 read path branches on `resource`, never try/catch                        |
| P5/P40                 | A cross-partition `WHERE c["id"] = @id` finds the row, but the same `id` may exist in two partitions                                       | §3.6 scalar fallback with a two-row probe and a refusal                                           |
| P6/P58/P60             | `id` must be a string; `/` in an id is refused; `create` with no id gets an SDK-generated UUID                                             | §3.7 non-string id refused by name; §3.9 create                                                   |
| P43/P50                | `container.read()` exposes `partitionKey.paths` and `kind`; `MultiHash` point reads take an array                                          | §3.5 discovery and hierarchical keys                                                              |
| P7/P33/P34/P70/P71/P72 | `OFFSET n LIMIT m` is native and parameterizable; `LIMIT -1` is a 400 and `OFFSET` without `LIMIT` is a 400                                | §3.11 offset is served natively, and `limit: -1` must OMIT the clause rather than pass through    |
| P8/P9/P19              | A continuation token is returned for a query with no `ORDER BY` and **never for one with it** — `maxItemCount` is ignored there            | §3.8 the portable keyset cursor is used, not the native token (C1)                                |
| P56                    | The portable keyset predicate compiles and returns exactly the rows after the cursor                                                       | §3.8                                                                                              |
| P22                    | `CONTAINS` is a literal substring match, case-sensitive, with a third `true` for case-insensitive                                          | §3.13 no escaping, and the collation caveat                                                       |
| P52/P53/P62/P54        | `ARRAY_CONTAINS(@vals, c["f"])` binds one array parameter; `[]` matches nothing; `[null]` matches an explicit null but not a missing field | §3.13 `in`, including the empty-list and null cases M79's D1 builder needed explicit branches for |
| P29                    | `c["f"] = null` matches an explicit null only                                                                                              | §3.13 `eq: null`                                                                                  |
| P12/P51                | Nested paths and bracket addressing work in `WHERE`, `SELECT` and `ORDER BY`                                                               | §3.12 every field is bracket-addressed                                                            |
| P48                    | The SDK stores a `Date` as an ISO string                                                                                                   | §3.13 a `Date` filter value and a `Date` cursor value compile to their ISO form                   |
| P13/P78                | Reads carry `_rid`/`_self`/`_etag`/`_attachments`/`_ts`; a projection omits absent fields                                                  | §3.14 system properties are stripped at the boundary                                              |
| P11/P23/P44/P76        | `SELECT VALUE COUNT(1)` works with a filter and cross-partition; `WHERE true` is a legal identity                                          | §3.13 count, and the empty-group identities                                                       |
| P14/P36/P63/P64        | `delete` answers 204 and **throws 404** for a missing item; `patch`/`replace` throw 404                                                    | §3.9 delete returns `false` on 404; update throws when no row has the key                         |
| P15/P21/P21b           | `patch` sets fields server-side; the emulator accepted 11 operations; it cannot create a path whose parent is absent                       | §3.10 patch primary, replace fallback                                                             |
| P65/P66                | `accessCondition: { type: 'IfMatch', condition: _etag }` works, and a stale etag answers **412**                                           | §3.10 the fallback's lost-update guard                                                            |
| P26b                   | A `replace` that changes the partition-key value answers 404 — an item cannot move partitions                                              | §3.10 a pk-changing update is refused by name                                                     |
| P16/P17/P18/P61        | `items.batch(ops, pk)` is atomic, is refused across partition-key values (400), and is capped at **100 operations per partition**          | §3.15 transactions                                                                                |
| P25/P45/P55/P69        | A duplicate id is a 409; a missing container/database is a 404 naming it; nothing is created implicitly                                    | §3.4 containers must pre-exist                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                        | Doc deliverable (same PR)                                                                                 |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M81 puts "continuation-token pagination" in scope; measured, Cosmos returns **no** continuation token for any `ORDER BY` query (P9/P19), and `PageResult.nextCursor` is already served by the portable keyset cursor every other adapter uses | The portable keyset cursor. The native token is rejected with cause, not overlooked                                                                                             | Rewrite the M81 ROADMAP in-scope bullet to name the keyset cursor and the measurement that chose it       |
| C2 | ROADMAP M81 frames the milestone as "one adapter or two" and leaves the probe to decide                                                                                                                                                               | One native NoSQL adapter; the Mongo-compatible API is the existing `'mongodb'` arm, documented and labelled unverified                                                          | ROADMAP M81 records the probe result, including that the Mongo-API emulator has expired and cannot be run |
| C3 | ROADMAP M81 says the packages are "`database-plugin`, or a new package if the probe says the NoSQL API needs one"                                                                                                                                     | `database-plugin` only. A separate package buys nothing and splits one capability's documentation across two READMEs — the M80 recommendation, applied here for the same reason | ROADMAP M81 packages line fixed to `database-plugin`                                                      |
| C4 | ROADMAP M78's blocker list calls partition awareness a portable-contract gap; M79 then excluded it as per-entity **mapping** rather than portable surface, naming M81's partition key as one of the three                                             | No conflict to resolve in code — M79's reading is the one this milestone implements, and the mapping is per-entity                                                              | None (M79 already corrected the text; cited here so the reader is not left to reconcile them)             |

Checked: `PUBLIC_API.md` `### MongoDB backend`, `ARCHITECTURE.md` §`@setu-ts/database-plugin`,
`packages/database-plugin/README.md`, `ROADMAP.md` M78/M79/M81. No other file mentions Cosmos —
`grep -ric cosmos` over the four top-level docs returns 0, which is the gap this milestone closes.

## 3. Design decisions

### 3.1 Which Cosmos API this milestone serves

- **Decision:** The NoSQL (SQL) API, over `npm:@azure/cosmos@^4`, as a new `'cosmos'` arm. The
  MongoDB-compatible API is served by the existing `'mongodb'` arm and is documented, not
  implemented again.
- **Why:** measured — the `mongodb` driver cannot speak to a NoSQL endpoint (P49), so the NoSQL API
  has no route into the framework today, while the Mongo API already has one. Shipping a second
  Mongo-shaped adapter would be the duplicated-logic defect (§11.1).
- **Test home:** `test/integration/real-cosmos-adapter.test.ts` (guarded) drives the NoSQL arm end
  to end; the Mongo-API claim is documentation, explicitly labelled unverified, and asserts nothing.

### 3.2 Client seam — inject-or-lazy, two-arm union

- **Decision:** `CosmosAdapterOptions` is a union of two arms exactly like `MongoAdapterOptions`:
  one requires `{ endpoint, key }`, the other requires `{ client }` (a structural `ICosmosClient`).
  `database` is required on both. Absent a client, `connect()` performs a literal
  `import('npm:@azure/cosmos@^4')` and constructs one.
- **Why:** §12.2, and the two-arm union makes a registration that supplies neither a compile error
  rather than a `connect()` throw — the guarantee every other built-in arm gives. Managed-identity
  and connection-string constructions are reached by injecting a client, so the adapter never grows
  a credential surface it would have to keep in step with the SDK.
- **Test home:** `test/unit/cosmos-client-seam.test.ts` (both loader branches against a fake module)
  and `test/integration/real-import.test.ts` (guarded real `npm:` import).

### 3.3 Entity mapping — the two-layer D1/Mongo shape

- **Decision:** `CosmosEntityMapping` is the public per-entity override (`container?`, `primaryKey?`
  defaulting to `'id'`, `partitionKey?` naming the document field path or paths), collapsed into an
  internal, unexported `CosmosTarget` (`container`, `primaryKey: readonly string[]`,
  `partitionKeyPaths: readonly string[] | null`).
- **Why:** the shipped two-layer shape (`D1EntityMapping` → `D1Target`, `MongoEntityMapping` →
  `MongoTarget`). Leaking the resolved target would make one adapter's container naming part of the
  published contract (the M56 defect class).
- **Test home:** `test/unit/cosmos-mapping.test.ts`.

### 3.4 Containers must pre-exist; the adapter creates nothing

- **Decision:** the adapter never creates a database or a container. A missing one is refused by
  name at first use, naming the database, the container and the entity.
- **Why:** measured (P45/P55/P69) — Cosmos creates nothing implicitly, and a container carries
  throughput, partition-key and indexing decisions that belong to the application's provisioning,
  not to a framework package guessing them. Drizzle's required table registry is the in-repo
  precedent for "the schema is the application's".
- **Test home:** `test/unit/cosmos-data-source.test.ts` (fake answering 404) and the guarded real
  suite.

### 3.5 Partition-key resolution — discovered, then validated

- **Decision:** the resolved partition-key paths come from the container definition
  (`container.read()` → `partitionKey.paths`), read **once per container** behind a cached promise,
  unless the mapping declares `partitionKey`. When the mapping declares one and the container
  disagrees, the first use is refused by name showing both. The same cached read is what proves the
  container exists (§3.4), so discovery costs no extra round trip.
- **Why:** measured (P3/P4/P57) a wrong partition key is a **silent 404**, not an error, so a
  mistyped path would make every point read answer "not found" against a healthy database. This is
  the M52c/M52d binding-guard class — fail at first use with a name rather than answer wrongly
  forever. Discovery also removes the configuration entirely for the common case.
- **Test home:** `test/unit/cosmos-partition-key.test.ts` — discovery, agreement, and the
  disagreement refusal; the guarded real suite drives it against a real container definition.

### 3.6 `findById` — point read when the partition key is derivable, query otherwise

- **Decision:** three resolved cases, in order. (a) The key is an `EntityKey` **record** carrying
  every partition-key field plus the primary-key field: a point read. (b) The key is scalar and the
  container's partition-key path names the primary-key field itself: a point read with the id as the
  partition-key value. (c) The key is scalar and the partition key is a different field: a
  cross-partition query `WHERE c["<pk>"] = @id` with `LIMIT 2`; one row is returned, and **two rows
  are refused by name** telling the caller to supply the partition key.
- **Why:** measured — (c) works (P5) but an `id` is unique only within a partition (P40), so a
  first-match-wins fallback would silently return one of two different rows. Refusing only the
  genuinely ambiguous case keeps the ergonomic path open while never answering wrongly. The extra RU
  cost of the cross-partition read is documented rather than hidden.
- **Test home:** `test/unit/cosmos-data-source.test.ts` (all three cases plus the two-row refusal).

### 3.7 A non-string primary key is refused by name

- **Decision:** a primary-key value that is not a string is refused by name on every entry point
  (`findById`, `update`, `delete`, and `create` when the row carries one), naming Cosmos's own rule.
  A **partition-key** value of another JSON scalar type is passed through untouched.
- **Why:** measured (P6) — Cosmos rejects `create({ id: 7 })` with `Id must be a string.`
  Stringifying silently would make `create()` return an id of a different type than the caller
  passed, which is exactly the round-trip defect M78 fixed in `fromDriverId`. The partition key has
  no such constraint (P67), so the refusal is scoped to the id.
- **Test home:** `test/unit/cosmos-data-source.test.ts`.

### 3.8 `findPage` — the portable keyset cursor, not the native continuation token

- **Decision:** `findPage` reuses the shared machinery every other adapter uses:
  `normalizePageQuery` → `decodeCursor` → `sortFingerprint` guard → `keysetPredicate` conjoined with
  the caller's filter → one `limit + 1` probe → `mintNextCursor`. The native continuation token is
  not used.
- **Why:** measured — Cosmos returns **no** continuation token for any `ORDER BY` query (P9/P19),
  and a page without a stable sort is not a page. The keyset predicate compiles natively and returns
  exactly the right rows (P56). Reusing the shared builder is also what keeps the six adapters from
  drifting about what "the next page" means, and it carries the fingerprint guard a token cannot
  express. This overturns the ROADMAP's stated mechanism (C1).
- **Test home:** `test/unit/cosmos-page.test.ts` plus the guarded real suite, which walks a page
  boundary over rows carrying deliberate ties.

### 3.9 `create` / `delete`

- **Decision:** `create` maps to `items.create` and returns the created document with system
  properties stripped; a duplicate id surfaces as the SDK's 409 error. `delete` maps to
  `item(id, pk).delete()` and returns `true` on success, `false` when the SDK throws 404.
- **Why:** measured (P25, P14/P36). The contract's `delete` returns `false` when none matched, and
  Cosmos signals that as a throw rather than a count, so it must be caught rather than propagated.
- **Test home:** `test/unit/cosmos-data-source.test.ts`.

### 3.10 `update` — patch first, replace as the documented fallback

- **Decision:** one merge implementation feeding two paths. When the payload has at most 10 fields,
  one `patch` of `set` operations (server-side, no read). Above that, read → merge → `replace` with
  `accessCondition: { type: 'IfMatch', condition: _etag }`, and a 412 is refused by name as a
  concurrent modification. A 404 on the patch path and on the replace path alike throws, per the
  contract. A payload that would change the primary key or any partition-key field is refused by
  name **before** any request.
- **Why:** patch is the semantics the other adapters have (`$set`, `SET`) and has no read-modify
  race; the documented per-request cap of 10 operations is why the fallback exists at all (the
  emulator accepted 11 — P21 — so the cap cannot be measured here and the conservative side is the
  correct one). The pk guard is measured: a `replace` that moves an item answers **404** (P26b), so
  without the guard an ordinary update would report "no such row" for a row that exists.
- **Test home:** `test/unit/cosmos-update.test.ts` — both paths under a non-default configuration,
  the 412, the 404, and the pk-change refusal.

### 3.11 `offset` and `limit` are served natively

- **Decision:** `offset`/`limit` compile to `OFFSET @o LIMIT @l`. A `limit` of `-1` (the contract's
  "unlimited") emits **no** `LIMIT` clause when the offset is zero, and `LIMIT 2147483647` when an
  offset is present, because Cosmos rejects `OFFSET` without `LIMIT`.
- **Why:** measured — `LIMIT -1` is a 400 (P70) and a bare `OFFSET` is a 400 (P71), while
  `LIMIT 2147483647` is accepted (P72). Passing the sentinel through would make every unlimited
  query fail. Unlike DynamoDB (M80), Cosmos needs no offset refusal at all.
- **Test home:** `test/unit/cosmos-query.test.ts` (emitted text for all four combinations).

### 3.12 Every field is bracket-addressed

- **Decision:** identifiers are emitted as `c["field"]`, and a nested path as `c["a"]["b"]`. Values
  are always bound as `@pN` parameters, never interpolated.
- **Why:** measured (P35/P51) — bracket addressing serves reserved words and names carrying spaces,
  which dotted addressing cannot. Binding every value is the M52c rule (identifiers cannot be bound,
  so they are validated and quoted; values are always bound).
- **Test home:** `test/unit/cosmos-query.test.ts`.

### 3.13 Filter translation

- **Decision:** `eq` → `=` (a `null` value stays `= null`, matching explicit nulls only);
  `gt`/`gte`/`lt`/`lte` → the SQL operators with a `Date` bound as its ISO string; `contains` →
  `CONTAINS(c["f"], @p)` with **no escaping**; `in` → `ARRAY_CONTAINS(@p, c["f"])` binding the list
  as one array parameter; `and`/`or` → parenthesised groups whose empty forms compile to `true` and
  `false` respectively.
- **Why:** each is measured (P29, P48, P22, P52/P53/P62, P76). Two are worth naming: `CONTAINS` is a
  literal substring match, so the `%`/`_` escaping the SQL adapters need would be a corruption here
  — the inverse of the same reasoning `MongoAdapter` records for `$regex`; and `ARRAY_CONTAINS`
  gives the empty-`in` match-nothing case for free, where M79's D1 builder needed an explicit
  branch.
- **Test home:** `test/unit/cosmos-query.test.ts`, and the shipped
  `test/unit/filter-conformance.test.ts` gains the Cosmos row so all six adapters are asserted to
  agree (or refuse) on one query.

### 3.14 System properties are stripped at the boundary

- **Decision:** `_rid`, `_self`, `_etag`, `_attachments` and `_ts` are removed from every row the
  adapter returns. The `_etag` is read internally by the replace fallback (§3.10) before stripping.
- **Why:** they are the driver's metadata, not the application's row; returning them would leak one
  backend's document shape into a portable repository result — the same reason `MongoAdapter` never
  returns `_id`.
- **Test home:** `test/unit/cosmos-data-source.test.ts` and the guarded real suite (which is the
  only place the real property set can be observed).

### 3.15 Transactions — a deferred batch, scoped by construction

- **Decision:** `beginTransaction()` returns a handle that buffers every write and flushes the whole
  buffer as one `items.batch(operations, partitionKeyValue)` at `commit()`; `rollback()` discards
  it. The handle refuses by name, at the write that causes it, when a second container or a second
  partition-key value is written, and when the buffer would exceed 100 operations. Reads inside the
  transaction observe committed state only.
- **Why:** measured — the batch is genuinely atomic (P17), is refused across partition-key values
  (P18) and is capped at 100 per partition (P61). The D1 precedent decides the shape: refusing
  transactions outright was rejected there because the platform does offer atomicity, and refusing
  would strand the committed `IDatabaseService.transaction()`. Refusing at the offending write
  rather than at commit is what makes the constraint legible — a caller learns which write broke the
  scope, not merely that the batch did.
- **Test home:** `test/unit/cosmos-transaction.test.ts` (buffering, flush shape, all three refusals,
  rollback sending nothing) plus the guarded real suite (real atomicity and real rollback).

### 3.16 `rawQuery` is refused by name

- **Decision:** `rawQuery` rejects with `UnsupportedRawQueryError`, naming the injected client as
  the route for native SQL.
- **Why:** Cosmos has a SQL dialect, but every query is scoped to one container and
  `rawQuery(sql, params)` has nowhere to name it. Guessing a container would be the
  silent-divergence defect; the honest refusal names why and points at the client. It rejects rather
  than throwing synchronously — the M52b/M52c/M70j defect class.
- **Test home:** `test/unit/cosmos-adapter.test.ts`.

### 3.17 Connect, disconnect, readiness

- **Decision:** `connect()` resolves the client (injected or lazily imported), then reads the
  database (`database.read()`) to prove the credentials and the database name; a failure closes only
  a client this adapter created. Concurrent callers share one in-flight attempt, never cached past
  settlement. `disconnect()` releases the client and clears the per-container caches.
- **Why:** the shipped `MongoAdapter.#establish` shape, cited in §1 — assigning the field before the
  connection is established made every later `connect()` a no-op while `isReady()` stayed false. The
  database read is the cheapest proof that the configuration is usable (P68/P69).
- **Test home:** `test/unit/cosmos-adapter.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                               | Kind                 | Consumer / real code path that READS it                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CosmosAdapter`                                                                                               | class                | `createAdapter`'s `'cosmos'` arm in `plugin/database-plugin.ts`; also constructible by an application for the `'custom'` arm                              |
| `CosmosDatabaseOptions`                                                                                       | interface            | A member of `BuiltInDatabaseOptions`, so `DatabasePlugin({ type: 'cosmos', … })` type-checks                                                              |
| `CosmosAdapterOptions`                                                                                        | type (two-arm union) | The `options` bag of the arm above; read by the `CosmosAdapter` constructor                                                                               |
| `CosmosAdapterOptionsBase`                                                                                    | interface            | The shared half both arms extend; nameable by an application building a configuration incrementally, exactly as `MongoAdapterOptionsBase` is              |
| `CosmosEntityMapping`                                                                                         | interface            | `options.containers` values; resolved by `resolveCosmosTarget` into the internal target                                                                   |
| `ICosmosClient`, `ICosmosDatabase`, `ICosmosContainer`, `ICosmosItem`, `ICosmosItems`, `ICosmosQueryIterator` | interfaces           | The injected-client seam: an application injecting a real `CosmosClient` annotates it with these, and `cosmos-data-source.ts` calls exactly these members |
| `CosmosQueryParameter`                                                                                        | interface            | The parameter shape the query builder emits and the seam accepts                                                                                          |
| `CosmosTransactionScopeError`                                                                                 | class                | Thrown by the transaction handle for all three scope refusals (§3.15); a consumer catches it by `instanceof`                                              |
| `CosmosConcurrentModificationError`                                                                           | class                | Thrown by the replace fallback on a 412 (§3.10)                                                                                                           |

Not exported, deliberately: `CosmosTarget` (the resolved internal target — §3.3), the query-builder
functions, and the data-source factory's internals. `UnsupportedQueryFeatureError` and
`UnsupportedRawQueryError` are already exported and are reused rather than duplicated.

### 4.1 Options — every option names its consumer

| Option       | Consumer                                      | Behavior (per implementation)                                                                                                                                                 |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`   | `CosmosAdapter.#establish` lazy branch        | Passed to the constructed `CosmosClient`; unread when `client` is injected                                                                                                    |
| `key`        | same                                          | The account key; unread when `client` is injected                                                                                                                             |
| `client`     | `CosmosAdapter.#establish` injected branch    | Used verbatim; the lazy `import('npm:@azure/cosmos@^4')` never runs, and the client is not closed on a connect failure because the application owns it                        |
| `database`   | `CosmosAdapter.#establish`, every data source | Required on both arms — Cosmos encodes no database in an endpoint, so there is nothing to fall back to                                                                        |
| `containers` | `resolveCosmosTarget`                         | Per-entity `{ container?, primaryKey?, partitionKey? }`; an unmapped entity uses its own name as the container, `'id'` as the key, and discovery (§3.5) for the partition key |
| `logQueries` | `DatabaseService`'s existing logging wrapper  | Unchanged behaviour — the wrapper is shared by every adapter, so this arm needs no code of its own                                                                            |

## 5. Implementation files

| File                                          | Purpose                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/adapters/cosmos/cosmos-client-types.ts`  | Internal structural facade for `@azure/cosmos` — exactly the members the adapter calls, so the driver's classes are never imported         |
| `src/adapters/cosmos/cosmos-client.ts`        | The inject-or-lazy loader seam (`createInjectedClientLoader` / `createLazyClientLoader`), the one literal `import('npm:@azure/cosmos@^4')` |
| `src/adapters/cosmos/cosmos-mapping.ts`       | `CosmosEntityMapping` → `CosmosTarget`; row ↔ document mapping and system-property stripping                                               |
| `src/adapters/cosmos/cosmos-query.ts`         | Pure `NormalizedQuery` → `{ query, parameters }` builder: filters, ordering, offset/limit, projection, count                               |
| `src/adapters/cosmos/cosmos-partition-key.ts` | Per-container partition-key discovery, caching, and the configured-versus-actual refusal                                                   |
| `src/adapters/cosmos/cosmos-data-source.ts`   | The six `IDataSource` members plus `findPage`, and the transaction-scoped data source                                                      |
| `src/adapters/cosmos/cosmos-transaction.ts`   | The deferred-batch `IAdapterTransaction` and its three scope refusals                                                                      |
| `src/adapters/cosmos/cosmos-adapter.ts`       | `CosmosAdapter` — lifecycle, `createDataSource`, `beginTransaction`, the `rawQuery` refusal                                                |
| `src/errors.ts`                               | Adds `CosmosTransactionScopeError` and `CosmosConcurrentModificationError`                                                                 |
| `src/interfaces/index.ts`                     | Adds the `'cosmos'` arm to `DatabaseAdapterType`/`BuiltInDatabaseOptions` and the option types                                             |
| `src/plugin/database-plugin.ts`               | Adds the `'cosmos'` case to `createAdapter`                                                                                                |
| `src/index.ts`                                | Barrel exports for §4                                                                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                             | src covered                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/cosmos-mapping.test.ts`                    | `cosmos-mapping.ts`                   | `resolveCosmosTarget(entity, mapping)` defaults and overrides; row ↔ document round trip; all five system properties stripped                                                                                                                 |
| `test/unit/cosmos-query.test.ts`                      | `cosmos-query.ts`                     | Emitted text and parameters for every filter arm against `NormalizedQuery` (`where`, `filter`, `orderBy`, `limit: -1`, offset+limit, `select`); bracket addressing; empty `and`/`or` identities; `Date` bound as ISO                          |
| `test/unit/cosmos-partition-key.test.ts`              | `cosmos-partition-key.ts`             | Discovery from a fake container definition; one read per container (call count); configured-versus-actual refusal names both; a missing container refused by name                                                                             |
| `test/unit/cosmos-data-source.test.ts`                | `cosmos-data-source.ts`               | All six `IDataSource` members against a faithful fake honouring the measured shapes (404 read returns `resource: undefined`; delete throws 404); the three `findById` cases and the two-row refusal; non-string id refusal                    |
| `test/unit/cosmos-update.test.ts`                     | `cosmos-data-source.ts` (update path) | Patch path at 10 fields, replace path at 11, the 412 refusal, the 404 throw, and the pk-change refusal                                                                                                                                        |
| `test/unit/cosmos-page.test.ts`                       | `cosmos-data-source.ts` (`findPage`)  | `limit + 1` probe, `nextCursor` null on the last page, fingerprint-mismatch refusal, malformed-token refusal, offset+cursor refusal (through `normalizePageQuery`)                                                                            |
| `test/unit/cosmos-transaction.test.ts`                | `cosmos-transaction.ts`               | Buffering, one `batch` call carrying the operations in order, rollback issuing nothing, and the three scope refusals                                                                                                                          |
| `test/unit/cosmos-adapter.test.ts`                    | `cosmos-adapter.ts`                   | Constructor guard, connect/disconnect/`isReady`, the shared in-flight attempt, a created client closed on failure while an injected one is not, `rawQuery` REJECTS rather than throwing synchronously                                         |
| `test/unit/cosmos-client-seam.test.ts`                | `cosmos-client.ts`                    | Both loader branches against a fake module; the injected branch never calls the loader                                                                                                                                                        |
| `test/unit/filter-conformance.test.ts` (existing)     | cross-adapter                         | Gains the Cosmos row so all six adapters agree or refuse on one query                                                                                                                                                                         |
| `test/unit/barrel-exports.test.ts` (existing)         | `src/index.ts`                        | Gains every §4 symbol, so dropping one fails (the M56 defect class)                                                                                                                                                                           |
| `test/unit/plugin-options-types.test.ts` (existing)   | `interfaces/index.ts`                 | A `'cosmos'` registration missing `database` is a compile error (`@ts-expect-error`)                                                                                                                                                          |
| `test/integration/database-plugin.test.ts` (existing) | `plugin/database-plugin.ts`           | The `'cosmos'` arm constructs a `CosmosAdapter` and the plugin registers it                                                                                                                                                                   |
| `test/integration/real-cosmos-adapter.test.ts`        | every file above                      | Guarded on `COSMOS_ENDPOINT`, via `ignore:` so a skip is visible: create/read-back/update/delete through the repository, a keyset page walk over deliberate ties, discovery against a real container, a real atomic batch and a real rollback |
| `test/integration/real-import.test.ts` (existing)     | `cosmos-client.ts`                    | Gains a guarded real `import('npm:@azure/cosmos@^4')` case                                                                                                                                                                                    |

The fakes reproduce the measured driver shapes rather than convenient ones — the recurring
contract-violating-double defect this repo keeps hitting (M37b ioredis, M53 `zrangebyscore`, M55
`Deno.FsFile.read`, M78's own `insertOne`). Two are specifically at risk here and are pinned by
§1.1: a point read answering 404 must return `{ statusCode: 404, resource: undefined }` and NOT
throw, while `delete`, `patch` and `replace` on a missing item MUST throw.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m81-cosmos-db-backend, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree
deno task release:verify <version>
```

Plus the milestone's own bar: the guarded real-emulator suite run with `COSMOS_ENDPOINT` set, and
each negative control observed failing and then reverted.

## 8. Risks & mitigations

- **The emulator is not the service.** `azure-cosmos-emulator:vnext-preview` is PostgreSQL plus a
  `pgcosmos` extension, and three measured behaviours are known to be more permissive than the
  documented service: multi-property `ORDER BY` with no composite index (P20), 11 patch operations
  (P21), and a string partition-key value matching a numeric one (P67). Mitigation: the
  implementation takes the conservative side of each (patch capped at 10 with a replace fallback;
  the composite-index requirement documented as a deployment prerequisite for keyset paging; no
  reliance on partition-key type coercion), and every such claim is labelled "not verified against
  live Cosmos" in the README, `PUBLIC_API.md` and the CHANGELOG — the M52/M52b/M52c/M52d precedent
  for a cloud backend CI holds no account for.
- **Rows missing the `ORDER BY` field.** The emulator returns them (P28); the service's behaviour
  here is not verifiable from this machine. Mitigation: keyset paging always orders by the key
  columns as the tiebreaker (`resolveKeysetSort`), which every row carries by construction, so the
  page walk does not depend on the answer.
- **A guarded suite that passes while asserting nothing.** Mitigation: guard with `ignore:` rather
  than an early return inside the test body, so a skip is visible in the run's ignored count — the
  M70c trap, recorded in the container notes.
- **CI does not run the emulator.** The image is 2.48 GB, which is a real cost on every pull
  request. Mitigation: the suite is local-and-documented, following the Pub/Sub and Service Bus
  precedent in `docs/messaging-emulators.md` rather than the ElasticMQ one; the documentation names
  the exact `docker run` and the health line to wait for, so the suite is reproducible by anyone.
- **The Mongo-API route is documented but untested.** Mitigation: it is labelled unverified in every
  place it is mentioned, and it introduces no code — it is the existing `'mongodb'` arm.

## 9. Out of scope

- Request units, consistency levels, TTL, and index-policy management — M79's exclusion, for M79's
  reason: no two candidate backends spell any of them alike and none has a second consumer, so each
  belongs with the adapter that first needs it.
- Container and database **provisioning** (§3.4) — the application's concern; the adapter reads what
  exists.
- The Cosmos DB for MongoDB API as an implemented arm — it is the existing `'mongodb'` arm and is
  documentation here (§3.1).
- Cloud Bigtable (M82) and DynamoDB (M80), each on its own branch.
