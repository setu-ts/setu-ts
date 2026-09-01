# Milestone 80 — DynamoDB Backend (`@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m80-dynamodb-backend`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A first-class DynamoDB adapter serving the portable data-access contract natively where DynamoDB has
a native answer, and refusing the remainder **by name**. M79 supplied the three members that made
this an implementation milestone rather than a contract argument — composite keys (`EntityKey`),
nested field paths, and the keyset cursor — so with them in place all six `IDataSource` methods work
on DynamoDB. What remains unsupported is two _members_ of `NormalizedQuery`, not two methods:
arbitrary `orderBy` (a `Query` orders only by the table's or a GSI's sort key) and row `offset`.
That is the `UnsupportedFilterOperatorError` refuse-by-name case, not the `WorkersCron` Liskov case
— counted here rather than assumed (§3.1).

**The refusals are a correctness requirement, not politeness, and that is measured (§1A Q5, Q9): the
AWS SDK silently ACCEPTS and DISCARDS an unrecognised `OrderBy` or `Offset` parameter, answering
`200` with an unordered, unskipped result set.** A backend that forwarded one of them would return
confidently wrong rows with no diagnostic anywhere in the stack.

- **In scope:** the `'dynamodb'` arm of `DatabasePluginOptions`; the per-entity key mapping
  (partition + sort key, following the whole two-layer `D1EntityMapping` → internal-target shape);
  native `LastEvaluatedKey` pagination carried inside M79's cursor codec; `Query`-versus-`Scan`
  selection driven by the resolved key condition; expression building (names, values, nested paths);
  the AWS SDK behind the §12.2 inject-or-lazy seam with a guarded real-import test; a real-emulator
  integration suite (§6) covering pagination, item-collection "joins", filtering and ordering; the
  doc deliverables in §2.
- **NOT this milestone:** GSI _selection_ as a portable contract concept — the adapter uses an index
  it was **configured** with and invents no portable way to ask for one (M79's out-of-scope list).
  TTL, consistency level and secondary-index selection are M78's blocker 3, excluded because no two
  of Mongo, DynamoDB, Cosmos and Bigtable spell any of them alike. Cosmos DB is **M81**; Cloud
  Bigtable is **M82**. Removing `offset` is out of scope permanently — released API, §9.4 governs. A
  portable `join` member is not invented (§3.14).

## 1. Contracts verified from SOURCE (not names)

Every row was read at the cited line on this branch's merge-base.

| Reference                            | Source (file:line)                                                              | Verified surface / fact                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EntityKey`                          | `packages/common/src/services/database.ts:124`                                  | `string \| number \| Readonly<Record<string, string \| number>>` — shipped by M79; the composite arm is a **record**, never an array                                        |
| `IDataSource.findById`               | `packages/common/src/services/database.ts:215`                                  | `findById(id: EntityKey): Promise<Record<string, unknown> \| null>`                                                                                                         |
| `IDataSource.create`                 | `packages/common/src/services/database.ts:224`                                  | Returns **the persisted row**, "including any generated columns"                                                                                                            |
| `IDataSource.update`                 | `packages/common/src/services/database.ts:232-236`                              | `@returns The updated row` and **`@throws {Error} When no row has that key`** — so an upsert is a contract violation (§1A P6)                                               |
| `IDataSource.delete`                 | `packages/common/src/services/database.ts:245`                                  | `Promise<boolean>` — `true` when a row was deleted, `false` when none matched                                                                                               |
| `IDataSource.findPage`               | `packages/common/src/services/database.ts:260`                                  | `findPage?(query: NormalizedQuery): Promise<PageResult>` — **optional**, so absence means "cannot page by cursor"                                                           |
| `PageResult.nextCursor`              | `packages/common/src/services/database.ts:132-144`                              | `rows` + `nextCursor: string \| null`. The JSDoc mandates the one-extra-row probe as **the** mechanism — falsified for DynamoDB by §1A Q2/Q3 (conflict C1)                  |
| `NormalizedQuery.cursor`             | `packages/common/src/services/database.ts:173`                                  | `readonly cursor?: string` — opaque to the caller                                                                                                                           |
| `FilterComparison.field`             | `packages/common/src/services/database.ts:82, 87, 92, 97`                       | `string \| readonly string[]` in all four arms — M79's nested-path member                                                                                                   |
| `FilterComparison` ordered arm       | `packages/common/src/services/database.ts:91-95`                                | `'gt' \| 'gte' \| 'lt' \| 'lte'` carries `value: string \| number \| Date` — M79's C5 fourth member                                                                         |
| `FilterOperator`                     | `packages/common/src/services/database.ts:74`                                   | Exactly seven: `eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`                                                                                                             |
| `CursorPayload`                      | `packages/common/src/services/cursor.ts:68-88`                                  | `orderedValues`, `keyValues` (both `ReadonlyArray<CursorValue>`), `sortFingerprint`                                                                                         |
| `CursorValue`                        | `packages/common/src/services/cursor.ts:32`                                     | `string \| number \| Date` — scalars only, which is exactly the shape a `LastEvaluatedKey` reduces to (§1A Q1, G2)                                                          |
| `encodeCursor` / `decodeCursor`      | `packages/common/src/services/cursor.ts:100, 122`                               | `CursorPayload` ⇄ base64url JSON; `decodeCursor` returns `null` for a malformed token and **never throws**                                                                  |
| `UnsupportedQueryFeatureError`       | `packages/database-plugin/src/errors.ts`                                        | Added by M79 beside `UnsupportedFilterOperatorError`; carries feature + adapter + a `name` discriminant. The refuse-by-name class this adapter uses (§3.16)                 |
| `BaseRepository.findPage`            | `packages/database-plugin/src/repositories/base-repository.ts:130-153`          | Reads `this._dataSource.findPage` **without detaching** the method (the M52c `resolveLogger` defect), and refuses by name when absent                                       |
| `DatabasePluginOptions`              | `packages/database-plugin/src/interfaces/index.ts:407`                          | `BuiltInDatabaseOptions \| CustomDatabaseOptions` — a union discriminated on `type`, so a missing per-arm credential is a **compile** error                                 |
| `BuiltInDatabaseOptions`             | `packages/database-plugin/src/interfaces/index.ts:362-366`                      | Four arms today: memory, prisma, drizzle, **mongodb**. M80 adds a fifth.                                                                                                    |
| `DatabaseAdapterType`                | `packages/database-plugin/src/interfaces/index.ts:251`                          | `'prisma' \| 'drizzle' \| 'memory' \| 'mongodb' \| 'custom'` — widened by this milestone                                                                                    |
| `MongoAdapterOptions` shape          | `packages/database-plugin/src/interfaces/index.ts:789-806`                      | A union of an inject arm (`client`) and a lazy arm (`url`), both extending a shared base — the in-package precedent for §3.2                                                |
| `MongoClientLoader` seam             | `packages/database-plugin/src/adapters/mongo/mongo-client.ts:118-165`           | `createInjectedClientLoader` / `createLazyClientLoader` performing a **literal** `import('npm:mongodb@^6.21.0')` — the §12.2 pattern to follow                              |
| `resolveMongoTarget`                 | `packages/database-plugin/src/adapters/mongo/mongo-mapping.ts:113`              | Public per-entity override bag collapsed into an internal, **unexported** target so builders read exactly one shape                                                         |
| Mongo `findPage` implementation      | `packages/database-plugin/src/adapters/mongo/mongo-data-source.ts:327`          | The row-based keyset pipeline: normalize → decode → fingerprint → `keysetPredicate` → `limit + 1` probe. **Not** the shape DynamoDB uses (§3.9)                             |
| Mongo internal-projection workaround | `packages/database-plugin/src/adapters/mongo/mongo-data-source.ts:385-390`      | Adds key columns to the projection for cursor minting, then strips them. DynamoDB needs **none** of this (§1A PR2) — copying it would add dead work                         |
| Existing AWS specifiers              | `packages/{mail,queue,secrets,storage}-plugin/src/**`                           | `npm:@aws-sdk/client-sesv2@^3`, `client-sqs@^3`, `client-sns@^3`, `client-secrets-manager@^3`, `client-s3@^3` — the `@^3` convention §3.2 follows                           |
| Real-backend guard pattern           | `packages/database-plugin/test/integration/real-mongo-adapter.test.ts:22-29`    | Env-var guard declared with the BDD **`ignore` option**, never an early `return` — an unset variable reports as _ignored_, not as a passing test that asserted nothing      |
| Package net allowlist                | `packages/database-plugin/deno.json:12-18`                                      | `net: ["127.0.0.1:27017", "localhost:27017", "127.0.0.1:5433"]` — endpoint-scoped; M53 established a CLI `--allow-net` **replaces** this block rather than unioning with it |
| CI service containers                | `.github/workflows/ci.yml:31-95`                                                | mongo, redis, elasticmq, rabbitmq, minio. The MinIO comment records that a GH Actions service accepts **no `command` key** — decisive for §1A E2                            |
| §2.2 plugin-import ban               | `AI_GUIDELINES.md` §2.2                                                         | No plugin imports another plugin; anything two need lives in `common`                                                                                                       |
| No join concept in the contract      | `packages/common/src/services/database.ts` (grep `join`, `relation`, `include`) | **Zero hits.** The portable contract has no join, relation or include member at all — settles §3.14                                                                         |

## 1A. Facts established by LIVE PROBE (measured 2026-09-01, not reasoned)

Every fact below was produced by executing against the real `amazon/dynamodb-local` emulator on
`127.0.0.1:8000` with AWS SDK `@aws-sdk/client-dynamodb` **3.1121.0**. §1B records how to bring it
up. Seven of these changed the design; three are silent-data-loss findings; two are CI wiring facts
that would otherwise have produced a false-green or an unreachable healthcheck.

### Key semantics and write contracts

| #  | Question the design depended on                                      | Measured answer                                                                                                    | What it changed                                                                                                                                                        |
| -- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 | Composite partition+sort key end to end                              | `CreateTable` (HASH `tenantId`, RANGE `orderId`), `PutItem`, `GetItem` read-back all served                        | Confirms the ROADMAP's 2026-08-29 reading on the current SDK.                                                                                                          |
| P2 | Is the `Key` map **order-sensitive**, as Mongo's compound `_id` is?  | **No.** `{tenantId, orderId}` and `{orderId, tenantId}` both returned the row.                                     | The opposite of Mongo P4. No canonical ordering is needed for the `Key` map — but §3.9 still needs one for the cursor.                                                 |
| P3 | `GetItem` with only the partition key on a PK+SK table               | **`ValidationException: The number of conditions on the keys is invalid`**                                         | A scalar `findById` against a sort-keyed entity must be refused **by name** at the adapter (§3.4), not forwarded.                                                      |
| P4 | `GetItem` whose `Key` carries an extra non-key attribute             | **Same `ValidationException`.**                                                                                    | The adapter must project the caller's key record down to exactly the resolved key columns; passing it through verbatim fails.                                          |
| P5 | Does `UpdateItem` return the row? (`IDataSource.update` requires it) | **Yes** — `ReturnValues: 'ALL_NEW'` returned the full updated item.                                                | The return contract is served natively; no read-after-write round trip.                                                                                                |
| P6 | `UpdateItem` on a **non-existent** key                               | **It UPSERTS.** A ghost item `{tenantId, orderId, status}` was created and returned as though it were an update.   | **Silent fabrication.** `IDataSource.update` is contracted to _throw_ when no row has that key, so §3.6 makes `ConditionExpression: attribute_exists(<pk>)` mandatory. |
| P7 | The guarded form of P6                                               | `ConditionalCheckFailedException` — a distinct, catchable error name.                                              | Gives §3.6 the exact signal to translate into the contract's throw.                                                                                                    |
| P8 | Can `DeleteItem` report whether a row existed?                       | **Yes** — `ReturnValues: 'ALL_OLD'` returned attributes for an existing key and none for a missing one.            | `delete: Promise<boolean>` served natively (§3.7).                                                                                                                     |
| P9 | `PutItem` on an existing key                                         | **Silently overwrites, and DROPS every attribute absent from the new item** — `status` was gone, `total` replaced. | **Silent data loss.** `create()` must carry `ConditionExpression: attribute_not_exists(<pk>)` (§3.5).                                                                  |
| N3 | Empty string as a key value                                          | **`ValidationException`** — a key attribute cannot be an empty string.                                             | `findById('')` is refused by name rather than forwarded (§3.4).                                                                                                        |
| N1 | Number fidelity: DynamoDB `N` is an arbitrary-precision decimal      | `99999999999999999999999999999999999999` stored exactly; `Number()` yields `1e+38` — **lossy**.                    | §3.15: the adapter's unmarshaller preserves an out-of-range `N` as a string rather than silently corrupting it.                                                        |

### Pagination — the headline findings

| #   | Question                                                               | Measured answer                                                                                                                    | What it changed                                                                                                               |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What shape is `LastEvaluatedKey` on a table query?                     | Exactly the key map: `{tenantId:{S:'t1'}, orderId:{S:'o03'}}` — scalars only.                                                      | It reduces cleanly onto M79's `CursorPayload.keyValues` (`CursorValue = string \| number \| Date`), so §3.9 reuses the codec. |
| Q2  | **Is `Limit` applied BEFORE or AFTER `FilterExpression`?**             | **BEFORE.** `Limit: 3` with a filter returned **1 item**, `ScannedCount: 3`, **and a `LastEvaluatedKey`.**                         | Falsifies the `PageResult` JSDoc's one-extra-row rule for this backend (conflict C1) and settles §3.9.                        |
| Q3  | Does a filtered walk ever return an **empty, non-terminal** page?      | **Yes.** Per-page counts `[1, 0, 1, 0]` while finding both matching rows — page 2 returned **zero rows and a continuation token**. | A `rows.length === 0 ⇒ last page` reading loses rows silently. Drives §3.9's invariant and §3.10's bounded fill loop.         |
| S1  | Does `Scan` share the trap?                                            | **Identically** — `[1, 0, 1, 0]` for the same data.                                                                                | The rule is transport-wide, so §3.9 covers `Query` and `Scan` with one implementation.                                        |
| Q6  | Is `Select: 'COUNT'` paginated?                                        | **Yes** — `Limit: 4` answered `Count: 4` **with** a `LastEvaluatedKey`, while the unbounded call answered the true `10`.           | A `count()` reading one response under-reports past 1 MB. §3.13 loops to exhaustion.                                          |
| Q9  | Is a row `Offset` expressible?                                         | **No — and worse: the SDK ACCEPTED `Offset: 2` and silently discarded it**, answering all 10 rows.                                 | Refusing by name is a _correctness_ requirement (§3.12); forwarding returns confidently wrong rows with no error.             |
| G2  | What does a **GSI** `LastEvaluatedKey` carry?                          | **Four** attributes — the index key **and** the table key: `{sk, pk, gsi1sk, gsi1pk}`.                                             | §3.9's cursor carries the resolved key-column list for the _chosen access path_, not a fixed table-key pair.                  |
| PR2 | Does a `ProjectionExpression` that omits the key break cursor minting? | **No** — the server returned a correct `LastEvaluatedKey` while projecting only `status`.                                          | DynamoDB needs **none** of Mongo's add-keys-then-strip projection workaround. Recorded so it is not copied in (§3.9).         |

### Ordering, filtering and joins

| #   | Question                                                         | Measured answer                                                                                                                   | What it changed                                                                                                            |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Q4  | Descending order on the sort key                                 | `ScanIndexForward: false` → `['o10','o09','o08']`.                                                                                | The one `orderBy` the adapter serves natively (§3.11).                                                                     |
| Q5  | **Is a non-key `orderBy` rejected by the server?**               | **No — `OrderBy: 'total'` was ACCEPTED and silently ignored**, answering all 10 rows unordered.                                   | Same class as Q9. §3.11 must refuse a non-key `orderBy` itself; there is no server-side backstop.                          |
| Q7  | `Query` without a partition-key equality                         | **`ValidationException: Query condition missed key schema element`**                                                              | Confirms §3.8's `Query`-versus-`Scan` selection rule is forced, not an optimisation.                                       |
| F1  | A reserved attribute name (`status`) used raw in an expression   | **`ValidationException: Attribute name is a reserved keyword`**                                                                   | §3.13 aliases **every** name through `#nN` placeholders rather than maintaining AWS's ~570-word reserved list.             |
| F2  | Nested path filter (M79's member)                                | `#a.#b.#c = :v` with one alias per segment returned the matching row.                                                             | M79's `readonly string[]` path translates natively (§3.13).                                                                |
| F3  | `contains`                                                       | Served — 3 matching rows.                                                                                                         | Native operator, no escaping needed (unlike SQL `LIKE`, M70b X12-1).                                                       |
| F4  | `IN`                                                             | Served — `#s IN (:a, :b)`.                                                                                                        | Native operator.                                                                                                           |
| F5  | An **empty** `IN` list (M79 defines it as match-nothing)         | **`ValidationException: Syntax error; token: ")"`** — `IN ()` is not valid syntax.                                                | §3.13 emits a match-nothing expression rather than an empty `IN`.                                                          |
| F6  | A date range as an ISO-8601 string                               | `createdAt > :d` returned the 2 expected rows (lexicographic order matches chronological for ISO-8601 UTC).                       | The encoding a `Date` filter must be converted **to** (§3.14).                                                             |
| F7  | Passing a JS `Date` straight to the driver                       | **`ValidationException: Supplied AttributeValue is empty`** — there is no DynamoDB date type at all.                              | §3.14: the adapter cannot guess the stored encoding, so it refuses by name unless the mapping declares one (D1 precedent). |
| J1  | The idiomatic "join": a single-table **item collection**         | One `Query` on `pk = CUST#1` returned the profile **and** all three orders: `['ORDER#…#2','ORDER#…#1','ORDER#…#3','PROFILE']`.    | This is what a "join" is on DynamoDB, and it is served by the members the adapter already has (§3.14).                     |
| J2  | Join **+ filter + ordering** in one round trip (the §6 scenario) | `pk = :p AND begins_with(sk, :pfx)` + `FilterExpression` + `ScanIndexForward:false` returned exactly the one open order over 100. | The end-to-end scenario §6's `real-dynamo-adapter` suite drives.                                                           |
| J3  | Cross-**table** key fetch                                        | `BatchGetItem` over two tables returned `{m80_single: 2, m80_page: 1}` in one call.                                               | Recorded, and deliberately **not** exposed (§3.14) — no contract member consumes it.                                       |
| G1  | A configured GSI query                                           | Served.                                                                                                                           | §3.8's index arm.                                                                                                          |
| C1p | `ConsistentRead` on a GSI                                        | **`ValidationException: Consistent reads are not supported on global secondary indexes`**                                         | Recorded so consistency level stays out of scope (M78 blocker 3) rather than being half-added.                             |

### Transactions and CI wiring

| #  | Question                                          | Measured answer                                                                                                      | What it changed                                                                                                      |
| -- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| T1 | `TransactWriteItems`                              | Committed a two-item transaction.                                                                                    | The atomicity primitive §3.17 defers writes into.                                                                    |
| T2 | Two operations on **one item** in one transaction | **`ValidationException: Transaction request cannot include multiple operations on one item`**                        | A unit of work writing the same key twice must be refused by name at commit, with the key named (§3.17).             |
| T3 | The item-count ceiling                            | **`ValidationException: Member must have length less than or equal to 100`**                                         | Refused by name before the call, the M52c D1 100-bound-parameter precedent (§3.17).                                  |
| E1 | The image's default command                       | `ENTRYPOINT ["java"]`, `CMD ["-jar","DynamoDBLocal.jar","-inMemory"]` — **no `-sharedDb`**, user `dynamodblocal`.    | §1B and §3.18: without `-sharedDb` the emulator segregates data **per access key + region**, so tests must pin both. |
| E2 | Can CI pass `-sharedDb`?                          | **No** — a GH Actions service container accepts no `command` key (recorded at `ci.yml:83-86` for MinIO).             | The suite therefore must not depend on `-sharedDb`; §3.18 pins one credential/region pair instead.                   |
| E3 | A viable CI healthcheck                           | A bare `GET /` answers **400**; a `POST` `DynamoDB_20120810.ListTables` answers **200**. `curl` **is** in the image. | The ElasticMQ situation exactly (`ci.yml:54-56`). §6 uses the POST probe; a naive `curl -f /` could never pass.      |

## 1B. Live backend setup — everything needed, no searching

The emulator is already running on this machine as `he-dynamodb`.

```bash
docker run -d --name he-dynamodb --restart unless-stopped -p 127.0.0.1:8000:8000 \
  -v he-dynamodb-data:/home/dynamodblocal/data amazon/dynamodb-local:latest \
  -jar DynamoDBLocal.jar -sharedDb -dbPath /home/dynamodblocal/data
```

```bash
export DYNAMODB_ENDPOINT="http://127.0.0.1:8000"
```

Credentials are required by the SDK's signer but never validated by the emulator; the suite pins
`accessKeyId: 'setu-m80'`, `secretAccessKey: 'setu-m80'`, `region: 'us-east-1'` (§3.18 — E1 makes
that pinning load-bearing, not cosmetic).

**The volume-ownership trap the ROADMAP names.** The image runs as uid **1000** (`dynamodblocal`,
confirmed by `docker exec he-dynamodb id`). With `-dbPath` pointing at a **bind mount** owned by
another uid, the jar cannot create `shared-local-instance.db` and the process **hangs rather than
erroring** — the port accepts connections and every request stalls, which reads as a network problem
rather than a permission one. A **named volume** (as above) is initialised with the image's own
ownership and avoids it; `docker exec he-dynamodb ls -ld /home/dynamodblocal/data` must print
`dynamodblocal dynamodblocal`. Passing `-inMemory` instead sidesteps the mount entirely and is what
CI does (E1).

**Before running anything that stops a container**, check `AutoRemove` — a container created with
`--rm` is destroyed by a `docker stop` and never returns:

```bash
docker inspect -f '{{.HostConfig.AutoRemove}}' he-dynamodb   # must print false
```

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                            | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                          | Doc deliverable (same PR)                                                                                                                                              |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PageResult.nextCursor`'s JSDoc (`common/src/services/database.ts:135-143`) states the mechanism as fact: "the adapter fetches `limit + 1` rows and sets `nextCursor` to `null` precisely when it fetched no more than `limit`." §1A Q2/Q3 falsify that for DynamoDB — a page can return **fewer rows than `limit`, or zero rows, and still not be the last page**. | Keep the **guarantee**, generalise the **mechanism**. The observable contract — `nextCursor === null` iff no further page exists — is what callers depend on and is honoured by both. The JSDoc is rewritten to state the guarantee, then name the two mechanisms: the one-extra-row probe for row-based backends, and the server's own continuation token for a token-based one. | Rewrite the `PageResult.nextCursor` JSDoc in `common`; add the token-based mechanism to the `PUBLIC_API.md` cursor-pagination section.                                 |
| C2 | The M80 ROADMAP section says "**all six** `IDataSource` methods work on DynamoDB" without naming the two write-path conditions that make it true. §1A P6 and P9 measure that the _unguarded_ forms violate the `update` and `create` contracts silently.                                                                                                            | The claim stands, but conditionally: it is true only with `attribute_exists` / `attribute_not_exists` guards (§3.5, §3.6). Shipping the sentence unqualified would invite an implementation that passes every fake-backed test and fabricates or destroys rows against a real table.                                                                                              | Add the two guard conditions to the M80 ROADMAP in-scope bullet.                                                                                                       |
| C3 | The M80 ROADMAP section names "non-key `orderBy` and any emulated offset refused by name" as a design nicety among others. §1A Q5/Q9 measure that the SDK **accepts and discards** both parameters.                                                                                                                                                                 | Restate as a correctness requirement with the measurement attached, so a later reader does not relax it as defensive.                                                                                                                                                                                                                                                             | Amend that ROADMAP bullet to record Q5/Q9.                                                                                                                             |
| C4 | `PUBLIC_API.md`'s "Custom Adapters (external backends)" section prints the `IDataSource` shape and the `DatabasePluginOptions` arms; neither lists a `'dynamodb'` arm.                                                                                                                                                                                              | The printed surface moves with the contract.                                                                                                                                                                                                                                                                                                                                      | Add a `### DynamoDB backend` section to `PUBLIC_API.md` (options, mapping, exports, the two refusals and their reasons); add the arm to the `DatabaseAdapterType` row. |
| C5 | The `database-plugin` README's adapter table and the root `README.md` package/backend counts predate a fifth built-in arm.                                                                                                                                                                                                                                          | Update both.                                                                                                                                                                                                                                                                                                                                                                      | README adapter table + backend list; root README backend count.                                                                                                        |

## 3. Design decisions

### 3.1 The refuse-by-name standard applies, not the Liskov withdrawal — counted, not assumed

- **Decision:** the adapter **registers** under `CAPABILITIES.DATABASE` and implements all six
  `IDataSource` methods; the two unsupported `NormalizedQuery` members are refused by name.
- **Why:** M78 invoked the `WorkersCron` do-not-register-at-all standard without counting. Counted:
  with M79's `EntityKey` in place, `findAll`, `findById`, `create`, `update`, `delete` and `count`
  all have native answers (§1A P1–P9, Q1–Q9). `WorkersCron` withholds `CAPABILITIES.SCHEDULER`
  because **six of eight methods** would throw; here **zero of six** do. What is unsupported is two
  query members, which is the `UnsupportedFilterOperatorError` case.
- **Test home:** `test/unit/dynamo-adapter.test.ts` (all six methods served through the public
  surface), `test/integration/real-dynamo-adapter.test.ts`.

### 3.2 Hosting and the SDK seam

- **Decision:** a fifth arm of `DatabasePluginOptions`, `type: 'dynamodb'`, in `database-plugin` —
  taking the ROADMAP's recommendation explicitly. The SDK is behind the §12.2 inject-or-lazy seam
  following `MongoClientLoader`: `createInjectedDynamoLoader(client)` and
  `createLazyDynamoLoader(config)` performing a **literal**
  `import('npm:@aws-sdk/client-dynamodb@^3')`. `DynamoAdapterOptions` is a union of an inject arm
  (`client`) and a lazy arm (`endpoint`/`region`), so a missing credential is a compile error (the
  M30 `ChannelConfig` precedent).
- **Only `@aws-sdk/client-dynamodb` is used — not `lib-dynamodb`'s `DocumentClient`.** The adapter
  owns marshalling. **Why, and it is measured:** automatic marshalling would hide both §1A F7 (a JS
  `Date` is rejected outright — the adapter must decide the encoding, §3.14) and §1A N1 (an
  arbitrary-precision `N` is lossy through `Number()`, §3.15). It also keeps one npm specifier,
  matching the `@^3` convention the repo's four other AWS integrations already use.
- **Why not a separate package:** M52c promoted `IDatabaseAdapter` into `common` precisely so a
  backend _can_ live elsewhere, but it buys nothing here and splits one capability's documentation
  across two READMEs.
- **Test home:** `test/unit/dynamo-client-seam.test.ts` (both loader arms against a fake module),
  `test/integration/real-import.test.ts` (the guarded real-import case).

### 3.3 Key mapping — the two-layer shape, in full

- **Decision:** a public per-entity `DynamoEntityMapping` (`table?`, `partitionKey`, `sortKey?`,
  `indexes?`, `dateAttributes?`) is collapsed by an internal `resolveDynamoTarget` into an
  **unexported** `DynamoTarget` whose key columns are always a normalised `readonly string[]` (one
  element for a partition-only table, two with a sort key). Every expression and key builder reads
  that one shape.
- **Why:** the whole two-layer `D1EntityMapping` → `D1Target` shape, not one type of it. Leaving the
  union in the target would put a `sortKey === undefined` branch in every builder, which is where a
  composite key silently degrades to its partition half. One shape at the builder means the
  partition-only case is the one-element array and cannot diverge.
- **Test home:** `test/unit/dynamo-mapping.test.ts`.

### 3.4 `findById` — the key record, projected and validated

- **Decision:** `findById`/`update`/`delete` accept M79's `EntityKey`. A scalar is accepted **only**
  for a partition-only entity; against a sort-keyed entity it is refused by name naming both key
  columns. A composite record is **projected down to exactly the resolved key columns** before the
  call, and a record missing any of them, or carrying an empty-string value, is refused by name.
- **Why:** all three are measured failures, not defensive extras. §1A P3 (partial key) and P4 (extra
  attribute) each answer `ValidationException`, whose message names neither the entity nor the
  configured mapping; §1A N3 refuses an empty-string key. Refusing here turns three opaque AWS
  errors into one naming the entity, the expected columns and the ones supplied. Key-map **order**
  needs no canonicalisation (§1A P2 — the opposite of Mongo's compound `_id`), and that asymmetry is
  recorded in the mapping's JSDoc so a reader does not port Mongo's ordering rule across.
- **Test home:** `test/unit/dynamo-key.test.ts`, `test/integration/real-dynamo-adapter.test.ts`.

### 3.5 `create` is conditional — `attribute_not_exists`

- **Decision:** every `create` carries `ConditionExpression: attribute_not_exists(<partitionKey>)`;
  a `ConditionalCheckFailedException` is translated into a rejection naming the entity and key.
- **Why:** §1A P9 measured that an unguarded `PutItem` on an existing key **silently overwrites the
  item and drops every attribute absent from the new one** — `status` vanished and `total` was
  replaced, with a `200` response. `create()` is contracted to insert; a create that destroys an
  existing row and reports success is the silent-data-loss class this repository keeps closing.
- **Test home:** `test/unit/dynamo-data-source.test.ts` (the emitted `ConditionExpression`),
  `test/integration/real-dynamo-adapter.test.ts` (a duplicate create is refused **and the original
  row is intact afterwards** — the assertion that fails without the guard).

### 3.6 `update` is conditional — `attribute_exists`

- **Decision:** every `update` carries `ConditionExpression: attribute_exists(<partitionKey>)`;
  `ConditionalCheckFailedException` becomes the rejection `IDataSource.update` documents
  (`@throws {Error} When no row has that key`). `ReturnValues: 'ALL_NEW'` supplies the returned row.
- **Why:** §1A P6 measured that an unguarded `UpdateItem` on a missing key **creates a ghost item**
  carrying only the key plus the updated attributes and returns it as though it were an update —
  directly contradicting the contract at `database.ts:232-236`, and fabricating a row that no
  `create` ever wrote. §1A P7 gives the exact catchable signal, and P5 the return value.
- **Test home:** `test/unit/dynamo-data-source.test.ts`,
  `test/integration/real-dynamo-adapter.test.ts` (updating a missing key rejects **and no item is
  left behind** — again the assertion that fails without the guard).

### 3.7 `delete` reports existence natively

- **Decision:** `ReturnValues: 'ALL_OLD'`; `Attributes !== undefined` is the boolean.
- **Why:** §1A P8. No read-before-delete round trip, and no constant `true` (the M52 `R2Storage`
  defect, where a void-returning delete was reported as a successful one).
- **Test home:** `test/unit/dynamo-data-source.test.ts`.

### 3.8 `Query` versus `Scan` selection

- **Decision:** the access path is resolved from the caller's `where`/`filter`: an equality on the
  entity's partition key selects a `Query` (with any sort-key comparison folded into the
  `KeyConditionExpression`); an equality on a **configured** index's partition key selects a `Query`
  on that index; otherwise a `Scan`. Every predicate not folded into the key condition becomes a
  `FilterExpression`. The chosen path is reported through `logQueries`.
- **Why:** forced, not an optimisation — §1A Q7 measured that a `Query` without a partition-key
  equality is a `ValidationException`, so a `Scan` is the only expressible path when the key is not
  constrained. Index selection stays configuration-driven: the adapter uses an index it was given
  and invents no portable way to ask for one (M79's out-of-scope list).
- **Test home:** `test/unit/dynamo-access-path.test.ts` (the three selections, asserted on the
  emitted command), `test/integration/real-dynamo-adapter.test.ts`.

### 3.9 Pagination is the server's continuation token, carried inside M79's cursor codec

- **Decision:** `findPage` mints its cursor from `LastEvaluatedKey`, not from a one-extra-row probe.
  The `LastEvaluatedKey`'s values are carried in `CursorPayload.keyValues` **in the resolved access
  path's key-column order**, with `orderedValues` carrying the same values and `sortFingerprint`
  computed as every other adapter computes it. The invariant is exact:

  > `nextCursor` is non-`null` **if and only if** the response carried a `LastEvaluatedKey`.

  It is never derived from `rows.length`.
- **Why:** §1A Q2/Q3/S1 measured that `Limit` is applied **before** `FilterExpression`, so a page
  can return fewer rows than the limit — **or zero rows** — and still not be the last page. The
  `PageResult` JSDoc's one-extra-row rule (C1) would therefore report a filtered walk as terminal
  after its first sparse page and silently drop matching rows. `LastEvaluatedKey` is the server's
  own authoritative signal and is the only correct one here.
- **Reusing M79's codec rather than a private encoding** keeps one cursor shape across all six
  adapters, and gets the cross-sort fingerprint guard for free. §1A Q1 makes it type-correct: a
  `LastEvaluatedKey` reduces to scalars, which is exactly `CursorValue`. §1A G2 is why the
  key-column list is the **access path's**, not the table's — a GSI's token carries four attributes
  (index key **and** table key), and reconstructing `ExclusiveStartKey` from a fixed table-key pair
  would produce a `ValidationException` on every GSI page after the first.
- **Mongo's add-keys-to-the-projection-then-strip workaround is deliberately NOT ported.** §1A PR2
  measured that the server returns a correct `LastEvaluatedKey` while projecting only a non-key
  attribute, so the key never needs to be added to `select`. Recorded here because the natural move
  when porting `mongo-data-source.ts` is to copy it, and it would be dead work.
- **Test home:** `test/unit/dynamo-page.test.ts` (the invariant, including a page of **zero** rows
  with a non-`null` cursor), `test/integration/real-dynamo-adapter.test.ts` (the §6 sparse-filter
  walk, whose fixture reproduces Q3's `[1,0,1,0]` shape).

### 3.10 A bounded page-fill loop, never an unbounded one

- **Decision:** `findPage` continues fetching while it holds fewer than `limit` rows **and** a
  `LastEvaluatedKey`, up to a `maxPageFetches` bound (default `10`, configurable per adapter). On
  reaching the bound it returns what it has **with a non-`null` cursor** — never a terminal page.
- **Why:** without a fill loop, a sparse filter hands the caller a stream of empty pages and pushes
  DynamoDB's own pagination discipline onto every call site — including `BaseRepository.findPage`,
  which does not loop. Without the bound, a filter matching nothing scans an entire table inside one
  `findPage` call, which is the unbounded-cost surprise M79's own rule forbids. The bound is safe in
  the only direction that matters because the invariant is one-sided: **`nextCursor === null` always
  means genuinely no more rows**; a bounded return says "there may be more", which is true.
- **Test home:** `test/unit/dynamo-page.test.ts` (a fake whose every page is empty returns at the
  bound with a non-`null` cursor and issues exactly `maxPageFetches` calls).

### 3.11 `orderBy` — the sort key, or refused by name

- **Decision:** an `orderBy` naming exactly the resolved access path's sort key maps to
  `ScanIndexForward` (`asc` → `true`, `desc` → `false`). An empty `orderBy` is served. Anything else
  — a non-key field, or more than one field — is refused by name, naming the field, the entity and
  the sort key that _is_ orderable.
- **Why:** §1A Q4 gives the native form. §1A Q5 is why the refusal is mandatory: an unrecognised
  `OrderBy` parameter was **accepted and silently discarded**, answering `200` with unordered rows.
  There is no server-side backstop, so forwarding an unsupported `orderBy` returns confidently wrong
  ordering with nothing to catch.
- **Test home:** `test/unit/dynamo-order.test.ts`, `test/unit/filter-conformance.test.ts`.

### 3.12 `offset` is refused by name

- **Decision:** a non-zero `offset` is refused by name; `offset: 0` (the normalised default) is
  served. A query carrying both a non-zero `offset` and a `cursor` is already refused upstream by
  M79's `normalizePageQuery`.
- **Why:** §1A Q9 — `Offset` was accepted and silently discarded. Emulating it by fetching and
  discarding `n` items changes cost and consistency invisibly, which M79's constraint list forbids
  in as many words.
- **Test home:** `test/unit/dynamo-page.test.ts`.

### 3.13 Expression building — alias everything, one segment at a time

- **Decision:** one internal builder owns `ExpressionAttributeNames`/`Values` for key conditions,
  filters and projections. **Every** attribute name is aliased through a generated `#nN`
  placeholder, including each segment of a nested path (`['profile','address','city']` →
  `#n0.#n1.#n2`). Every value is a `:vN`. An empty `in` list emits a **match-nothing** expression
  rather than `IN ()`.
- **Why:** §1A F1 measured that a reserved word (`status`) used raw is a `ValidationException`, and
  AWS's reserved list is ~570 words and grows — a maintained list is a defect waiting for the next
  release, so aliasing unconditionally is the only stable rule. §1A F2 confirms per-segment aliasing
  serves M79's nested-path member natively. §1A F5 measured that `IN ()` is a **syntax error**, so
  M79's match-nothing semantics for an empty `in` must be emitted as an expression, not as an empty
  list. `contains` needs no escaping here (unlike SQL `LIKE`, M70b X12-1) because it is a native
  operator over an unparsed value.
- **Test home:** `test/unit/dynamo-expression.test.ts`, `test/unit/filter-conformance.test.ts`.

### 3.14 `Date` filters, and the join that is not invented

- **Decision (dates):** a `Date` in the ordered-comparison arm is converted to the encoding the
  entity's mapping declares for that attribute — `dateAttributes: { createdAt: 'iso' | 'epochMs' }`.
  With no declaration for the attribute, the comparison is **refused by name**, naming the attribute
  and the option.
- **Why:** §1A F7 measured that the driver rejects a JS `Date` outright — DynamoDB has no date type,
  so a stored timestamp is a string or a number and **the adapter cannot know which**. This is M79
  §3.9's D1 reasoning exactly ("SQLite has no date type and the adapter cannot know whether the
  column stores an ISO string or an epoch integer"), with one improvement: D1 refuses flatly, while
  a per-entity declaration gives a working path without guessing. §1A F6 confirms the `'iso'`
  encoding sorts correctly. The option is not dead surface — it is read by the filter translator and
  by cursor minting whenever a date attribute is the sort key.
- **Decision (joins):** **no portable join, relation or include member is invented.** §1 records
  that the contract has zero such members today. DynamoDB's answer to a join is the **single-table
  item collection** — related entities sharing a partition key, distinguished by sort-key prefix —
  which §1A J1/J2 measured is served by `findAll`/`findPage` as they already stand: a partition-key
  equality plus a sort-key `begins_with` plus a `FilterExpression` plus `ScanIndexForward`, in one
  round trip. That scenario is a **§6 test deliverable**, not new surface. `BatchGetItem` (§1A J3)
  is measured and deliberately unexposed: no contract member consumes it, and adding one for a
  single adapter is the `poolSize` rule.
- **Test home:** `test/unit/dynamo-expression.test.ts` (both encodings and the refusal),
  `test/integration/real-dynamo-adapter.test.ts` (the item-collection scenario).

### 3.15 Unmarshalling preserves fidelity

- **Decision:** the adapter's own unmarshaller maps `S`→string, `BOOL`→boolean, `NULL`→null, `M`/`L`
  recursively, and `N`→`number` **only when the round trip is exact** (`String(Number(n)) === n`);
  otherwise the value is preserved as its decimal **string**.
- **Why:** §1A N1 measured that `N` is an arbitrary-precision decimal and `Number()` silently
  degrades a 38-digit value to `1e+38`. A backend that quietly corrupts a stored value on read is
  worse than one that refuses it; preserving the string keeps the datum recoverable. The exactness
  test rather than a magnitude test because it is the property that actually matters.
- **Test home:** `test/unit/dynamo-marshal.test.ts` (round trip per type, plus the lossy-`N` case
  with a control asserting the naive `Number()` path _would_ differ).

### 3.16 Refusals use the package's own error class, and reject rather than throw

- **Decision:** every refusal is a `UnsupportedQueryFeatureError` (the M79 class) carrying the
  feature, `'dynamodb'` as the adapter, and a message naming the entity and the offending member. No
  error class is added to `common`. Every refusal reachable from a `Promise`-returning method
  **returns a rejected promise**; only constructor and options-resolver refusals throw
  synchronously.
- **Why:** `common` exports zero error classes and adding one for this milestone's convenience would
  set a precedent for every future refusal (M79 §3.11). The rejection rule is the M52b
  (`createQueueHandler`), M52c (`D1Adapter`), M70j and M79 defect class: a synchronous throw from a
  method typed `Promise<T>` bypasses a caller using `.catch()`.
- **Test home:** every refusal is asserted with `await expect(...).rejects.toThrow(...)`, never
  `expect(() => ...).toThrow`.

### 3.17 Transactions — deferred `TransactWriteItems`, bounded and de-duplicated

- **Decision:** `beginTransaction()` buffers writes and flushes them as one `TransactWriteItems` at
  commit; `rollback()` discards and sends nothing — the M52c D1 deferred-batch shape. Two conditions
  are refused **by name before the call**: a buffer exceeding **100** items, and two operations on
  the same item key. Reads inside a transaction hit committed state (no read-your-own-writes), which
  is documented rather than emulated.
- **Why:** §1A T1 confirms the primitive; §1A T3 measured the 100-item ceiling and §1A T2 measured
  that two operations on one item is a `ValidationException` — both of which AWS reports with a
  message naming neither the entity nor the offending key. Refusing early is the M52c
  100-bound-parameter precedent, and de-duplicating silently was rejected because collapsing a
  create-then-update into one write changes what the caller asked for.
- **Test home:** `test/unit/dynamo-transaction.test.ts`,
  `test/integration/real-dynamo-adapter.test.ts` (a real commit and a real rollback).

### 3.18 Credentials and region are pinned by the test suite

- **Decision:** the integration suite constructs its client with a fixed
  `accessKeyId`/`secretAccessKey`/`region` triple and a per-run table-name suffix
  (`crypto.randomUUID()`), following the Mongo suite's collection-suffix pattern.
- **Why:** §1A E1 measured that the image's default command has **no `-sharedDb`**, under which
  DynamoDB Local segregates data **per access key + region**; §1A E2 measured that a GH Actions
  service container accepts no `command` key, so CI cannot add the flag. A suite that let one of
  them vary would create a table under one identity and query an empty database under another — a
  failure that looks like a missing table. Pinning both makes the suite correct under `-sharedDb`
  **and** under the default, and the UUID suffix keeps runs isolated on the persistent local
  instance.
- **Test home:** `test/integration/real-dynamo-adapter.test.ts` itself; `test/apps-gate.test.ts`
  pins the CI service, its port mapping and the env variable (the M53 precedent).

## 4. Exported surface — every symbol names its consumer

### `@setu-ts/common`

**No new symbol.** M79 shipped every contract member this milestone consumes; the only `common`
change is the C1 JSDoc correction on `PageResult.nextCursor`. A `barrel-exports.test.ts` assertion
pins that `common`'s exported surface is unchanged (the M56 defect class).

### `@setu-ts/database-plugin` (`packages/database-plugin/src/index.ts`)

| Exported symbol              | Kind      | Consumer / real code path that READS it                                                                                    |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DynamoAdapter`              | class     | Constructed by the plugin's `'dynamodb'` arm; also directly constructible for the `'custom'` arm (the `D1Adapter` pattern) |
| `DynamoDatabaseOptions`      | type      | The fifth arm of `BuiltInDatabaseOptions`; read by the plugin's adapter factory                                            |
| `DynamoAdapterOptions`       | type      | `DynamoAdapter`'s constructor parameter; the inject/lazy union                                                             |
| `DynamoEntityMapping`        | interface | Per-entity key mapping supplied by the application; read by `resolveDynamoTarget`                                          |
| `IDynamoClient`              | interface | The structural facade the adapter drives; the type an application injects through `client`                                 |
| `DynamoSdkModule`            | interface | The module shape `createLazyDynamoLoader` adapts — the type the guarded real-import test annotates against                 |
| `createInjectedDynamoLoader` | function  | The `client` arm of `DynamoAdapterOptions` resolution                                                                      |
| `createLazyDynamoLoader`     | function  | The `endpoint`/`region` arm; performs the literal `npm:` import                                                            |

`DynamoTarget`, the expression builder, the marshaller and the access-path resolver are **internal**
and deliberately not exported — the `D1Target` / `MongoTarget` precedent.

### 4.1 Options — every option names its consumer

| Option                               | Consumer                                  | Behavior (per implementation)                                                                                       |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `client`                             | `createInjectedDynamoLoader`              | An already-constructed client; the lazy `npm:` import never runs                                                    |
| `endpoint`                           | `createLazyDynamoLoader`                  | Passed to the constructed client — the emulator address in tests, absent in production                              |
| `region`                             | `createLazyDynamoLoader`                  | Passed to the constructed client                                                                                    |
| `credentials`                        | `createLazyDynamoLoader`                  | Passed through; omitted in production so the SDK's own provider chain applies                                       |
| `entities`                           | `resolveDynamoTarget`                     | `Record<entityName, DynamoEntityMapping>`; an unmapped entity defaults to `{ table: <entity>, partitionKey: 'id' }` |
| `DynamoEntityMapping.table`          | `resolveDynamoTarget`                     | Physical table name; defaults to the entity name                                                                    |
| `DynamoEntityMapping.partitionKey`   | key builder, access-path resolver, guards | Required; the `attribute_exists`/`attribute_not_exists` guard subject (§3.5, §3.6)                                  |
| `DynamoEntityMapping.sortKey`        | key builder, `orderBy` resolver           | When present, `findById` requires a composite key (§3.4) and it is the only orderable field (§3.11)                 |
| `DynamoEntityMapping.indexes`        | access-path resolver                      | Named GSIs with their own partition/sort key; selected when the caller's filter constrains an index partition key   |
| `DynamoEntityMapping.dateAttributes` | filter translator, cursor minting         | Per-attribute `'iso' \| 'epochMs'`; an undeclared attribute makes a `Date` comparison a refusal (§3.14)             |
| `maxPageFetches`                     | `findPage` fill loop                      | Default `10`; on reaching it the page returns with a non-`null` cursor, never terminal (§3.10)                      |
| `logQueries` (inherited)             | the service's logging wrapper             | Reports the resolved access path (`Query`/`Scan`/index name) — the one place the selection is observable            |

## 5. Implementation files

| File                                         | Purpose                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/index.ts`                               | Barrel — the eight symbols in §4                                                              |
| `src/interfaces/index.ts`                    | `DynamoDatabaseOptions` arm; `DynamoAdapterOptions`; `DatabaseAdapterType` widening           |
| `src/adapters/dynamo/dynamo-client-types.ts` | Structural facade for the SDK surface the adapter drives (`IDynamoClient` and command shapes) |
| `src/adapters/dynamo/dynamo-client.ts`       | The inject-or-lazy seam (§3.2) and the literal `npm:` import                                  |
| `src/adapters/dynamo/dynamo-mapping.ts`      | `DynamoEntityMapping` → internal `DynamoTarget` (§3.3)                                        |
| `src/adapters/dynamo/dynamo-marshal.ts`      | AttributeValue ⇄ JS marshalling, including the lossy-`N` rule (§3.15)                         |
| `src/adapters/dynamo/dynamo-expression.ts`   | Name/value aliasing, nested paths, filter and projection expressions (§3.13, §3.14)           |
| `src/adapters/dynamo/dynamo-access-path.ts`  | `Query`-versus-`Scan`-versus-index resolution and `orderBy` mapping (§3.8, §3.11)             |
| `src/adapters/dynamo/dynamo-data-source.ts`  | The six `IDataSource` methods plus `findPage` (§3.4–§3.7, §3.9, §3.10, §3.12, §3.13)          |
| `src/adapters/dynamo/dynamo-adapter.ts`      | `DynamoAdapter` — lifecycle, `createDataSource`, transactions (§3.17), health                 |
| `src/plugin/*`                               | Adapter factory: the `'dynamodb'` arm                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                         | src covered                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/dynamo-client-seam.test.ts`            | `dynamo-client.ts`                          | Both loader arms against a fake `DynamoSdkModule`; the inject arm performs no import                                                                                                                                                                        |
| `test/unit/dynamo-mapping.test.ts`                | `dynamo-mapping.ts`                         | Defaults (`table`, `partitionKey: 'id'`); key columns normalise to a `readonly string[]` in both the partition-only and sort-keyed cases; an unmapped entity resolves                                                                                       |
| `test/unit/dynamo-marshal.test.ts`                | `dynamo-marshal.ts`                         | Round trip per type; nested `M`/`L`; **the lossy-`N` case with a control showing the naive `Number()` path differs** (§3.15)                                                                                                                                |
| `test/unit/dynamo-expression.test.ts`             | `dynamo-expression.ts`                      | Every name aliased (including a reserved word, §1A F1); nested path → `#n0.#n1.#n2` (F2); empty `in` → match-nothing, never `IN ()` (F5); both date encodings and the undeclared-attribute refusal (§3.14)                                                  |
| `test/unit/dynamo-access-path.test.ts`            | `dynamo-access-path.ts`                     | The three selections (table `Query`, index `Query`, `Scan`) asserted on the emitted command; sort-key comparison folded into the key condition                                                                                                              |
| `test/unit/dynamo-order.test.ts`                  | `dynamo-access-path.ts`                     | `asc`/`desc` → `ScanIndexForward`; a non-key field and a two-field `orderBy` each **reject** by name (§3.11)                                                                                                                                                |
| `test/unit/dynamo-key.test.ts`                    | `dynamo-data-source.ts`                     | Scalar key against a sort-keyed entity rejects (P3); a record is projected to exactly the key columns (P4); missing column and empty-string value reject (N3); key-map order is irrelevant (P2)                                                             |
| `test/unit/dynamo-data-source.test.ts`            | `dynamo-data-source.ts`                     | `create` emits `attribute_not_exists` (§3.5); `update` emits `attribute_exists` + `ALL_NEW` and maps `ConditionalCheckFailedException` to a rejection (§3.6); `delete` reads `ALL_OLD` for its boolean (§3.7); `count` loops to exhaustion (Q6)             |
| `test/unit/dynamo-page.test.ts`                   | `dynamo-data-source.ts`                     | **`nextCursor` non-`null` iff `LastEvaluatedKey` present**, including a **zero-row non-terminal page** (Q3); the fill loop stops at `maxPageFetches` with a non-`null` cursor and issues exactly that many calls (§3.10); non-zero `offset` rejects (§3.12) |
| `test/unit/dynamo-transaction.test.ts`            | `dynamo-adapter.ts`                         | Buffered writes flush as one `TransactWriteItems`; `rollback` sends nothing; >100 items and a duplicate item key each reject by name (T2, T3)                                                                                                               |
| `test/unit/dynamo-adapter.test.ts`                | `dynamo-adapter.ts`                         | Lifecycle (`connect`/`disconnect`/`isReady`); `createDataSource` per entity; health indicator; a client rejected at construction when it lacks the driven surface (the M52c/M52d binding-guard precedent)                                                   |
| `test/unit/filter-conformance.test.ts` (extend)   | all adapters                                | The existing one-query-through-every-adapter suite gains DynamoDB: it agrees with the reference result, or refuses by name                                                                                                                                  |
| `test/unit/plugin-options-types.test.ts` (extend) | `interfaces/index.ts`                       | `type: 'dynamodb'` without its required options is a **compile** error (`@ts-expect-error`); the arm is reachable from `DatabasePluginOptions`                                                                                                              |
| `test/unit/barrel-exports.test.ts` (extend)       | `src/index.ts`                              | The eight new symbols are exported; `common`'s barrel is unchanged                                                                                                                                                                                          |
| `test/integration/real-import.test.ts` (extend)   | `dynamo-client.ts`                          | **Guarded real-import**: `createLazyDynamoLoader` performs the literal `npm:@aws-sdk/client-dynamodb@^3` import and drives one command round trip                                                                                                           |
| `test/integration/real-dynamo-adapter.test.ts`    | the whole adapter, against the **emulator** | §6.1 below — the real-world scenarios                                                                                                                                                                                                                       |

### 6.1 The real-emulator suite — what it must prove

Guarded on `DYNAMODB_ENDPOINT` with the BDD **`ignore` option**, never an early `return` (§1), under
the pinned credentials and per-run table suffix of §3.18. Each scenario names the probe it descends
from, so the fixture cannot drift into one that cannot show the defect.

1. **CRUD round trip** — `create`, `findById` read-back, `update` returning the row, `delete`
   returning `true`, `findById` returning `null`. The M10 lesson: every write is **read back**
   through the public surface.
2. **The two write guards, with negative controls (P6, P9).** A duplicate `create` rejects **and the
   original row is intact**; an `update` on a missing key rejects **and no ghost row exists**. Both
   assertions fail if the guard is removed — which is the point, since an unguarded implementation
   passes every fake-backed test.
3. **Sparse-filter pagination (Q2, Q3, S1).** A partition of 10 items of which **2 match**, walked
   at `limit: 3`. Asserts the walk finds **both** matches, that at least one intermediate page
   returned **fewer rows than the limit** with a non-`null` cursor, and that the walk terminates
   only on `nextCursor === null`. The fixture deliberately reproduces the measured `[1,0,1,0]` shape
   — without a sparse filter the trap is invisible and the test passes against the one-extra-row
   rule.
4. **Sorted pagination with ties (M79 P11 precedent).** Ordering by the sort key `desc` across three
   pages with duplicate non-key values: no row appears twice and none is skipped.
5. **The item-collection "join" with filter and ordering (J1, J2).** One partition holding a
   customer profile and three orders. Asserts (a) the whole collection comes back in one page, (b) a
   sort-key `begins_with` narrows it to the orders alone, and (c) `begins_with` + a
   `FilterExpression` on a non-key attribute + `desc` ordering returns exactly the expected order in
   the expected sequence — the multi-entity read this backend serves instead of a join, in one round
   trip.
6. **Nested-path and date filters against real data (F2, F6, F7).** `['profile','address','city']`
   matches; a `Date` comparison against a declared `'iso'` attribute matches; the same comparison
   against an **undeclared** attribute rejects by name.
7. **GSI query and GSI pagination (G1, G2).** A page over a configured index, continued through its
   cursor — the case that fails if the cursor carries the table key rather than the access path's
   four-attribute key.
8. **`count` past a page boundary (Q6).** Asserts the true total, not the first response's `Count`.
9. **Transaction commit and rollback (T1).** Committed writes are visible afterwards; a rolled-back
   unit of work leaves nothing behind.
10. **Access-path selection observed (Q7).** A filter constraining the partition key and one that
    does not both return the correct rows, with `logQueries` reporting `Query` and `Scan`
    respectively — the only place the selection is observable.

### 6.2 CI wiring

- A `dynamodb` service container (`amazon/dynamodb-local:latest`, port `8000`) with a healthcheck
  using the **POST `ListTables` probe** — §1A E3 measured that a bare `GET /` answers **400**, so a
  naive `curl -f http://localhost:8000/` could never pass (the ElasticMQ precedent at
  `ci.yml:54-56`).
- Job-level `DYNAMODB_ENDPOINT: http://127.0.0.1:8000`, using a **mapped `localhost` port**: M53
  established that a `services:` label is not a resolvable hostname for a job running directly on
  the runner.
- `packages/database-plugin/deno.json` gains `127.0.0.1:8000` to its **endpoint-scoped** `net`
  allowlist — in the package manifest, never as a CLI `--allow-net`, which M53 established
  _replaces_ the block rather than unioning with it.
- `test/apps-gate.test.ts` pins the service, the port mapping, the env variable and the scoped
  grant, with each assertion verified to fail when the wiring is broken — because a guarded suite
  that skips silently leaves CI green while proving nothing (the M53 finding).

### 6.3 Negative controls — each observed failing, then reverted

| #  | Control                                                             | Must fail                                                                                 |
| -- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| N1 | Derive `nextCursor` from `rows.length > limit` instead of the token | §6.1 scenario 3 — the walk reports terminal after its first sparse page and loses a row   |
| N2 | Drop `attribute_not_exists` from `create`                           | §6.1 scenario 2 — the original row is destroyed by the duplicate create                   |
| N3 | Drop `attribute_exists` from `update`                               | §6.1 scenario 2 — a ghost row exists after updating a missing key                         |
| N4 | Forward a non-key `orderBy` instead of refusing                     | `dynamo-order.test.ts` — and against the emulator the rows come back **unordered, `200`** |
| N5 | Build `ExclusiveStartKey` from the table key on a GSI page          | §6.1 scenario 7 — `ValidationException` on the second page                                |
| N6 | Alias only known reserved words rather than every name              | `dynamo-expression.test.ts` + §6.1 scenario 5's filter on a reserved attribute            |
| N7 | Unmarshal `N` through `Number()` unconditionally                    | `dynamo-marshal.test.ts` — the 38-digit value degrades to `1e+38`                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m80-dynamodb-backend, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree — a new package arm must still publish
deno task release:verify 0.1.0-alpha.10
```

The full suite is run **twice** — once with the emulator up and once with it stopped — because a
guarded suite must be green under both, and only the second run proves the guard actually guards
(the M53 precedent).

## 8. Risks & mitigations

- **The one-extra-row rule is load-bearing in five adapters and wrong in the sixth.** A reviewer
  porting `mongo-data-source.ts` would carry it across, and every fake-backed test would pass. →
  §3.9 states the invariant explicitly, N1 is a committed negative control, and §6.1 scenario 3's
  fixture is built so the defect is reachable.
- **A contract-violating test double hides the write-guard defects.** A fake `PutItem` that rejects
  a duplicate, or a fake `UpdateItem` that refuses a missing key, would make §3.5/§3.6 look
  unnecessary — the recurring root cause in M37b, M53, M55 and M70j. → The fakes reproduce the
  **measured** behaviour (silent overwrite, silent upsert), and scenarios 2's assertions run against
  the real emulator where no fake is involved.
- **A guarded suite that skips silently leaves CI green.** → §6.2 pins the wiring in
  `test/apps-gate.test.ts`, with the assertions verified to fail when it is broken.
- **The emulator hangs rather than errors on a mis-owned bind mount**, which reads as a network
  fault. → §1B records the named-volume form, the ownership check, and that CI's `-inMemory` default
  sidesteps it.
- **`maxPageFetches` is a cost/completeness trade-off with no universally right value.** → The
  invariant is one-sided (§3.10): a bounded return never claims to be terminal, so the bound can
  only cost an extra round trip, never a lost row.

## 9. Out of scope

- **GSI selection as a portable contract concept** — the adapter uses an index it was configured
  with. Owned by no milestone; M79's out-of-scope list gives the reason.
- **TTL, consistency level, request-unit budgeting** — M78's blocker 3. §1A C1p measures one edge of
  it (`ConsistentRead` is refused on a GSI), recorded so the exclusion is informed rather than
  assumed. Each belongs with the adapter that first needs it.
- **`BatchGetItem` / cross-table key fetch** — measured (§1A J3) and deliberately unexposed: no
  contract member consumes it, and inventing one for a single adapter is the `poolSize` rule.
- **A portable join/relation/include member** — §3.14. Not deferred to a milestone: the framework's
  repository contract is deliberately per-entity, and the multi-entity read DynamoDB _does_ serve is
  expressible with the members it already has.
- **Cosmos DB (M81) and Cloud Bigtable (M82)**, both gated on M79 alongside this milestone.
- **Removing `offset`** — permanently out of scope; released API, §9.4 governs.
