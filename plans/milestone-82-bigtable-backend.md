# Milestone 82 — Cloud Bigtable backend (`@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m82-bigtable-backend`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A Google Cloud Bigtable adapter — the **wide-column** half of the gap M78 named and only half
closed. `DatabasePlugin({ type: 'bigtable', options })` serves the `database` capability from
Bigtable over `npm:@google-cloud/bigtable@^6`, supplied inject-or-lazy (AI_GUIDELINES §12.2).
Bigtable inverts the DynamoDB problem: its row key is a **single lexicographically-sorted string**,
so `findById` fits it natively with no key object at all, while everything _around_ the key is
missing — no secondary index of any kind, so a predicate on a non-key column is a scan, and
`orderBy` is row-key order or nothing. The adapter therefore pushes down exactly what Bigtable can
answer exactly (row-key ranges, column projection, byte-exact value equality) and evaluates the
residue with the SAME `matchesFilter` every other backend's reference path uses, so the six adapters
cannot drift about what a `FilterExpression` means.

- **In scope:** the `'bigtable'` arm and `BigtableAdapter`; per-entity row-key mapping including a
  row key **composed from several logical fields**; column-family mapping for `select` and for
  filter paths; **start-key** cursor pagination; non-key `orderBy` refused by name; a single-row
  atomic transaction; a guarded real-emulator suite plus a CI service container.
- **NOT this milestone:** garbage-collection policies and cell versioning (Bigtable's timestamped
  version history has no counterpart in the portable contract — the `poolSize` rule; an application
  needing it reaches the injected client, as it does for a Prisma raw query). Table/instance
  provisioning (the application's, exactly as containers are on Cosmos). Grouping and joins, which
  the portable contract has no member for at all and which M78/M79 already record as unowned.
  GoogleSQL `executeQuery`, a preview surface with no portable member — `rawQuery` is refused by
  name.

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                                   | Verified surface / fact                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IDatabaseAdapter`                      | `packages/common/src/services/database.ts:203,270,286`               | Extends `IOrmAdapter` (`connect`/`disconnect`/`isReady`/`beginTransaction`) plus `createDataSource(entity)` and `rawQuery<T>(sql, params?)`.                 |
| `IDataSource`                           | `packages/common/src/services/database.ts:203`                       | `findAll`, `findById(EntityKey)`, `create`, `update(EntityKey, data)`, `delete(EntityKey)`, OPTIONAL `findPage`, `count(where, filter?)`. No `migrate`.      |
| `NormalizedQuery`                       | `packages/common/src/services/database.ts:163`                       | `where`, `filter?`, `orderBy`, `limit` (`-1` = unlimited), `offset`, `cursor?`, `select`.                                                                    |
| `PageResult`                            | `packages/common/src/services/database.ts:128`                       | `rows` + `nextCursor`; non-`null` **iff** non-terminal, never derived from `rows.length`. Row-based backends fetch `limit + 1`.                              |
| `EntityKey`                             | `packages/common/src/services/database.ts:124`                       | `string \| number \| Readonly<Record<string, string \| number>>` — a composite key is a record, never an array. No `Date` arm, so a Date key is unreachable. |
| `FilterExpression`                      | `packages/common/src/services/database.ts:108`                       | `comparison` (`eq`/`contains`/`gt`/`gte`/`lt`/`lte`/`in`, `field: string \| readonly string[]`) composed under `and`/`or`.                                   |
| `resolveKeysetSort`                     | `packages/common/src/services/cursor.ts:161`                         | Caller `orderBy` followed by every key column not already present, each ascending. Both the predicate and the adapter's sort must read it.                   |
| `mintNextCursor`                        | `packages/common/src/services/cursor.ts:298`                         | Reads order + key columns off the LAST page row; refuses null/`NaN`/invalid `Date`; returns `null` when `!hasMore` or the page is empty.                     |
| `decodeCursor` / `sortFingerprint`      | `packages/common/src/services/cursor.ts:118,257`                     | `decodeCursor` answers `null` for a malformed token and never throws; the fingerprint is `field:direction` pairs joined by commas.                           |
| `matchesFilter`                         | `packages/database-plugin/src/query/query-builder.ts:156`            | The in-memory reference evaluator; `Date` handled by `comparableEquals`/`comparableGreaterThan`. Exported from the package's own query module.               |
| `projectFields`                         | `packages/database-plugin/src/query/query-builder.ts:273`            | Empty `select` returns a shallow copy; otherwise only the named fields that are `in` the entity.                                                             |
| `UnsupportedQueryFeatureError`          | `packages/database-plugin/src/errors.ts:123`                         | `(feature, adapter, message)`; carries `feature`/`adapter` and a `name` discriminant.                                                                        |
| `UnsupportedRawQueryError`              | `packages/database-plugin/src/errors.ts:86`                          | The refusal Mongo and Cosmos already use for a container-less/SQL-less backend.                                                                              |
| `CosmosTransactionScopeError`           | `packages/database-plugin/src/errors.ts:210`                         | The precedent for refusing at the write that leaves the atomic bound, naming what it crossed.                                                                |
| `resolveDynamoTarget`                   | `packages/database-plugin/src/adapters/dynamo/dynamo-mapping.ts:196` | The public-override → internal-target two-layer mapping shape, and `requireIdentifier`'s blank-identifier refusal.                                           |
| `createLazyDynamoLoader`                | `packages/database-plugin/src/adapters/dynamo/dynamo-client.ts:185`  | The literal `import('npm:…')` INSIDE `load()`, so an injected client never resolves the SDK. M70e's rule: the specifier must be a literal.                   |
| `createAdapter` / `buildAdapterOptions` | `packages/database-plugin/src/plugin/database-plugin.ts:156,199`     | The arm switch and the shared `carry(key)` bag every arm's options ride.                                                                                     |
| `DatabaseAdapterType`                   | `packages/database-plugin/src/interfaces/index.ts:255`               | `'prisma' \| 'drizzle' \| 'memory' \| 'mongodb' \| 'dynamodb' \| 'cosmos' \| 'custom'` — the union this milestone extends.                                   |
| `BuiltInDatabaseOptions`                | `packages/database-plugin/src/interfaces/index.ts:401`               | The discriminated union of per-arm option types; each arm names what its adapter cannot run without (M70j D7).                                               |

### 1A. Platform facts established by PROBE against the real emulator

Every row was measured against `gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators`
(`cbtemulator`) on `127.0.0.1:8086` with `npm:@google-cloud/bigtable@^6` under Deno 2.9.6, on
2026-09-02. Each shaped a decision; the ones marked **TRAP** would have shipped green.

| #   | Fact                                                                                                                                                                                                | Consequence                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `instance.create()` answers `12 UNIMPLEMENTED`. Instances are implicit; `table.create({ families })` works directly and a re-create answers `6 ALREADY_EXISTS`.                                     | The adapter provisions nothing; the guarded suite creates tables directly, ignoring ALREADY_EXISTS.                                     |
| P2  | `new Bigtable({ projectId, apiEndpoint: '127.0.0.1:8086' })` reaches the emulator with **no** `BIGTABLE_EMULATOR_HOST` and no credentials.                                                          | `apiEndpoint` is a first-class option, so the suite needs no `runtime.env` read (§4.1).                                                 |
| P3  | A read row is `{ id, data: { <family>: { <qualifier>: [{ value, labels, timestamp }] } } }`; cells are **newest-first** (probed with two writes 20 ms apart).                                       | The decoder reads cell `[0]` of each qualifier and ignores the version history (out of scope).                                          |
| P4  | **TRAP.** `getRows({ start, end })` is **inclusive at BOTH ends** — `[u#002, u#004]` returned `u#004`. Only the explicit `{ value, inclusive: false }` form gives an exclusive bound.               | Every range this adapter builds uses the explicit form. Asserted in the emulator suite.                                                 |
| P5  | **TRAP.** `{ value: 'a.*b' }` is a **regex** and matched both `a.*b` and `axxb`. `{ value: { start: v, end: v } }` is an exact byte match and matched only `a.*b`.                                  | Value push-down uses the byte-range form exclusively — no regex, so no escaping to get wrong.                                           |
| P6  | A bare value filter is a CHAIN: the returned row carries only the matching cell. `{ condition: { test, pass: [{ all: true }] } }` selects the row and returns it whole.                             | Predicate push-down is a `condition`; projection is the `pass` branch. Both proven in the suite.                                        |
| P7  | `row.filter([{ all: true }], { onNoMatch })` answers `matched: false` for an absent row and `true` for a present one — an atomic check-and-set.                                                     | `create`/`update`/`delete` are conditional single-row mutations, not blind writes.                                                      |
| P8  | A CheckAndMutateRow mutation LIST applies atomically and in order: `[{method:'delete'},{method:'insert',data}]` replaced a row wholesale, dropping a qualifier the insert did not name.             | The transaction commits one row's buffered operations as ONE atomic mutation list.                                                      |
| P9  | **TRAP.** `getRows({ reversed: true })` is **silently ignored** by `cbtemulator` — it returned ascending order and no error.                                                                        | `orderBy` `desc` is REFUSED by name rather than shipped on an unverifiable path (§3.6).                                                 |
| P10 | `getRows({ ranges: [...] })` accepts multiple ranges and `getRows({ keys: [...] })` accepts an explicit key list; `filter`, `ranges` and `limit` compose in one call.                               | `in` on a fully-pinned key becomes `keys`; an `eq`-pinned prefix becomes one range.                                                     |
| P11 | `{ value: { strip: true } }` returns every row with empty cell values.                                                                                                                              | `count` with no residual filter strips values instead of transferring them.                                                             |
| P12 | A missing table and a missing instance BOTH answer `5 NOT_FOUND` quoting the full resource path.                                                                                                    | `connect()` performs no admin probe: the failure already names itself, and data-plane credentials commonly exclude table admin (§3.11). |
| P13 | `row.get()` on an absent row REJECTS with `RowError` `code: 404` rather than answering an empty row.                                                                                                | `findById` catches the 404 and answers `null`; any other error propagates.                                                              |
| P15 | **TRAP.** A filter that removes every cell of a row removes the **ROW** — a projection naming columns a row happens not to carry answered with no row at all, not an empty one.                     | The projection is interleaved with a `{ row: { cellLimit: 1 } }` arm, so a row is never dropped by a projection.                        |
| P16 | Bigtable orders row keys as UTF-8 **bytes**, which is code-POINT order; JavaScript's `<` compares UTF-16 code UNITS, and the two disagree for every non-BMP character.                              | Cursor comparison and the prefix successor use code points (`compareRowKeys`), not the operators.                                       |
| P17 | Cells come back in lexicographic family-then-qualifier order, not write order.                                                                                                                      | The test double sorts, so a `cellLimit` arm keeps the cell production keeps.                                                            |
| P14 | The emulator image measures **1.75 GB** (`docker images`), against DynamoDB Local's 755 MB and the Cosmos emulator's 2.48 GB. A TCP health probe works inside it (`bash -c 'echo > /dev/tcp/...'`). | The suite runs in CI as a service container (§3.13), unlike the local-only Cosmos one.                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                         |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:8055` records "a range scan of `[u#002, u#004)` returned exactly `u#002` and `u#003`" as an emulator measurement. Re-measured through the Node SDK, `{ start, end }` is inclusive at both ends (P4) and returns three rows. | Both are true of different surfaces — the wire protocol's `endKeyOpen` versus the SDK's shorthand. The SDK behaviour is what this adapter faces, so the plan and the README state the SDK form. | ROADMAP M82 verification paragraph gains the SDK-shorthand caveat, so the next reader does not re-derive it.                                      |
| C2 | `ROADMAP.md:8047` says a non-key predicate is "a scan with a server-side filter". Measured, a server-side VALUE filter can only do byte-exact matching or a regex (P5) — no ordered comparison exists at all.                           | Push down what is byte-exact (`eq`) and refuse to pretend for the rest: ordered/`contains`/`in` predicates are evaluated client-side by `matchesFilter`. The push-down is provably a SUPERSET.  | README states the split explicitly, with the superset invariant named.                                                                            |
| C3 | `ROADMAP.md:8069` scopes the milestone's packages to "`database-plugin`, and `common` only if the row-key mapping shares a type with M80's".                                                                                            | It does NOT share one: M80's key is a partition/sort ATTRIBUTE PAIR, Bigtable's is one composed string. **No `common` change** and no new capability token.                                     | ROADMAP package line resolved to `database-plugin` alone, stated rather than left conditional.                                                    |
| C4 | `grep -ric 'bigtable'` over `ROADMAP.md`/`ARCHITECTURE.md`/`PUBLIC_API.md`/`README.md` returned 0 in the last three when M82 was written; the ROADMAP now names it but no other doc does.                                               | Bigtable becomes a documented first-class arm.                                                                                                                                                  | `PUBLIC_API.md` Bigtable section, root `README.md` backend list, `ARCHITECTURE.md` database-backend row, package README section, CHANGELOG entry. |

## 3. Design decisions

### 3.1 Client seam — inject-or-lazy, literal specifier

- **Decision:** `BigtableAdapterOptions` is a **union of two arms**: an injected arm carrying
  `client: IBigtableClient`, and a lazy arm carrying `projectId` and `instance` (plus optional
  `apiEndpoint`). `createLazyBigtableLoader` performs a literal
  `import('npm:@google-cloud/bigtable@^6')` inside `load()` and adapts the module to the structural
  facade; `createInjectedBigtableLoader` resolves the supplied client and never imports.
- **Why:** the M80/M81 arms shape; a union makes a missing credential a **compile** error rather
  than a startup throw. The literal specifier is M70e's rule — a computed one is unreachable by
  JSR's static npm-compat rewrite and `scripts/npm-specifier-audit.ts` refuses it.
- **Test home:** `test/unit/bigtable-client-seam.test.ts` (both loader arms, adaptation against a
  fake SDK module) and the guarded `test/integration/real-import.test.ts` case for the real import.

### 3.2 Row-key mapping — a key composed from several logical fields

- **Decision:** `BigtableEntityMapping.rowKey` is
  `{ fields: readonly string[]; separator?: string; prefix?: string }`, defaulting to
  `{ fields: ['id'], separator: '#' }`. The row key is
  `prefix + fields.map(String).join(separator)`. A single-field key accepts a scalar `EntityKey`; a
  multi-field key requires a composite record carrying **every** field and refuses a scalar by name.
  `keyColumns` for the cursor is `rowKey.fields` in declaration order.
- **Why:** composing a row key from several logical fields is Bigtable's standard practice and the
  ROADMAP names it explicitly as a MAPPING concern rather than the composite-key CONTRACT concern
  M79 added — so it needs no `common` change (C3).
- **Test home:** `test/unit/bigtable-row-key.test.ts`.

### 3.3 Separator collision is refused, not encoded

- **Decision:** for a multi-field key, a field value whose string form CONTAINS the separator is
  refused with `UnsupportedQueryFeatureError('row-key', 'bigtable', …)` naming the field, the value
  and the separator.
- **Why:** two different logical keys would otherwise compose to one row key, so a write would
  silently overwrite an unrelated row and a read would return it. Escaping instead would make the
  key unreadable in `cbt` and break byte-ordering, which is the one property a row key exists for.
- **Test home:** `test/unit/bigtable-row-key.test.ts`.

### 3.4 Key fields are stored as cells AND overlaid from the row key on read

- **Decision:** `create`/`update` write every key field as an ordinary cell. On read, the decoded
  cells are authoritative and the row key is parsed only to fill key fields the cells did NOT carry.
  The projection push-down always includes the key-field qualifiers.
- **Why:** three reasons, each load-bearing. Bigtable cannot store a row with zero cells, and a key
  field is the one field always present, so writing it guarantees the row exists. The row key is a
  string, so overlaying it over a cell would turn a numeric key field into a string — hence cells
  win. And an externally-written table has no key cells at all, so the fallback is what lets this
  adapter read a table it did not create.
- **Test home:** `test/unit/bigtable-data-source.test.ts` (round-trip, numeric key field type
  preserved) and the emulator suite (interop row written by the raw SDK).

### 3.5 Value encoding — tagged by default, `raw` for interop

- **Decision:** `BigtableEntityMapping.valueEncoding` is `'tagged' | 'raw'`, default `'tagged'`.
  Tagged writes `<tag>:<payload>` — `s:` string, `n:` finite number, `b:` boolean, `z:` null (empty
  payload), `d:` Date as ISO, `j:` JSON for anything else — and decodes it back, so a value
  round-trips with its type. A cell whose text carries no recognised tag decodes as the raw string.
  `'raw'` writes `String(value)` and decodes every cell as a string. An `undefined` value writes no
  cell at all.
- **Why:** JSON alone loses `Date`; a bare string loses every type. The untagged-decode fallback is
  what makes a framework-written table and a foreign table both readable, and `'raw'` removes the
  residual ambiguity for an application whose table is entirely foreign — each arm names a real
  consumer, so neither is dead surface.
- **Test home:** `test/unit/bigtable-value.test.ts` (every tag round-trips; a foreign untagged cell
  decodes as its raw string; `'raw'` mode) and the emulator suite (interop row).

### 3.6 `orderBy` — exactly the key fields ascending, or refused by name

- **Decision:** an empty `orderBy` is honoured (the scan is row-key order). An `orderBy` naming
  **exactly** the mapped key fields, in declaration order, all `'asc'`, is honoured as the same
  natural order. Everything else — a non-key field, a strict prefix of the key fields, any `'desc'`
  — is refused with `UnsupportedQueryFeatureError('order-by', 'bigtable', …)`.
- **Why:** Bigtable has no secondary index, so no non-key sort exists. `desc` is refused rather than
  shipped because `reversed: true` is **silently ignored** by the emulator (P9): a descending path
  would type-check, pass every test here, and be unverifiable — the M70k `reportsExit` reasoning. A
  strict prefix is refused because prefix ordering only follows full-key ordering while the
  separator sorts below every byte a field value can contain, which no cheap check can guarantee.
- **Test home:** `test/unit/bigtable-scan.test.ts` and the emulator suite.

### 3.7 `offset` — refused when non-zero

- **Decision:** a non-zero `offset` is refused with
  `UnsupportedQueryFeatureError('offset', 'bigtable', …)` naming cursor pagination as the route.
- **Why:** Bigtable has no row offset; emulating one by discarding scanned rows would bill and
  transfer them while reporting success (the M80 precedent for the same refusal).
- **Test home:** `test/unit/bigtable-scan.test.ts`.

### 3.8 Push-down: what goes to the server, and the superset invariant

- **Decision:** the scan planner emits three server-side narrowings and nothing else, and the
  **full** `FilterExpression` is then re-evaluated client-side by `matchesFilter` in every case.
  1. **Row set.** From the conjunctive top level (`where` entries plus top-level `and` legs of
     `filter`): an `eq` on every key field → an exact row-key range; `eq` pinning a strict prefix →
     a prefix range `[p+sep, successor(p+sep))`; `eq` on the leading fields plus `in` on the final
     field → an explicit `keys` list. No ordered comparison on a key field is ever pushed down — the
     composed key is a string, so a numeric key field does not sort numerically inside it.
  2. **Value equality.** Each conjunctive-top-level `eq` on a NON-key field folds into a nested
     `condition` filter whose `test` is `[{ family }, { column }, { value: { start: v, end: v } }]`
     — the byte-exact form (P5), never the regex form — and whose `pass` is the next level.
  3. **Projection.** The innermost `pass` restricts columns to
     `select ∪ filter fields ∪ orderBy fields ∪ key fields`. The invariant: **a push-down may only
     ever match a SUPERSET of what the client-side evaluator keeps.** It is what makes an encoding
     mismatch (a `Date` under `===`, a number under `'raw'`) wasted work instead of a wrong answer.
     The projection is emitted as an **interleave** of the column filter and a one-cell arm (P15),
     not bare: a filter that removes every cell removes the row, so a bare projection silently drops
     a row carrying none of the projected columns. A `select` or `orderBy` field is resolved
     strictly and an unusable identifier is refused, while a `where` or `filter` field is resolved
     tolerantly and an unusable one is skipped — the memory adapter's `unknownColumnError` rule, and
     what keeps the projected and unprojected read paths from disagreeing about one query.
- **Why:** this is the only split that is provably correct without reimplementing comparison
  semantics twice, and it keeps ONE evaluator — the same `matchesFilter` the memory reference uses —
  so the six adapters cannot disagree (§11.1).
- **Test home:** `test/unit/bigtable-scan.test.ts` (each narrowing, and a metacharacter-laden value
  proving the byte-range form), `test/unit/filter-conformance.test.ts` (a Bigtable leg answering
  identically to the memory reference for every case in the shared table), and the emulator suite.

### 3.9 Qualifier identifiers are validated at mapping time

- **Decision:** a field's column address is `family:qualifier`, from `BigtableEntityMapping.columns`
  (`'family'` or `'family:qualifier'`) or the mapping's `columnFamily` default (`'cf'`) with the
  field name as qualifier. Every family and qualifier must match `/^[A-Za-z0-9_.-]+$/`, and two
  fields resolving to the SAME qualifier are refused by name.
- **Why:** the projection filter selects by qualifier NAME across families, which is exact only
  while qualifiers are unique and free of regex metacharacters — the M52c identifier-validation
  precedent, turning a silently-wrong projection into a named configuration error.
- **Test home:** `test/unit/bigtable-mapping.test.ts`.

### 3.10 `findPage` — a start-key cursor over the committed codec

- **Decision:** `findPage` uses the portable cursor codec: `keyValues` carries the key-field values
  of the last returned row and the fingerprint is
  `sortFingerprint(resolveKeysetSort(orderBy,
  keyColumns))`. The next page recomposes the row key
  from `keyValues` and scans from `{ value: lastKey, inclusive: false }` intersected with the
  derived range. A fingerprint mismatch or a malformed token is refused by name. Rows are fetched in
  batches of `limit + 1` and the loop re-fetches while the client-side filter has not yielded
  `limit` rows, bounded by `maxPageFetches` (default 10); a bounded return is never marked terminal.
- **Why:** an exclusive start key IS Bigtable's continuation mechanism, and reusing the committed
  codec keeps the fingerprint refusal and the tiebreaker story identical to the other five adapters.
  The fetch loop is the M80 bound: a residual client-side filter can empty a raw batch, and
  `nextCursor` must still say "non-terminal". A bounded page mints its cursor from the last row the
  loop already decoded — never a re-read, which would be a second round trip AND a race: a row
  deleted in between would leave the page reporting `null`, i.e. terminal, while rows remain.
- **Test home:** `test/unit/bigtable-page.test.ts` and the emulator suite (a walk over deliberately
  TIED non-key values, and a filtered walk whose first raw batch yields nothing).

### 3.11 `connect()` performs no admin probe

- **Decision:** the constructor validates configuration (non-blank `projectId`/`instance`, mapping
  identifiers, non-empty `rowKey.fields`); `connect()` resolves the client and the instance handle
  and issues no RPC. `disconnect()` drops the handles and closes a lazily-created client.
- **Why:** a missing table or instance already answers `5 NOT_FOUND` quoting the full resource path
  (P12), so a probe would buy no diagnostic — while `instance.getTables()` is a table-ADMIN call
  that a data-plane service account commonly cannot make, so probing would refuse a working
  configuration. The configuration validation is the M52c/M52d binding-guard family: a mistyped
  option is named at construction rather than surfacing as a bare `TypeError`.
- **Test home:** `test/unit/bigtable-adapter.test.ts`.

### 3.12 Transactions — one row, one atomic mutation list

- **Decision:** `beginTransaction()` returns a deferred-write handle. Every buffered operation must
  target **one** row key; a second row key is refused at that write with
  `BigtableTransactionScopeError` naming both keys. `commit()` collapses the buffer into ONE
  CheckAndMutateRow whose mutation list is applied atomically and in order (P8): a buffered `delete`
  becomes `{ method: 'delete' }` and buffered writes become one `{ method: 'insert', data }` after
  it. `rollback()` discards and sends nothing, and is idempotent. Reads inside the transaction
  observe committed state only.
- **Why:** Bigtable's only atomicity unit is the single row, and CheckAndMutateRow's mutation list
  is the one surface that applies several mutations to it atomically. Refusing transactions outright
  would strand the committed `IDatabaseService.transaction()`; offering a multi-row "transaction"
  would promise atomicity the platform does not have. Refusing at the write that crosses the bound
  is the `CosmosTransactionScopeError` precedent.
- **Test home:** `test/unit/bigtable-transaction.test.ts` and the emulator suite (a real
  delete-then-write commit, and a scope refusal).

### 3.13 The emulator suite runs in CI

- **Decision:** `test/integration/real-bigtable-adapter.test.ts` is guarded on
  `BIGTABLE_EMULATOR_ENDPOINT` and declared with the BDD `ignore` option; CI gains a
  `google-cloud-cli:emulators` service container with a TCP health probe and sets the variable, and
  `test/apps-gate.test.ts` pins the service, the port mapping, the variable and the scoped `net`
  grant.
- **Why:** M53's thesis — a real-backend proof CI never runs is not a proof — and the M80 precedent,
  whose DynamoDB Local emulator is a CI service. The image is 1.75 GB (P14), between DynamoDB
  Local's 755 MB and the Cosmos emulator's 2.48 GB that made THAT suite local-only; the pin in
  `apps-gate` is what stops the wiring silently regressing to a skip.
- **Test home:** `test/apps-gate.test.ts`.

### 3.14 `count` strips values when nothing needs them

- **Decision:** `count` with no residual client-side filter scans under `{ value: { strip: true } }`
  and counts rows; with a residual filter it reads the needed columns and evaluates.
- **Why:** P11 — a strip filter answers the row set without transferring any cell value, which is
  the whole cost of counting a wide row.
- **Test home:** `test/unit/bigtable-data-source.test.ts`.

### 3.15 `rawQuery` is refused by name

- **Decision:** `rawQuery` rejects (never throws synchronously) with `UnsupportedRawQueryError`
  naming that Bigtable has no SQL surface reachable through `query(sql, params)` and pointing at the
  injected client.
- **Why:** the Mongo and Cosmos precedent. A synchronous throw from a `Promise`-typed method
  bypasses a caller using `.catch()` — the M52b/M52c/M70j defect class, which this milestone must
  not add a seventh instance of.
- **Test home:** `test/unit/bigtable-adapter.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                    | Kind     | Consumer / real code path that READS it                                                                           |
| ------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `BigtableAdapter`                                                  | class    | `createAdapter`'s `'bigtable'` arm; an application's `'custom'` arm; the emulator suite.                          |
| `createInjectedBigtableLoader`                                     | function | `BigtableAdapter.#establish` on the injected arm; the client-seam unit test.                                      |
| `createLazyBigtableLoader`                                         | function | `BigtableAdapter.#establish` on the lazy arm; the guarded real-import test.                                       |
| `BigtableTransactionScopeError`                                    | class    | Thrown by the transaction handle; caught by `instanceof` in the transaction unit test and the emulator suite.     |
| `IBigtableClient`                                                  | type     | The `client` member of the injected options arm — the type an application annotates its own facade with.          |
| `IBigtableInstance`                                                | type     | Returned by `IBigtableClient.instance`; read by the adapter and by any application-supplied facade.               |
| `IBigtableTable`                                                   | type     | Returned by `IBigtableInstance.table`; the surface the data source and the transaction drive.                     |
| `IBigtableRow`                                                     | type     | Returned by `IBigtableTable.row`; the point-read and conditional-mutation surface.                                |
| `BigtableCell` / `BigtableRowData` / `BigtableReadRow`             | types    | The read shape the value decoder consumes and an application facade must produce.                                 |
| `BigtableReadOptions` / `BigtableRowRange` / `BigtableRowBoundary` | types    | The scan plan the planner emits and the facade accepts.                                                           |
| `BigtableFilter`                                                   | type     | The filter tree the planner builds; part of `BigtableReadOptions`.                                                |
| `BigtableMutation` / `BigtableEntry`                               | types    | The write shape `create`/`update`/`delete` and the transaction emit.                                              |
| `BigtableClientConfiguration`                                      | type     | The lazy loader's argument; read by `adaptBigtableSdkModule`.                                                     |
| `BigtableClientLoader`                                             | type     | The return type of both loader factories; held by the adapter.                                                    |
| `BigtableSdkModule`                                                | type     | The structural module shape the lazy arm adapts — implemented by the fake SDK module in the seam test.            |
| `BigtableEntityMapping`                                            | type     | `BigtableAdapterOptionsBase.tables`; read by `resolveBigtableTarget`.                                             |
| `BigtableRowKeyMapping`                                            | type     | `BigtableEntityMapping.rowKey`; read by the row-key composer.                                                     |
| `BigtableValueEncoding`                                            | type     | `BigtableEntityMapping.valueEncoding`; read by the value codec.                                                   |
| `BigtableAdapterOptions` / `BigtableAdapterOptionsBase`            | types    | The `'bigtable'` arm's `options`; read by the adapter constructor and by an application annotating configuration. |
| `BigtableDatabaseOptions`                                          | type     | A member of `BuiltInDatabaseOptions`; read by the plugin's arm switch and by `plugin-options-types.test.ts`.      |

### 4.1 Options — every option names its consumer

| Option           | Consumer                                     | Behavior                                                                                                                                                               |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`      | `createLazyBigtableLoader`                   | Required on the lazy arm; passed to the SDK constructor. Refused blank at construction.                                                                                |
| `instance`       | `BigtableAdapter.#establish`                 | Required on both arms; the Bigtable instance id. Refused blank at construction.                                                                                        |
| `apiEndpoint`    | `createLazyBigtableLoader`                   | Optional; passed to the SDK constructor. P2 — the emulator address, and the reason the suite needs no env read.                                                        |
| `client`         | `BigtableAdapter.#establish`                 | When present the lazy `import('npm:@google-cloud/bigtable@^6')` never runs.                                                                                            |
| `tables`         | `resolveBigtableTarget`                      | Per-entity `{ table?, rowKey?, columnFamily?, columns?, valueEncoding? }`. An unmapped entity uses its own name, `{ fields: ['id'] }`, family `'cf'`, tagged encoding. |
| `maxPageFetches` | `findPage`'s fill loop                       | Default 10; bounds the re-fetch when a client-side filter empties a raw batch.                                                                                         |
| `logQueries`     | The database service, as for every other arm | Unchanged.                                                                                                                                                             |

## 5. Implementation files

| File                                             | Purpose                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/bigtable/bigtable-client-types.ts` | The structural client facade and every read/write shape it speaks.                                                                |
| `src/adapters/bigtable/bigtable-client.ts`       | Inject-or-lazy loaders, the SDK module shape, and the adaptation to the facade.                                                   |
| `src/adapters/bigtable/bigtable-mapping.ts`      | Public `BigtableEntityMapping` → internal resolved target; identifier and qualifier-uniqueness validation.                        |
| `src/adapters/bigtable/bigtable-value.ts`        | The tagged/raw cell value codec.                                                                                                  |
| `src/adapters/bigtable/bigtable-row-key.ts`      | Row-key composition from an `EntityKey` or a data payload, and the parse-back used as the read fallback.                          |
| `src/adapters/bigtable/bigtable-scan.ts`         | `NormalizedQuery` → scan plan: row set, pushed-down value conditions, projection, and the `orderBy`/`offset` refusals.            |
| `src/adapters/bigtable/bigtable-data-source.ts`  | `IDataSource` over one mapped entity: `findAll`/`findById`/`create`/`update`/`delete`/`findPage`/`count`.                         |
| `src/adapters/bigtable/bigtable-transaction.ts`  | The single-row deferred-write transaction handle.                                                                                 |
| `src/adapters/bigtable/bigtable-adapter.ts`      | `BigtableAdapter implements IDatabaseAdapter`.                                                                                    |
| `src/errors.ts` (modified)                       | Adds `BigtableTransactionScopeError`.                                                                                             |
| `src/interfaces/index.ts` (modified)             | Adds the `'bigtable'` arm to `DatabaseAdapterType` and `BuiltInDatabaseOptions`, plus the option types and structural re-exports. |
| `src/plugin/database-plugin.ts` (modified)       | The `'bigtable'` case and the `carry` keys the arm needs.                                                                         |
| `src/index.ts` (modified)                        | Barrel exports for §4.                                                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                           | src covered                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/fixtures/fake-bigtable-client.ts`             | (fixture)                                      | An in-memory `IBigtableClient` honouring the REAL semantics probed in §1A: inclusive/exclusive boundaries per P4, byte-exact value ranges per P5, `condition` returning whole rows per P6, `matched` per P7, ordered atomic mutation lists per P8, newest-first cells per P3, `404` on an absent row per P13.                                 |
| `test/unit/bigtable-mapping.test.ts`                | `bigtable-mapping.ts`                          | Defaults for an unmapped entity; blank identifier refused by name; a bad qualifier character refused; two fields on one qualifier refused; `columns` accepting `'family'` and `'family:qualifier'`.                                                                                                                                           |
| `test/unit/bigtable-value.test.ts`                  | `bigtable-value.ts`                            | Every tag round-trips (string/number/boolean/null/Date/object/array); `undefined` writes no cell; an untagged foreign cell decodes as its raw string; `'raw'` mode writes and reads strings.                                                                                                                                                  |
| `test/unit/bigtable-row-key.test.ts`                | `bigtable-row-key.ts`                          | Scalar and composite composition; `prefix`; a scalar against a multi-field key refused; a missing field refused; a value containing the separator refused; parse-back returns the field values.                                                                                                                                               |
| `test/unit/bigtable-scan.test.ts`                   | `bigtable-scan.ts`                             | Full-key `eq` → exact range; prefix `eq` → prefix range with an exclusive successor end; `in` on the final field → `keys`; a metacharacter value uses the byte-range form and not a regex; a non-key `eq` becomes a `condition`; projection includes key fields; `orderBy` desc / non-key / strict-prefix refused; non-zero `offset` refused. |
| `test/unit/bigtable-data-source.test.ts`            | `bigtable-data-source.ts`                      | CRUD round-trip through the fake with the value READ BACK; a numeric key field keeps its type (§3.4); `create` on an existing row refused; `update` on an absent row refused; `delete` reports `false` for an absent row; `findById` answers `null` on the 404; `count` strips values with no residual filter and reads them with one.        |
| `test/unit/bigtable-page.test.ts`                   | `bigtable-data-source.ts` (page path)          | A walk over TIED non-key values returns every row exactly once; `nextCursor` is non-`null` on a zero-row non-terminal page; a fingerprint mismatch and a malformed token are refused by name; `maxPageFetches` bounds the loop without marking the page terminal.                                                                             |
| `test/unit/bigtable-transaction.test.ts`            | `bigtable-transaction.ts`                      | Buffered writes land only at commit; a second row key is refused with `BigtableTransactionScopeError`; delete-then-write commits as one ordered mutation list; `rollback` sends nothing and is idempotent.                                                                                                                                    |
| `test/unit/bigtable-adapter.test.ts`                | `bigtable-adapter.ts`                          | Blank `projectId`/`instance` refused at construction; `connect()` issues no RPC; `isReady()`; `beginTransaction()` REJECTS rather than throwing when disconnected; `rawQuery` rejects with `UnsupportedRawQueryError`; `disconnect()` closes a lazily-created client and leaves an injected one alone.                                        |
| `test/unit/bigtable-client-seam.test.ts`            | `bigtable-client.ts`                           | The injected loader never touches the module; `adaptBigtableSdkModule` drives a fake SDK module and forwards each call; the lazy loader's configuration reaches the constructor.                                                                                                                                                              |
| `test/unit/filter-conformance.test.ts` (extended)   | `bigtable-scan.ts` + `bigtable-data-source.ts` | A Bigtable leg over the SHARED case table answering identically to the memory reference, and the page-walk leg extended the same way.                                                                                                                                                                                                         |
| `test/unit/barrel-exports.test.ts` (extended)       | `src/index.ts`                                 | Every §4 symbol is exported, pinned at compile time as well as at runtime (the M56/M70k rule).                                                                                                                                                                                                                                                |
| `test/unit/plugin-options-types.test.ts` (extended) | `src/interfaces/index.ts`                      | A `'bigtable'` registration missing `instance` is a compile error; both option arms type-check.                                                                                                                                                                                                                                               |
| `test/unit/adapter-contract.test.ts` (extended)     | `bigtable-adapter.ts`                          | The adapter satisfies `IDatabaseAdapter` structurally alongside the other five.                                                                                                                                                                                                                                                               |
| `test/unit/plugin.test.ts` (extended)               | `src/plugin/database-plugin.ts`                | The `'bigtable'` arm constructs a `BigtableAdapter` and the arm's option keys survive `buildAdapterOptions`.                                                                                                                                                                                                                                  |
| `test/integration/real-bigtable-adapter.test.ts`    | every `src/adapters/bigtable/` file            | Guarded on `BIGTABLE_EMULATOR_ENDPOINT`, declared with `ignore` so an unset variable reports IGNORED rather than passing vacuously. Scenario coverage in §6.1.                                                                                                                                                                                |
| `test/integration/real-import.test.ts` (extended)   | `bigtable-client.ts` lazy arm                  | The real `import('npm:@google-cloud/bigtable@^6')` resolves and adapts.                                                                                                                                                                                                                                                                       |
| `test/apps-gate.test.ts` (extended)                 | CI wiring                                      | The service, the port mapping, the environment variable and the scoped `net` grant are all pinned (§3.13).                                                                                                                                                                                                                                    |

### 6.1 Emulator scenarios (the milestone's real bar)

Each is a named case in `real-bigtable-adapter.test.ts`, run against `cbtemulator`:

1. Lazy SDK import, table created directly (P1), CRUD round-trip with every value READ BACK.
2. A composed multi-field row key: write, point-read by composite `EntityKey`, and confirm the
   physical row key through the raw SDK.
3. Exclusive range boundaries (P4) — the trap, asserted as a scan that must NOT return the end row.
4. A byte-exact value push-down with a metacharacter-laden value (P5), proving the regex form is not
   in use: a row that a regex WOULD have matched must not be returned.
5. A `condition`-wrapped predicate returning the WHOLE row (P6), not only the matching cell.
6. Column projection restricted to a family and to named qualifiers, with key fields still present.
7. `create` refused on an existing row and `update` refused on an absent one — the conditional
   mutation (P7).
8. A start-key cursor walk over deliberately TIED non-key values, returning every row exactly once.
9. A filtered page walk whose first raw batch yields zero matches, proving `nextCursor` is not
   derived from `rows.length`.
10. `in` on the final key field expanding to an explicit `keys` list.
11. A single-row transaction committing delete-then-write as ONE atomic mutation list (P8), plus a
    rollback that sends nothing and a second row key refused by name.
12. `count` with and without a residual filter.
13. Interop: a row written by the RAW SDK with untagged values, read back through the adapter with
    key fields recovered from the row key (§3.4, §3.5).
14. `orderBy` desc refused by name — the P9 trap, refused rather than silently ascending.
15. A missing table answering `5 NOT_FOUND` quoting the resource path (P12), so no connect-time
    probe is needed.

Review added six more, each with a negative control observed failing against the emulator: a row
carrying none of the projected columns (P15); the exclusive-end boundary read directly through the
facade AND contrasted with the SDK shorthand that returns one row too many (P4); a row sitting
exactly on a prefix range's exclusive end; a numeric key field keeping its type through a projected
page; a key set whose keys carry non-BMP characters, walked in the service's own order (P16); and
the portable filter operators agreed with the memory reference.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m82-bigtable-backend, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task publish:check
deno task release:verify 0.1.0-alpha.10
```

Plus the emulator suite, run explicitly:

```bash
BIGTABLE_EMULATOR_ENDPOINT=127.0.0.1:8086 deno test -A \
  packages/database-plugin/test/integration/real-bigtable-adapter.test.ts
```

## 8. Risks & mitigations

- **The fake client drifts from the real one, and every unit test passes against the drift.** This
  is the repository's most frequently repeated defect (M37b ioredis, M53 `zrangebyscore`, M55
  `readStream`, M70k). Mitigation: the fixture is written against the §1A probe table, each
  behaviour cited, and every unit-level claim it supports has a counterpart scenario in §6.1 run
  against the real emulator.
- **A push-down that excludes a matching row is a silently wrong answer.** Mitigation: the superset
  invariant (§3.8) is stated, and the conformance leg asserts the Bigtable answer equals the memory
  reference for every case in the shared table — a push-down that under-matches fails there.
- **A silently-ignored SDK option looks implemented.** `reversed` is exactly that (P9). Mitigation:
  refuse `desc` by name; never ship a path the available backend cannot verify.
- **The CI image is 1.75 GB and could slow every run.** Mitigation: it is one service container with
  a cheap TCP health probe, pinned in `apps-gate` so a regression to a skip fails rather than
  passes.

## 9. Out of scope

- **Cell versioning and garbage-collection policies** — no counterpart in the portable contract; an
  application reaches the injected client. Unowned, and named as such in the README.
- **GoogleSQL `executeQuery`** — a preview surface with no portable member; `rawQuery` is refused by
  name instead.
- **Grouping and joins** — absent from `NormalizedQuery` entirely; closing one is a `common`
  widening every one of the six adapters would have to answer, which M78/M79 already record.
- **Reverse (descending) scans** — refused by name here because the available emulator ignores the
  option (P9). Re-openable by a milestone that can verify against a live instance.
- **Table and instance provisioning** — the application's, exactly as Cosmos containers are.
