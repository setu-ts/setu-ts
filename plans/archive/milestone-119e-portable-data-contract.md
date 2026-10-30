# Milestone 119e — Portable data contract (`@setu-ts/database-plugin`, `@setu-ts/common`, `@setu-ts/cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m119e-portable-data-contract`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

The same repository call must mean the same thing on every adapter, and a configuration that cannot
work must fail at startup or as a named server fault, never as a client error. This milestone closes
the six `v0.10.0` rows of M119e: the Drizzle tenant column (V10-4, with the V9-26 remainder), the
cursor that crosses entities (V10-32), the unknown payload field that is a 400, a 500 or silently
stored depending on the adapter (V10-33), the malformed key that answers 500 (V10-37), the
per-request, unnamed missing-key-column refusal (V10-45), and the app-owned `pg` pool that crashes
the process on an idle-client drop (V10-61).

Maintainer decisions (2026-10-25, each the recommended option after a framework comparison): resolve
the tenant column to its Drizzle property; SQL adapters refuse unknown fields while schema-less
adapters store them, documented and pinned by a conformance table; a refused value is a named 400;
the framework attaches a reporting `'error'` listener to a pool that has none, and the docs show the
pool setup.

- **In scope:** V10-4 (+ V9-26 remainder), V10-32, V10-33, V10-37, V10-45, V10-61; the README, agent
  card, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` and ROADMAP/CLAUDE.md status edits that
  ship with them.
- **NOT this milestone:** forwarded client identity (M119d); optional peers in an npm workspace
  (M119f); a declared field set for schema-less adapters (declined by the maintainer, 2026-10-25 —
  route body schemas own field restriction); refusing an unknown field in a `where`, `orderBy` or
  `select` (a separate surface; today's Drizzle plain `Error` there is unchanged); MySQL and SQLite
  value-refusal codes for Drizzle (no smoke row; PostgreSQL is the measured arm).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                           | Verified surface / fact                                                                                                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sortFingerprint`                          | `packages/common/src/services/cursor.ts:275`                                 | `(orderBy) => string`, `field:direction` pairs joined by `,`; no entity, no key columns. Public since 0.2.0 (`common/src/index.ts:335`). JSDoc (263–274) promises a cursor "from another sort" is refused, and says nothing of entity.              |
| `sortFingerprint` callers                  | eight adapters                                                               | cosmos-data-source:623, dynamo-data-source:438, bigtable-data-source:428, prisma-adapter:656, memory-adapter:959, drizzle-adapter:923, mongo-data-source:412, `cloudflare-plugin/src/database/d1-data-source.ts:125`; `entity` is in scope at each. |
| Cursor payload                             | `cursor.ts:44,82–87,104,135,414`                                             | `{ orderedValues, keyValues, sortFingerprint }`, base64url JSON — readable by the client; the fingerprint is compared for string equality on decode.                                                                                                |
| `DatabaseTenantDataStore`                  | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts:124–330` | `#column()` (153) = strategy column ▸ constructor `tenantColumn` ▸ `'tenant_id'`. Uses it as a payload key in `create` (≈236), a `where` key in `findAll`/`find` (194, 225), a ROW key in `#ownedRow` (208), and the strip key in `update`.         |
| `ColumnStrategy`                           | `packages/multi-tenancy-plugin/src/strategies/column-strategy.ts:19–25`      | Default column `'tenant_id'`; `getTenantColumn()` returns it.                                                                                                                                                                                       |
| Drizzle data source                        | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:683–706`   | Built per `getRepository` call; `keyColumns = resolveKeyColumns(entities?.[entity]?.primaryKey ?? 'id')`, each checked by `columnFor` (1041) which throws a plain `Error`; payload keys checked by `hasColumn` (1012) against PROPERTY names.       |
| Drizzle columns                            | `drizzle-adapter.ts:1012–1022`                                               | `table[Symbol.for('drizzle:Columns')]` is `{ property: Column }`; a Drizzle `Column` carries its SQL name as `.name`. Rows come back keyed by property.                                                                                             |
| Drizzle `connect`                          | `drizzle-adapter.ts:284–345`                                                 | Reads the configured database via `readDrizzleDatabase` (`query/drizzle-database.ts:167`), loads operators; does not look at `entities` or the client.                                                                                              |
| `createDrizzleDatabase`                    | `packages/database-plugin/src/query/drizzle-database.ts:141–164`             | Stores `{ database, transaction, supportsIsolation }` in a WeakMap keyed by a frozen token; `database` is the app's Drizzle instance.                                                                                                               |
| drizzle-orm 0.45.2 `$client`               | `node_modules/.pnpm/drizzle-orm@0.45.2…/node-postgres/driver.d.ts:38`        | `$client: NodePgClient extends TClient ? Pool : TClient` — the app's `pg` Pool, an `EventEmitter`.                                                                                                                                                  |
| node-postgres Pool `'error'`               | node-postgres.com/apis/pool                                                  | An idle client's backend error is emitted on the pool; with no listener Node throws it as an uncaught `'error'` and the process may exit. The docs say to add a listener.                                                                           |
| `classifiedOrOriginal`                     | `packages/database-plugin/src/services/database-service.ts:85–111`           | The one place every wrapped data-source call (outer 251 and transaction-scoped 283, via `wrapDataSource` 447) maps a driver error to a named error; scrubs the cause first.                                                                         |
| `classifyDriverError` pass-through         | `packages/database-plugin/src/errors/classify.ts:146–160`                    | Already-classified top-level errors pass through unchanged; it does not walk into their cause.                                                                                                                                                      |
| `isValueTypeRefusal`                       | `classify.ts:202–227`                                                        | `22P02`/`22003`/`22007`/`22008` anywhere in the cause chain, or `PrismaClientValidationError`. Read today only by the Drizzle (985) and Prisma (710) keyset pages.                                                                                  |
| `InvalidCursorError` with a class-22 cause | `drizzle-adapter.ts:985–988`                                                 | Carries `cause: scrubDriverError(error)` — a chain that `isValueTypeRefusal` would match. Any new value-refusal mapping must not re-map it.                                                                                                         |
| `UnknownPayloadFieldError`                 | `packages/database-plugin/src/errors.ts:49–66`                               | `(entity, field)`, status hint 400 "Bad Request", fixed detail; message names entity and field via `renderDiagnosticName` (`errors/diagnostic-name.ts:8`, 64-char cap).                                                                             |
| Portable errors in `common`                | `packages/common/src/errors/invalid-cursor.ts:16`, `duplicate-key.ts:49`     | Precedent: errors every adapter (including D1 in another package) throws live in `common`. `withHttpStatusHint`/`httpStatusHintOf` exported (`common/src/index.ts:50`).                                                                             |
| `cloudflare-plugin` → `database-plugin`    | `packages/cloudflare-plugin/package.json:43`                                 | `devDependencies` only; D1 cannot throw a `database-plugin` class at runtime.                                                                                                                                                                       |
| Prisma validation handling                 | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:797–805`     | A conditional write turns `PrismaClientValidationError` into `UnsupportedQueryFeatureError` (501); a plain `create`/`update` lets it reach the classifier, where it is unclassified → masked 500.                                                   |
| D1 identifiers                             | `packages/cloudflare-plugin/src/database/d1-sql.ts:57–75`                    | `quoteIdentifier(value, position)` throws `CloudflareUnsupportedError` quoting the raw value — for payload keys too (X81-3). D1 runs statements via `prepareStatement(...).all()` with no driver-error mapping (`d1-data-source.ts:174–270`).       |
| Plugin register order                      | `packages/database-plugin/src/plugin/database-plugin.ts:132–160, 452–465`    | `adapter.connect()` then `resolveLogger(ctx)` (debug-only wrapper today); `optionalDependencies: ['logger']`.                                                                                                                                       |
| Internal data-source marker precedent      | `database-service.ts:34, 72, 232–236`                                        | `IDynamoAccessPathReportingDataSource` read structurally off a data source; `DRIZZLE_QUERY_HANDLE` symbol set on the service — package-internal seams, not exported.                                                                                |
| `wrapDataSource` spread                    | `database-service.ts:468–472`                                                | Spreads the source first, so own enumerable members (including symbol keys) pass through.                                                                                                                                                           |
| `IRepository.update` not found             | `packages/common/src/services/database.ts:247–249`                           | `@throws {Error}` when no row has the key — unchanged here.                                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                            | Resolution (picked side)                                                                                              | Doc deliverable (same PR)                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| C1  | `sortFingerprint` JSDoc and `IDataSource.findPage` docs imply a foreign cursor is refused; the code accepts a same-sort cursor from another entity. | The code changes (§3.2); the JSDoc then states what is bound: entity, key columns, sort.                              | `cursor.ts` JSDoc; `PUBLIC_API.md` `sortFingerprint` entry; upgrading note that older cursors are refused once. |
| C2  | `docs/upgrading.md` `## 0.10.0` scopes the unknown-field refusal to Drizzle; the README guarantees table implies a portable contract.               | Per-adapter behaviour as §3.3 states it, pinned by a conformance table test.                                          | database-plugin README guarantees table + `docs/upgrading.md` 0.11.0 note.                                      |
| C3  | `UnknownPayloadFieldError` is documented under `@setu-ts/database-plugin` in `PUBLIC_API.md`; it moves to `common` (§3.3).                          | Defined in `common`; `database-plugin` re-exports the same class (identity preserved, existing imports keep working). | `PUBLIC_API.md` both sections.                                                                                  |

## 3. Design decisions

### 3.1 The tenant store resolves its column to the entity's field (V10-4, V9-26 remainder)

- **Decision:** the Drizzle data source carries an internal, non-exported member under a module
  symbol `FIELD_FOR_COLUMN` (`src/adapters/drizzle/field-for-column.ts`):
  `(name) => string | undefined`. Rule: a property named `name` → `name`; else exactly one property
  whose Drizzle column `.name === name` → that property; else (none, or more than one) →
  `undefined`. `wrapDataSource` already forwards own symbol members. `DatabaseService` gets an
  internal method under a second module symbol `ENTITY_FIELD_RESOLVER` (same pattern as
  `DRIZZLE_QUERY_HANDLE`): `(entity, name) => string | undefined`, which creates the entity's data
  source and reads `FIELD_FOR_COLUMN`; a data source without it answers `name` unchanged (every
  other adapter, D1 included, whose rows and payloads use the column name as the field).
  `DatabaseTenantDataStore` resolves its column once per entity through that method (read
  structurally off the service; an `IDatabaseService` without it — an app-built service — gets the
  column unchanged), caches the result in a `Map` keyed by entity, and uses the resolved field for
  every use: the stamp in `create`, the `where` in `findAll`/`find`, the ownership read in
  `#ownedRow`, and the strip and the precondition in `update`, and the precondition in `delete`
  (lines 193, 208, 222, 234, 246, 282 — all six uses). An `undefined` resolution throws a new
  `TenantColumnUnresolvedError` naming the entity and the configured column and the remedy (name the
  property on `ColumnStrategy`, or add the column to the table). It carries no status hint, so it is
  a 500: a configuration fault, never blamed on the client. The stamp stays spread LAST under the
  resolved property, so a caller's same-named key is overridden; a caller who sends the SQL spelling
  (`tenant_id`) gets `UnknownPayloadFieldError` from the Drizzle payload check — it names no field
  of the resource.
- **Why:** Django, Hibernate and TypeORM all speak model field names in their APIs; the strategy's
  setting is an SQL column name (its default `tenant_id` and its name say so). Translating once into
  the repository's vocabulary makes the default strategy work with the idiomatic Drizzle shape
  `tenantId: text('tenant_id')`. A startup check is not possible: the store does not know which
  entities are tenant-scoped (a `tenants` table has no tenant column), so the check is per entity on
  first use, and it is a named server fault.
- **Test home:** `database-tenant-data-store.test.ts` (resolution, cache, strip, stamp-last,
  unresolved error); `drizzle-adapter-columns.test.ts` (`FIELD_FOR_COLUMN` rule incl. ambiguity);
  `real-drizzle-adapter.test.ts` (guarded real PostgreSQL: create → findById → find → update under a
  `tenantId: text('tenant_id')` table with the default strategy column, every write read back).

### 3.2 The cursor fingerprint binds entity and key columns (V10-32)

- **Decision:** `sortFingerprint(orderBy, scope?)` gains an optional
  `scope: { readonly entity: string; readonly keyColumns: readonly string[] }`. Without it the
  output is byte-identical to today. With it the output is
  `JSON.stringify([scope.entity, scope.keyColumns, pairs])` where `pairs` is today's string —
  unambiguous for any entity or column name. D1 and Cosmos DB resolve the entity one level up
  (`d1-adapter.ts:269` `resolveTarget`, `cosmos-data-source.ts:884`), so their internal target types
  (`D1Target`, `CosmosTarget`, neither exported) gain `readonly entity: string`, set by
  `resolveTarget` (corrected after implementation, 2026-10-25). All eight callers pass their entity
  and resolved key columns. A cursor minted by 0.10.0 or earlier then mismatches and is refused with
  the existing `InvalidCursorError` (400) — intended, documented once in the upgrading guide.
- **Why:** X81-2's own fix line names entity and key columns. Additive parameter, so no published
  signature breaks; one implementation serves every adapter. No hashing: the cursor is readable
  base64url JSON already carrying field names, the entity name is in the URL, and the fingerprint is
  a correctness check, not a secret (§8a).
- **Test home:** `common` `cursor-codec.test.ts` (byte-identical without scope; scope changes the
  string; `|`/`,`-bearing names do not collide); `invalid-cursor-conformance.test.ts` (new row: a
  cursor minted on entity A with the same sort presented on entity B → `InvalidCursorError` on every
  adapter in the table); D1 `d1-database.test.ts` (same row).

### 3.3 Unknown payload field: SQL adapters refuse, schema-less adapters store (V10-33)

- **Decision:** `UnknownPayloadFieldError` moves to
  `packages/common/src/errors/unknown-payload-field.ts` (same name, constructor, message and hint; a
  local copy of the 64-character name renderer), and `database-plugin` re-exports it. Behaviour per
  adapter, as test data:

  | Adapter                                        | Unknown payload field on `create`/`update`/`updateWhere`                               |
  | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
  | Drizzle                                        | `UnknownPayloadFieldError` before I/O (today, unchanged)                               |
  | Prisma                                         | `UnknownPayloadFieldError` (§3.4 split of `PrismaClientValidationError`)               |
  | D1                                             | `UnknownPayloadFieldError` (below)                                                     |
  | Memory, MongoDB, DynamoDB, Cosmos DB, Bigtable | stored and returned — documented; field restriction belongs to the route's body schema |

  D1: a payload key that fails `quoteIdentifier` is refused as
  `UnknownPayloadFieldError(entity, key)` before I/O (the value is never quoted into a message —
  today's `CloudflareUnsupportedError` echoes it); table and configured-column positions keep
  `CloudflareUnsupportedError`. A driver error from a `create`/`update`/`updateWhere` statement
  whose message matches SQLite's `has no column named <c>` or `no such column: <c>` maps to
  `UnknownPayloadFieldError(entity, c)` only when `<c>` is a key of the statement's payload;
  otherwise it propagates unchanged (a precondition column is not a payload field). The match
  patterns are a constant array the test iterates.

- **Why:** Mongoose and the raw MongoDB/DynamoDB drivers store unknown fields by default; Prisma and
  typed SQL refuse. Making the schema-less arms refuse needs a declared field set the maintainer
  declined. What makes the contract honest is that each arm's behaviour is pinned by a test and
  written in the README, and that no arm answers a masked 500.
- **Test home:** new `unknown-payload-field-conformance.test.ts` (memory/fake rows unit; real
  MongoDB/DynamoDB rows guarded); `d1-database.test.ts` (both SQLite messages, the
  precondition-column non-match, the invalid-identifier payload key with a canary value absent from
  the message); `prisma-adapter.test.ts`; `common` `unknown-payload-field.test.ts` (shape; and
  `database-plugin`'s export `===` `common`'s).

### 3.4 A value the database refuses is a named 400 (V10-37)

- **Decision:** new `InvalidFieldValueError` in `packages/common/src/errors/invalid-field-value.ts`:
  `(entity)`, message
  `Entity '<entity>': the database refused a supplied value for its field type.`, status hint 400
  "Bad Request", fixed detail `A supplied value does not fit the type of its field.`; no value, key
  or field name anywhere in it. One home: `classifiedOrOriginal` maps, after the existing classes, a
  refused input. An internal `refusedInputOf(error)` in `classify.ts` returns
  `{ kind: 'unknown-field', field }` for a `PrismaClientValidationError` whose message contains
  ``Unknown argument `<field>` `` (field parsed, then rendered only through the 64-character
  renderer), `{ kind: 'value' }` for any other `isValueTypeRefusal` match or a Prisma known-request
  error whose `code` is `P2023` (inconsistent column data) or `P2007` (data validation error) —
  `isValueTypeRefusal` itself stays unchanged, since the keyset pages read it — else `null`. The
  Prisma codes are a measured fact, not memory: the implementer first runs the guarded real-Prisma 7
  probe (malformed uuid key, mistyped integer payload) and records the observed `name`/`code`; if
  neither matches this rule, stop and report rather than widening it. Unknown field →
  `UnknownPayloadFieldError(entity, field)`; value → `InvalidFieldValueError(entity)`, both with the
  scrubbed driver error as `cause` — except a Prisma error, whose message renders the whole query
  and payload and which `scrubDriverError` (`errors/scrub.ts:14`) does not clean: its `cause` is a
  value-free stand-in `Error` carrying only the original `name` and `code` (corrected after
  implementation, 2026-10-25: the scrubber handles only Drizzle's `Failed query` wrapper and
  class-22 codes). An error that already carries an HTTP status hint (read with `httpStatusHintOf`)
  is returned unchanged before this step, so `InvalidCursorError` with its class-22 cause keeps its
  identity. This covers `findById`, `findAll`, `count`, `create`, `update`, `delete`, `updateWhere`
  and `deleteWhere` on Drizzle (PostgreSQL) and Prisma, outside and inside a transaction. Prisma's
  conditional-write `valueFreePrismaRefusal` (`prisma-adapter.ts:797`) is deleted, so a conditional
  write gets the same split instead of a 501. D1: a STRICT-table refusal
  (`cannot store <TYPE> value in <TYPE> column`) maps to `InvalidFieldValueError` in the same D1
  helper as §3.3. The kernel's existing 4xx path logs it once at `warn`, which is what removes the
  client-writable `error` line.
- **Why:** NestJS (`ParseUUIDPipe`) and Spring (type mismatch) answer 400. On `update`, a class-22
  refusal cannot be attributed to the key rather than the payload, so "treat as not found" (DRF,
  Rails) would misreport a bad payload value; one 400 covers both honestly.
- **Test home:** `classify-driver-error.test.ts` (`refusedInputOf` table: four codes, nested cause,
  Prisma unknown-argument, Prisma other validation, `22012` → `null`); `database-service.test.ts`
  (each operation maps; status-hinted error passes through; transaction-scoped repo maps);
  `real-drizzle-adapter.test.ts` (guarded: `findById('abc')` on a `uuid` key and
  `create({ age: 'x' })` on an integer column → `InvalidFieldValueError`, served 400 with the fixed
  detail and no `error` log line); `real-prisma-adapter.test.ts` (guarded: unknown field →
  `UnknownPayloadFieldError`, bad uuid → `InvalidFieldValueError` — this measures the Prisma 7
  message shape §3.4 parses); `prisma-conditional-write.test.ts` (501 gone).

### 3.5 Missing key column: a named error, at connect when configured (V10-45)

- **Decision:** new `MissingKeyColumnError` (database-plugin): `(entity, column)`, message
  `Drizzle table '<entity>' has no column <column> for its primary key; set entities.<entity>.primaryKey to the table's key column(s), or register a table that has one.`
  No status hint (500). It replaces the plain `Error` in `columnFor` when the column is a key column
  (the call in `createDrizzleDataSourceInner`), so the per-request refusal is named. In addition,
  `DrizzleAdapter.connect` validates every entity that has an explicit `entities.<E>.primaryKey` AND
  a registered table: each key column must exist, else `MissingKeyColumnError` and the plugin's
  `register` fails — the app does not start. A table with no explicit `primaryKey` is not checked at
  connect, because a composite-key table registered only for the typed query builder (`connect`'s
  own comment) is valid until a repository is requested.
- **Why:** the remedy is named; an explicit, wrong configuration fails startup; the query-builder
  case stays valid.
- **Test home:** `drizzle-adapter.test.ts` (connect refuses an explicit wrong `primaryKey`; connect
  accepts an id-less table with no `primaryKey`; `getRepository` on it throws
  `MissingKeyColumnError` with the remedy text).

### 3.6 A reporting `'error'` listener on a pool that has none (V10-61)

- **Decision:** internal `attachPoolErrorListener(database, warn)` in
  `src/adapters/drizzle/pool-error-listener.ts`. It reads `database.$client`; when that is an object
  whose `on` and `listenerCount` are functions and `listenerCount('error') === 0`, it attaches one
  listener that calls
  `warn('Database pool reported an idle-connection error', { error: describeError(error) })` and
  returns `true`; otherwise it does nothing and returns `false`. The plugin calls it once in
  `register` after `adapter.connect()` for the `'drizzle'` arm, with `warn` bound to the resolved
  logger (a `resolveLogger` sibling that exposes `warn`). Without a logger the listener is still
  attached and the event is dropped — the process no longer exits. It is never removed (the pool is
  the app's and outlives nothing of ours; `disconnect` does not own the pool). README "Drizzle"
  section and `AGENT_CARD.md` gain a node-postgres pool setup that attaches its own listener, and
  say the framework attaches one only when the app has none.
- **Why:** node-postgres documents the listener as required; TypeORM and Knex attach one to the
  pools they own. Attaching only when absent never overrides an app's own handling.
- **Test home:** `pool-error-listener.test.ts` (attaches on a real `EventEmitter` with no listener;
  emitting `'error'` then logs once and does not throw; skips with an existing listener; skips a
  non-emitter `$client` and a missing one); `real-drizzle-adapter.test.ts` (guarded: real `pg` Pool,
  `pg_terminate_backend` on the idle client → the process survives and one `warn` is logged).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `sortFingerprint` gains an optional parameter; cursors minted
before 0.11.0 are refused once (a behaviour change documented in `docs/upgrading.md`, ships in minor
0.11.0).

| Exported symbol                                   | Kind     | Consumer / real code path that READS it                                                                                    |
| ------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sortFingerprint` (`common`, widened)             | function | the eight adapter cursor paths (§1), each now passing `scope`                                                              |
| `UnknownPayloadFieldError` (`common`, moved)      | class    | thrown by Drizzle, the service classifier (Prisma) and D1; `instanceof` in apps; re-exported by `database-plugin`          |
| `InvalidFieldValueError` (`common`, new)          | class    | thrown by `classifiedOrOriginal` and the D1 helper; served 400 through its status hint; `instanceof` in apps               |
| `MissingKeyColumnError` (`database-plugin`)       | class    | thrown by `DrizzleAdapter.connect` and `createDrizzleDataSourceInner`; `instanceof` in apps and the plugin's start failure |
| `TenantColumnUnresolvedError` (`database-plugin`) | class    | thrown by `DatabaseTenantDataStore` on an unresolved column; `instanceof` in apps                                          |

Internal (NOT exported from any `src/index.ts`): `FIELD_FOR_COLUMN`, `ENTITY_FIELD_RESOLVER`,
`refusedInputOf`, `attachPoolErrorListener`, the D1 refusal helper.

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                                   | Behavior (per implementation)                                                                |
| --------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `sortFingerprint(…, scope)` (parameter) | every adapter's `findPage` mint and decode | identical string without it; entity- and key-bound with it (§3.2)                            |
| None new on `DatabasePlugin` (checked)  | —                                          | §3.5 reads the existing `entities.<E>.primaryKey`; §3.6 reads the existing `drizzleInstance` |

## 5. Implementation files

| File                                                                                                                   | Purpose                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/common/src/index.ts`                                                                                         | export `UnknownPayloadFieldError`, `InvalidFieldValueError`                                 |
| `packages/common/src/errors/unknown-payload-field.ts`                                                                  | moved class (§3.3)                                                                          |
| `packages/common/src/errors/invalid-field-value.ts`                                                                    | new class (§3.4)                                                                            |
| `packages/common/src/services/cursor.ts`                                                                               | `sortFingerprint` scope (§3.2)                                                              |
| `packages/database-plugin/src/index.ts`                                                                                | re-export `UnknownPayloadFieldError`; export the two new classes                            |
| `packages/database-plugin/src/errors.ts`                                                                               | drop the class body (re-export), add `MissingKeyColumnError`, `TenantColumnUnresolvedError` |
| `packages/database-plugin/src/errors/classify.ts`                                                                      | `refusedInputOf` (§3.4)                                                                     |
| `packages/database-plugin/src/services/database-service.ts`                                                            | hint pass-through + refused-input mapping; `ENTITY_FIELD_RESOLVER`                          |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                                     | `FIELD_FOR_COLUMN` member, `MissingKeyColumnError`, connect validation, scope               |
| `packages/database-plugin/src/adapters/drizzle/field-for-column.ts`                                                    | the symbol + resolution rule                                                                |
| `packages/database-plugin/src/adapters/drizzle/pool-error-listener.ts`                                                 | §3.6                                                                                        |
| `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts`                                                       | delete `valueFreePrismaRefusal`; scope                                                      |
| `packages/database-plugin/src/adapters/{memory,mongo,dynamo,cosmos,bigtable}/*-data-source.ts` (+ `memory-adapter.ts`) | pass `scope`                                                                                |
| `packages/database-plugin/src/tenancy/database-tenant-data-store.ts`                                                   | §3.1                                                                                        |
| `packages/database-plugin/src/plugin/database-plugin.ts`                                                               | call `attachPoolErrorListener`; `warn` logger                                               |
| `packages/cloudflare-plugin/src/database/d1-data-source.ts`                                                            | scope; D1 refusal helper (§3.3, §3.4)                                                       |
| `packages/cloudflare-plugin/src/database/d1-sql.ts`                                                                    | payload-key position refused as `UnknownPayloadFieldError`                                  |
| READMEs, `AGENT_CARD.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, ROADMAP, CLAUDE.md                     | doc deliverables (§2, §3.6)                                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                              | src covered                                 | Key assertions                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `common/test/unit/cursor-codec.test.ts`                                                | `cursor.ts`                                 | §3.2 string rules (`sortFingerprint(orderBy)` and `sortFingerprint(orderBy, { entity, keyColumns })`)       |
| `common/test/unit/unknown-payload-field.test.ts` (new)                                 | `unknown-payload-field.ts`                  | name, message, hint field-by-field (detail present, no field/value in it)                                   |
| `common/test/unit/invalid-field-value.test.ts` (new)                                   | `invalid-field-value.ts`                    | same, plus no value anywhere                                                                                |
| `database-plugin/test/unit/classify-driver-error.test.ts`                              | `classify.ts`                               | `refusedInputOf` table (§3.4)                                                                               |
| `database-plugin/test/unit/database-service.test.ts`                                   | `database-service.ts`                       | mapping per operation; pass-through; transaction scope; `ENTITY_FIELD_RESOLVER` with and without the member |
| `database-plugin/test/unit/drizzle-adapter-columns.test.ts`                            | `field-for-column.ts`, `drizzle-adapter.ts` | resolution rule: property, SQL name, ambiguous, absent                                                      |
| `database-plugin/test/unit/drizzle-adapter.test.ts`                                    | `drizzle-adapter.ts`                        | §3.5                                                                                                        |
| `database-plugin/test/unit/pool-error-listener.test.ts` (new)                          | `pool-error-listener.ts`                    | §3.6                                                                                                        |
| `database-plugin/test/unit/plugin.test.ts`                                             | `database-plugin.ts`                        | drizzle arm attaches once; other arms never call it; no logger still attaches                               |
| `database-plugin/test/unit/database-tenant-data-store.test.ts`                         | `database-tenant-data-store.ts`             | §3.1                                                                                                        |
| `database-plugin/test/unit/invalid-cursor-conformance.test.ts`                         | every adapter's cursor path                 | cross-entity row (§3.2)                                                                                     |
| `database-plugin/test/unit/unknown-payload-field-conformance.test.ts` (new)            | memory, drizzle, prisma data sources        | the §3.3 table as data                                                                                      |
| `database-plugin/test/unit/prisma-adapter.test.ts`, `prisma-conditional-write.test.ts` | `prisma-adapter.ts`                         | split; 501 gone                                                                                             |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts` (guarded)              | real PostgreSQL                             | §3.1, §3.4, §3.6 real paths, writes read back                                                               |
| `database-plugin/test/integration/real-prisma-adapter.test.ts` (guarded)               | real Prisma 7                               | §3.4 message shape                                                                                          |
| existing guarded real MongoDB/DynamoDB suites                                          | mongo, dynamo                               | §3.3 "stored" rows                                                                                          |
| `cloudflare-plugin/test/unit/d1-database.test.ts`                                      | `d1-data-source.ts`, `d1-sql.ts`            | §3.2 row; §3.3 and §3.4 D1 cases, canary absent from messages                                               |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m119e-portable-data-contract
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run ci:local            # final commit: all five CI shards; fix rounds use --shard
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

Per-file coverage read ANSI-stripped from `ci:local`'s shard reports; every touched `src` file ≥90%
branch/function/line. The guarded real-backend suites must RUN, not skip (the ignored count is the
proof).

## 8. Risks & mitigations

- **A framework-built Prisma query that Prisma rejects is now a 400 blaming the client** → the split
  applies only on the repository CRUD paths through `classifiedOrOriginal`; the real-Prisma test
  pins the message shape; any internal query bug still shows in the `warn` line's `cause`.
- **Older cursors stop working on upgrade** → intended; one upgrading-guide paragraph; the refusal
  is the existing 400.
- **Per-entity resolution cost in the tenant store** → computed once per entity and cached; the
  cache is keyed by app-chosen entity names, never request data.
- **Attaching a listener changes an app object** → only when it has none; documented; the
  alternative is the process exiting.
- **Moving `UnknownPayloadFieldError`** → `database-plugin` re-exports the same class; a test
  asserts identity.

## 8a. Design security review

> Written by the planner before implementation. The committed-tree audit checks the implementation
> against this section; it runs in a fresh Claude agent, never Codex, never the implementing
> context.

- **Reviewed flows:**
  - **F1 (§3.1):** a tenant-scoped request reaching `DatabaseTenantDataStore` `create`, `find`,
    `findById`, `update`, `delete`, with the tenant column resolved to a property.
  - **F2 (§3.2):** a client-supplied cursor decoded and compared on every adapter.
  - **F3 (§3.3, §3.4):** client-controlled payload keys, payload values and URL keys reaching the
    database and coming back as an error message, an HTTP body and a log line.
  - **F4 (§3.6):** a pool `'error'` event reaching a log line.
- **Assets:** tenant isolation (no read or write across tenants); the confidentiality of client
  values and of other tenants' rows; log integrity (a client must not write `error`-level lines);
  process availability.
- **Attackers:** an authenticated tenant user sending arbitrary JSON bodies, keys and cursors; a
  client replaying a cursor from another resource; a database outage or a hostile network dropping
  idle connections.
- **Budgets:** no per-request map or cache growth (the §3.1 cache is bounded by the app's entity
  count); no new log line on any request path except the 4xx `warn` the kernel already emits; §3.6
  logs at most one line per pool `'error'` event, bounded by the pool's idle-client count per
  outage.

### 8a.1 Audit obligations (each a probe with a positive control)

1. **F1, stamp cannot be overridden:** a payload carrying the resolved property with another
   tenant's id → the row is stored under the request's tenant (read back); a payload carrying the
   SQL spelling → 400 `UnknownPayloadFieldError`, no row written. Positive control: a clean payload
   is written and read back under its tenant.
2. **F1, no cross-tenant read or move:** with the column resolved, `findById`/`find` of another
   tenant's row → `null`/empty; `update` carrying the tenant property → the property is stripped and
   the row stays with its tenant; `update`/`delete` of another tenant's id → not matched. Each is
   compared with develop's memory-adapter behaviour (unchanged table).
3. **F1, fail closed:** an entity whose column resolves to nothing, or to two properties →
   `TenantColumnUnresolvedError` before any statement is sent (a recording fake proves no I/O); the
   store never falls back to the unresolved name.
4. **F2:** a cursor minted on entity A presented to entity B with the same sort → 400 on every
   adapter (the conformance row); a forged cursor with a hand-edited fingerprint naming B → still
   only pages B's rows within the request's tenant filter (the fingerprint is not an authorization
   control, and the audit confirms nothing treats it as one).
5. **F3, no value disclosure:** with a canary in a payload VALUE, a URL key and a payload KEY, none
   of `UnknownPayloadFieldError`, `InvalidFieldValueError` or `MissingKeyColumnError` HTTP bodies
   contains it; the log message names at most the field name, rendered and capped at 64 characters;
   the `cause` is the scrubbed driver error (no SQL parameters). Includes the D1 invalid-identifier
   key, which today echoes the raw value.
6. **F3, log level:** a malformed key and a mistyped value produce exactly one `warn` line and no
   `error` line (positive control: a real 500 still logs at `error`).
7. **F3, no widening:** an error that already carried a status hint keeps its class and status
   (`InvalidCursorError` stays 400 with its own detail); a non-refusal driver error (`23505`,
   connection loss) keeps today's mapping.
8. **F4:** the warn line carries `describeError` output only (no connection string, no password —
   probe with a canary password in the pool config and a real `pg_terminate_backend`); an app that
   attached its own listener gets no second one.

### 8a.2 Threats and resolutions

| Threat                                                                         | Resolution                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Resolution maps a caller key onto the tenant column                            | Resolution is applied only to the store's own column, never to caller payload keys |
| Ambiguous mapping (two properties share an SQL name) silently picks one        | `undefined` → `TenantColumnUnresolvedError`                                        |
| Error messages echo client input (identifier, value, Prisma's query rendering) | Fixed messages; field names through the capped renderer; scrubbed `cause`          |
| A client turns database errors into `error` log lines (M113f alert signal)     | Refused input becomes a 400, logged once at `warn`                                 |
| Cursor fingerprint read as a security boundary                                 | Documented as correctness only; tenant filters bound every page                    |
| Unhandled pool `'error'` exits the process                                     | Listener attached when absent                                                      |

### 8a.3 Defect classes (the audit's Step 4) this design expects to apply

Tenant isolation bypass; information disclosure through error messages and logs; log injection or
log-level abuse by a client; fail-open on misconfiguration; denial of service by process exit.

## 9. Out of scope

- A declared field set refusing unknown fields on schema-less adapters — declined (route body
  schemas own it).
- Refusing unknown fields in `where`, `orderBy` and `select` — today's Drizzle plain `Error` there
  is a separate surface with no smoke row.
- A startup check that knows which entities are tenant-scoped — needs a per-entity tenancy
  declaration, which no milestone owns yet.
- Forwarded client identity — M119d.
