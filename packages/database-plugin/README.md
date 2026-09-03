# @setu-ts/database-plugin

Database access with the repository pattern and Unit of Work. Registers an `IDatabaseService` under
`CAPABILITIES.DATABASE` (`'database'`).

Four adapters ship: `MemoryAdapter` (zero-dependency default), `PrismaAdapter`, `DrizzleAdapter`,
and `MongoAdapter` (the native `mongodb` driver). The application owns the optional ORM and driver
clients and injects them into the plugin.

## ORM compatibility

Drizzle's current tested baseline is `0.45.2`; a broader application-instance range is pending
removal of the adapter's exact lazy-loader pin and tests at both declared endpoints. Prisma v7 is
the current integration, but its formal support range is also pending a boundary repair. Pass
`options.provider` for connector-sensitive `contains` filters rather than relying on automatic
connector detection: that fallback is not a compatibility promise. This distinction is deliberate —
a documented range is a tested compatibility claim, not a guess.

## Installation

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DatabasePlugin, type IDatabaseService } from '@setu-ts/database-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

const prismaClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Deno.env.get('DATABASE_URL')! }),
});

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DatabasePlugin({ type: 'prisma', options: { prismaClient } }),
  ],
});
await app.start({ port: 3000 });

const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
const users = db.getRepository<User, string>('User');

const created = await users.create({ email: 'ada@example.com' });
const page = await users.findAll({
  where: { active: true },
  orderBy: { createdAt: 'desc' },
  limit: 20,
  offset: 0,
});

// Group work into one transaction; a throw rolls back and propagates.
await db.transaction(async (uow) => {
  await uow.getRepository<User, string>('User').update(created.id, { active: true });
});
```

## Options

| Option    | Type                                                                                                 | Default     | Description                              |
| --------- | ---------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------- |
| `type`    | `'memory' \| 'prisma' \| 'drizzle' \| 'mongodb' \| 'dynamodb' \| 'cosmos' \| 'bigtable' \| 'custom'` | `'memory'`  | Backend adapter.                         |
| `name`    | `string`                                                                                             | `'default'` | Named connection for multi-database use. |
| `options` | per-arm (see `type`)                                                                                 | —           | Adapter-specific configuration.          |

A `name` other than `'default'` registers under `database.<name>` (e.g. `database.primary`). Note
the **dot**, not a colon — `createCapabilityToken` rejects colons.

Each arm narrows `options`: `type: 'prisma'` requires `prismaClient`, `type: 'drizzle'` requires
both `drizzleInstance` and `drizzleTables`, `type: 'mongodb'` requires either `url` or `client`,
`type: 'dynamodb'` requires either `region` or `client`; `type: 'cosmos'` requires `database` plus
either an `endpoint`/`key` pair or a `client`; `type: 'bigtable'` requires `instance` plus either a
`projectId` or a `client`; and `type: 'custom'` requires `adapter`. Those are required **by the
union**, so omitting one is a compile error rather than a startup throw. Three arms carry their own
option bag rather than the shared `DatabaseAdapterOptions`: the `'mongodb'` arm its
`MongoAdapterOptions` — see [the MongoDB backend](#the-mongodb-backend) below — the `'cosmos'` arm
its `CosmosAdapterOptions`, see [the Azure Cosmos DB backend](#the-azure-cosmos-db-backend), and the
`'dynamodb'` arm its `DynamoAdapterOptions` (see the `DynamoDB backend` section of
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#dynamodb-backend-dynamodb-arm)),
and the `'bigtable'` arm its `BigtableAdapterOptions` — see
[the Cloud Bigtable backend](#the-cloud-bigtable-backend).

| `options` field      | Type                      | Default | Read by                                                                                                                                                              |
| -------------------- | ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logQueries`         | `boolean`                 | `false` | The database **service**, so it applies to every adapter including `'custom'` — logs entity, operation and monotonic duration.                                       |
| `prismaClient`       | `unknown`                 | —       | Prisma. Required.                                                                                                                                                    |
| `provider`           | `PrismaSqlProvider`       | derived | Prisma. Names the connector when it cannot be detected; see `contains` below.                                                                                        |
| `drizzleInstance`    | `DrizzleDatabaseIdentity` | —       | Drizzle. Required; created by `createDrizzleDatabase()`.                                                                                                             |
| `drizzleTables`      | `Record<string, unknown>` | —       | Drizzle. Required; entity name → real table definition.                                                                                                              |
| `transactionTimeout` | `number` (ms)             | `30000` | Prisma only. Raises Prisma's ~5 s interactive-transaction default, which is too short for a full Unit of Work. Unread by Memory and Drizzle.                         |
| `url`                | `string`                  | —       | **Deprecated and unread by Prisma** — a v7 client carries its own connection configuration; see below. The `'mongodb'` arm reads it as the driver connection string. |

### Prisma 7 setup

Generate and construct the client in the application, then pass it as `options.prismaClient`: a
framework package cannot locate an application-selected generated-client output path. Three
prerequisites are easy to miss, and none of them is this package's to supply:

1. **A driver adapter is required.** Prisma 7 removed the Rust query engine, so `new PrismaClient()`
   with no argument does not compile — install the adapter for your connector (`@prisma/adapter-pg`,
   `@prisma/adapter-mariadb`, …) and pass it as `adapter`.
2. **`schema.prisma` may no longer carry `url`.** Prisma 7 answers
   `P1012: The datasource property
   'url' is no longer supported in schema files`; the connection
   string moves to a `prisma.config.ts`.
3. **A non-`public` PostgreSQL schema must be named on the adapter.** `?schema=…` in the URL is read
   by Prisma Migrate only, so the driver adapter needs
   `new PrismaPg({ connectionString }, { schema })`. Without it every query resolves against
   `public` and fails with `The table 'public.<Model>' does not exist`.

For Drizzle, wrap a configured Promise-aware driver and explicit transaction bridge with
`createDrizzleDatabase()` and pass that opaque configuration beside a table registry. Every field
supplied to repository `where`, `orderBy`, or `select` must be a real column on that table. Its
`create`, `update`, and `delete` operations require a dialect that supports `RETURNING`, so the
adapter can return the actual persisted row instead of guessing:

```typescript
const drizzleDatabase = createDrizzleDatabase(
  db,
  (database, work) => database.transaction(work),
);

DatabasePlugin({
  type: 'drizzle',
  options: {
    drizzleInstance: drizzleDatabase,
    drizzleTables: { User: users },
  },
});
```

### Nested JSON path filters

A `filter` whose `field` is a path array (`['profile', 'city']`) addresses inside a JSON column, and
no two SQL dialects spell that extraction alike — PostgreSQL uses `#>>`, MySQL
`JSON_UNQUOTE(JSON_EXTRACT(…))`, SQLite `json_extract`. The adapter reads the dialect off the
Drizzle instance, which works for every dialect Drizzle ships; pass `dialect` explicitly when
detection cannot name it, and a path filter is otherwise **refused by name** rather than emitted in
a guessed syntax:

```typescript
DatabasePlugin({
  type: 'drizzle',
  options: { drizzleInstance: drizzleDatabase, drizzleTables, dialect: 'postgresql' },
});
```

Two behaviours are worth knowing: `in` expands to an `OR` of equality legs, because no dialect
offers a path membership operator; and extraction normalises to text, casting back to numeric for an
ordered comparison against a number, so `age > 9` matches `30` rather than comparing `'30' > '9'` as
text.

The registry accepts **any** table, including one with a composite primary key. The `id` column is a
repository precondition rather than a registry one — `IRepository.findById`/`update`/`delete` are
single-key by contract — so `getRepository('TenantFlag')` on an `id`-less table is refused by name
while the typed query builder reaches the whole schema. Registering a join or per-tenant table so a
native join can name it therefore no longer locks every other table out.

Promise-aware SQLite Proxy/libsql-shaped Drizzle instances are accepted even when they do not expose
`execute()`. Repositories, transactions, and typed builders remain available; only
`IDatabaseService.query()` rejects, with guidance to use the typed builder instead. That refusal is
a contract requirement rather than an unfinished feature: those drivers do expose `all()`, but on a
raw statement the proxy protocol answers with **positional** rows (`[['a', 1]]`) because Drizzle has
no field map for a statement it did not build, while `query<T>(): Promise<T[]>` promises row objects
— as Prisma and D1 both return.

`IDatabaseService.query(sql, params)` binds every parameter, never interpolating it. The statement
carries the connector's own placeholders (`$1…` on PostgreSQL, `?` on MySQL and SQLite) and is
emitted verbatim for an ascending-placeholder statement. A placeholder count that disagrees with the
parameter list, a gap in the `$N` sequence, or both styles in one statement is refused before the
statement reaches the driver — a mis-bound parameter is silent, so guessing is not an option.

On PostgreSQL, `?`, `?|` and `?&` are also **jsonb key-containment operators**, and no scanner can
tell one from a placeholder. Such a statement is refused here (its token count disagrees with the
parameter list) or fails at the database as a syntax error — never mis-bound. Write it with `$N`
placeholders, which are unambiguous on that connector.

Synchronous callback drivers such as `better-sqlite3`, Bun SQLite, Expo SQLite, and OP SQLite are
not supported by this adapter. Their transaction callbacks return before awaited Unit-of-Work work
can run, so accepting them would falsely report atomicity. `createDrizzleDatabase()` rejects their
published transaction types at compile time; passing an unwrapped instance is rejected during
startup. Unknown Promise-adopting and thenable wrappers are not inferred safe; without an explicit
source-owned bridge they are rejected before native transaction work or application work begins.

### Typed Drizzle queries

Use the same opaque configuration supplied in plugin options. `getDrizzleDatabase()` infers and
returns the full configured type. `getDrizzleTransaction()` derives Drizzle's native callback
transaction type from it, preserving schema and selected-row inference while excluding outer-only
operations such as SQLite Proxy's `batch()`. Repository work and native joins therefore share one
rollback boundary without falsely exposing the complete outer database:

```typescript
import { eq } from 'drizzle-orm';
import {
  createDrizzleDatabase,
  getDrizzleDatabase,
  getDrizzleTransaction,
} from '@setu-ts/database-plugin';

const drizzleDatabase = createDrizzleDatabase(
  drizzleDb,
  (database, work) => database.transaction(work),
);
const outer = getDrizzleDatabase(db, drizzleDatabase);
const allUsers = await outer.select().from(users);

await db.transaction(async (uow) => {
  await uow.getRepository<User>('User').create(newUser);

  const tx = getDrizzleTransaction(uow, drizzleDatabase);
  const joined = await tx
    .select({ userId: users.id, teamName: teams.name })
    .from(users)
    .innerJoin(teams, eq(users.teamId, teams.id));
});
```

Always supply the same opaque object configured on that plugin instance. Package-private storage
correlates the inferred type, database identity, and transaction bridge, so mutation, cloning, or a
freely selected generic cannot claim another database's transaction surface. Use
`getDrizzleDatabase()` when an outer-only operation is needed; `getDrizzleTransaction()`
intentionally exposes only Drizzle's transaction-safe callback surface. Memory, Prisma, and custom
services throw an error naming their configured adapter. Objects not created by this plugin throw an
invalid-scope error.

## The MongoDB backend

`type: 'mongodb'` serves the `database` capability from a document store, over the native
[`mongodb`](https://www.npmjs.com/package/mongodb) driver (`npm:mongodb@^6.21.0`). It implements all
six `IDataSource` methods and translates all six `NormalizedQuery` members natively — `where` and
`filter` become a match document, `orderBy`/`offset`/`limit`/`select` become
`sort`/`skip`/`limit`/`projection`. Nothing is filtered, sorted or paginated in JavaScript.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'mongodb',
  options: {
    url: 'mongodb://127.0.0.1:27017/app',
    collections: { User: { collection: 'users', primaryKey: 'user_id' } },
  },
}));
```

| `options` field | Type                                 | Default            | Read by                                                                                                             |
| --------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `url`           | `string`                             | —                  | The lazy client path. Required unless `client` is supplied; also supplies `database` when that option is absent.    |
| `client`        | `IMongoClient`                       | —                  | `connect()`. An already-constructed client; when present the lazy `import('npm:mongodb@^6.21.0')` never runs.       |
| `objectIdCtor`  | `IMongoObjectIdCtor`                 | from the lazy load | The `_id` conversion. Supply it alongside an injected `client` whose collections use `ObjectId` keys.               |
| `database`      | `string`                             | from `url`         | The collection resolver. When neither this nor `url` yields a name, `connect()` fails at startup naming the option. |
| `collections`   | `Record<string, MongoEntityMapping>` | `{}`               | Per-entity `{ collection?, primaryKey?, idType? }`. An unmapped entity uses its own name and `'id'`.                |

**Identity.** `_id` is mapped to the configured primary key on read and back to `_id` on write. An
`ObjectId` is rendered as its 24-hex string so a row stays `JSON.stringify`-able; a JSON scalar
(`string`, `number`, `boolean`, `null`) keeps its own type, so the value `create()` returns is the
value `findById()` accepts. Under the default `idType: 'auto'` a 24-hex **string** id is converted
to an `ObjectId`, because `findOne({ _id: '<24-hex>' })` misses an `ObjectId` key; anything else —
including a numeric primary key — is passed to the driver verbatim. `'objectId'` forces the
conversion and refuses a value it cannot convert by name; `'raw'` forbids it, which is the setting
for a collection whose `_id` values genuinely are 24-hex strings (no runtime test can tell that case
from an `ObjectId` one).

**`contains`.** Compiles to an escaped `$regex`. This is the inverse of the SQL case: `%` and `_`
are ordinary data in Mongo, while `.` and `*` are wildcards, so the value is regex-escaped and a
search for `3.5` does not match `315`. The match is **case-sensitive** and cannot be made otherwise
through this operator: MongoDB does not apply a collection's collation to `$regex`, so even a
case-insensitive collation leaves `contains` case-sensitive.

**`rawQuery` is refused by name** with `UnsupportedRawQueryError` — MongoDB has no SQL, so
`IDatabaseService.query()` is unavailable on this arm and an application reaches the injected client
directly for native commands (`aggregate`, `runCommand`), exactly as it does for a Prisma raw query.

**Transactions** use a driver session. They require a replica set, and the refusal is late and named
— `beginTransaction()` throws `MongoTransactionUnavailableError`, never `connect()` — so a
standalone `mongod` remains a valid deployment for an application that never opens one.

## The Azure Cosmos DB backend

`type: 'cosmos'` serves the `database` capability from Azure Cosmos DB's **NoSQL (SQL) API**, over
[`@azure/cosmos`](https://www.npmjs.com/package/@azure/cosmos) (`npm:@azure/cosmos@^4`). Every
`NormalizedQuery` member is translated natively — `where`/`filter` become a bound SQL predicate,
`orderBy` an `ORDER BY`, `offset`/`limit` an `OFFSET … LIMIT`, and `select` a projection list.
Nothing is filtered, sorted or paginated in JavaScript.

Cosmos DB's **MongoDB API** is a different wire protocol and is served by the `'mongodb'` arm
pointed at a Cosmos connection string, not by this one. That route is documented rather than tested,
and the reason is a **version floor rather than a dead image**: the emulator's MongoDB endpoint
(`AZURE_COSMOS_EMULATOR_ENABLE_MONGODB_ENDPOINT`) tops out at API version **4.0**, which reports
wire version 7, while the `npm:mongodb@^6` driver this package pins requires wire version 8 (MongoDB
4.2). Measured: the endpoint completes a handshake and then refuses with
`reports maximum wire version 7, but this version of the Node.js Driver requires at least 8`. A live
Azure Cosmos for MongoDB account offers server versions above that floor, so the route is
**unverified against a live account** rather than known to fail.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'cosmos',
  options: {
    endpoint: 'https://my-account.documents.azure.com:443/',
    key: cosmosKey,
    database: 'app',
    containers: { Order: { container: 'orders', partitionKey: 'tenantId' } },
  },
}));
```

| `options` field | Type                                  | Default | Read by                                                                                                                               |
| --------------- | ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`      | `string`                              | —       | The lazy client path. Required unless `client` is supplied.                                                                           |
| `key`           | `string`                              | —       | The lazy client path. Required unless `client` is supplied.                                                                           |
| `client`        | `ICosmosClient`                       | —       | `connect()`. When present the lazy `import('npm:@azure/cosmos@^4')` never runs — the route for an Entra ID (managed identity) client. |
| `database`      | `string`                              | —       | **Required on both arms.** A Cosmos endpoint encodes no database name, so unlike a MongoDB URI there is nothing to fall back to.      |
| `containers`    | `Record<string, CosmosEntityMapping>` | `{}`    | Per-entity `{ container?, primaryKey?, partitionKey? }`. An unmapped entity uses its own name and `'id'`.                             |
| `logQueries`    | `boolean`                             | `false` | The database service, exactly as for every other arm.                                                                                 |

**Containers must already exist.** The adapter creates no database and no container: throughput,
partition-key and indexing choices belong to the application's provisioning. A missing container is
refused by name at first use, naming the database and the container.

**The partition key is discovered, not guessed.** A point read carrying the wrong partition key
answers **404 rather than an error**, so a mistyped path would make every read of a healthy
container report "not found" for the life of the process. The adapter therefore reads the container
definition once per container and uses the paths it declares. A `partitionKey` in the mapping is
still honoured — and **validated** against the definition, refused by name when the two disagree.

**Identity.** A Cosmos document is addressed by the pair (partition key, `id`), which is why
`findById` behaves in three ways:

- a composite `EntityKey` record carrying both the primary key and the partition key is a **point
  read**;
- a scalar key is also a point read when the container partitions by the primary-key field itself;
- otherwise the partition key is unknown, so the row is found by a cross-partition query. That costs
  more request units than a point read, and an `id` is unique only WITHIN a partition, so a lookup
  matching two documents is refused by name rather than answered with one of them.

A primary key must be a **string**: the service refuses a non-string `id` outright, and converting
one silently would return a key of a different type than the caller supplied. A partition-key value
of any other JSON scalar type is passed through untouched.

**`update`** merges the payload server-side with a `patch` while it fits within one request, and
falls back to a read-merge-`replace` guarded by the document's `_etag` beyond that — a concurrent
writer is then reported as `CosmosConcurrentModificationError` rather than silently overwritten. The
primary key never travels in the payload, and a payload that would CHANGE a partition-key value is
refused by name, because such a replace answers 404 rather than moving the item.

**`contains`** compiles to `CONTAINS`, a literal substring match in which `%` and `_` carry no
special meaning, so nothing is escaped — the inverse of the SQL case. The match is
**case-sensitive**.

**Pagination** uses the framework's portable keyset cursor rather than a Cosmos continuation token.
That is this adapter's design choice, and it is what the tested backend supports: measured against
the emulator, an `ORDER BY` query returns no continuation token even when `maxItemCount` is supplied
as a query option — the option is ignored and the whole result set arrives in one page. The claim is
scoped to what was measured rather than asserted of every Cosmos deployment, and a page without a
stable sort is not a page in any case. On a real account a multi-property `ORDER BY` needs a
composite index, and keyset paging always adds the key column as its tiebreaker — so define a
composite index over `(sort field, id)` for every container you page.

**`rawQuery` is refused by name** with `UnsupportedRawQueryError`. Cosmos has a SQL dialect, but
every query is scoped to one container and `query(sql, params)` names none; an application reaches
the injected client directly (`container.items.query`).

**Transactions are a deferred batch.** Cosmos has no interactive transaction, so
`beginTransaction()` buffers every write and flushes the buffer as one transactional batch at
commit, and `rollback()` discards it without sending anything. That batch is atomic within **one
container and one partition-key value**, and caps at 100 operations; a write that leaves those
bounds is refused with `CosmosTransactionScopeError` at the write itself, naming what it crossed.
Reads inside a transaction observe committed state only.

A buffered `update` is a **patch**, not a whole-document replace, exactly as the non-transactional
path is: it writes only the fields the payload names, so it neither clobbers a concurrent writer's
other fields nor discards an earlier update of the same row — two patches of one row compose. Only
an update too wide for a single patch request falls back to a replace assembled from the committed
read, and that replace carries the whole document, so it cannot compose: buffering one for a row the
same transaction has ALREADY written is refused with `CosmosTransactionScopeError` rather than
silently discarding the earlier write. Merge the two updates, or use two transactions.

`rollback()` is **idempotent**, unlike `commit()`. That asymmetry is deliberate: the framework rolls
back inside the same `catch` that sees a failed commit, so a refusal there would replace the batch's
own diagnostic — its status and per-operation codes, the only thing naming the operation that failed
— with a complaint about rollback, on every throttled or rejected batch.

### What this adapter deliberately cannot do

Two of these are **platform** limits — what Cosmos itself refuses — and three are **contract**
limits, which the portable data-access contract does not express. The distinction decides who could
close them:

| Not available                       | Why                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-container joins               | **Impossible on Cosmos.** A query addresses exactly one container; a second source in the `FROM` or a `JOIN` against another container is rejected with a 400 (measured, both spellings). Cosmos's `JOIN` unwinds an array **inside one item**, which the portable contract has no member for — reach the injected client for it.   |
| Grouping / aggregation              | **Absent from the portable contract**, not from Cosmos. `NormalizedQuery` carries `where`/`filter`/`orderBy`/`limit`/`offset`/`select`/`cursor`, and `count` is its only aggregate; the dialect itself supports `GROUP BY` (measured). Closing this is a `common` widening every adapter would have to answer, not a Cosmos change. |
| Continuation tokens                 | **Not returned by Cosmos** for any query carrying `ORDER BY` (measured, cross-partition and single-partition alike), which is why paging is the portable keyset cursor.                                                                                                                                                             |
| `rawQuery` / `query()`              | Refused by name: a Cosmos query is scoped to one container, and the signature names none.                                                                                                                                                                                                                                           |
| RUs, consistency, TTL, index policy | Outside the portable contract by design — no two candidate backends spell any of them alike. Configure them on the container, or reach the injected client.                                                                                                                                                                         |

### Running the guarded Cosmos suite

`test/integration/real-cosmos-adapter.test.ts` is guarded on `COSMOS_ENDPOINT` and skipped without
it. Against the local emulator:

```bash
docker run -d --name cosmos -p 127.0.0.1:8082:8082 \
  -e PORT=8082 -e PROTOCOL=http \
  mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview
# wait for "PostgreSQL=OK, Gateway=OK" in `docker logs cosmos` (~25 s cold)

COSMOS_ENDPOINT=http://127.0.0.1:8082/ deno test -A \
  packages/database-plugin/test/integration/real-cosmos-adapter.test.ts
```

`COSMOS_KEY` defaults to the emulator's well-known key; set it for a real account. The suite is
**not** run by CI — the image is 2.5 GB, which is the same reason the Pub/Sub and Service Bus
emulator suites are local-only.

## The Cloud Bigtable backend

`type: 'bigtable'` serves the `database` capability from Google Cloud Bigtable, over
[`@google-cloud/bigtable`](https://www.npmjs.com/package/@google-cloud/bigtable)
(`npm:@google-cloud/bigtable@^6`).

**Bigtable inverts the DynamoDB problem.** Its row key is a single lexicographically-sorted string,
so `findById` fits it natively with no key object at all. What it lacks instead is everything
_around_ the key: there is **no secondary index of any kind**, so a predicate on a non-key column is
a scan, and `orderBy` is row-key order or nothing.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'bigtable',
  options: {
    projectId: 'my-project',
    instance: 'app-instance',
    tables: {
      Order: {
        table: 'orders',
        rowKey: { fields: ['tenantId', 'orderId'], separator: '#' },
        columnFamily: 'o',
        columns: { total: 'metrics:amount' },
      },
    },
  },
}));
```

| `options` field  | Type                                    | Default | Read by                                                                                                                             |
| ---------------- | --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`      | `string`                                | —       | The lazy client path. Required unless `client` is supplied.                                                                         |
| `instance`       | `string`                                | —       | **Required on both arms.** A table is addressed as `project/instance/table`, and neither a client nor a project encodes it.         |
| `apiEndpoint`    | `string`                                | —       | The lazy client path. The emulator address; an endpoint alone reaches `cbtemulator` with no credentials.                            |
| `client`         | `IBigtableClient`                       | —       | `connect()`. When present the lazy `import('npm:@google-cloud/bigtable@^6')` never runs.                                            |
| `tables`         | `Record<string, BigtableEntityMapping>` | `{}`    | Per-entity `{ table?, rowKey?, columnFamily?, columns?, valueEncoding? }`. An unmapped entity uses its own name, `['id']` and `cf`. |
| `maxPageFetches` | `number`                                | `10`    | `findPage`'s fill loop, bounding the re-fetch when a client-side filter empties a raw batch.                                        |
| `logQueries`     | `boolean`                               | `false` | The database service, exactly as for every other arm.                                                                               |

**Tables must already exist.** The adapter creates no instance and no table: column families,
garbage-collection policies and split points belong to the application's provisioning. A missing
table is reported by the service as `5 NOT_FOUND` quoting the full resource path, which is also why
`connect()` issues **no RPC at all** — an `instance.getTables()` probe is a table-ADMIN call a
data-plane service account commonly cannot make, so probing would refuse a working configuration.
Configuration mistakes are caught at construction instead, by name.

**The row key is composed from logical fields.** `rowKey: { fields, separator?, prefix? }` maps the
repository's `EntityKey` onto the single string Bigtable addresses a row by. A single-field key
accepts a scalar; a multi-field key requires a record naming every field, and refuses a scalar — a
scalar cannot say which field it is. A field value **containing the separator is refused**, because
two different logical keys would otherwise compose to one row key: a write would silently overwrite
an unrelated row and a read would return it.

**A key field's type is not part of the row key.** A numeric field renders as its decimal text, so
`1` and `'1'` are one physical row: creating one refuses the other as existing, and `findById('1')`
answers the row stored under `1` — whose `id` cell still decodes as the number. Tagging the key
would make it unreadable in `cbt` and break every table this adapter did not write, so the mapping
does not; choose one type per key field. If lexicographic order matters for a numeric field,
zero-pad it, exactly as you would writing row keys by hand.

Key fields are written as ordinary cells AND recovered from the row key on read, with the **cells
winning**. All three parts matter: a Bigtable row cannot exist with zero cells, so writing the key
guarantees the row exists; the row key is bytes and records no type, so overlaying it over a cell
would turn a numeric key field into a string; and a table written outside this framework has no key
cells at all, which is what the parse-back is for.

**Values are tagged by default.** `valueEncoding: 'tagged'` writes `<tag>:<payload>`, so a number,
boolean, `null`, `Date` or object round-trips as itself. A cell carrying no recognised tag decodes
as its raw string — the interop path, without which this adapter could not read a table it did not
write. `valueEncoding: 'raw'` writes `String(value)` and reads every cell as a string, which removes
the residual ambiguity for an application whose table is entirely foreign.

**`orderBy` is the row key or nothing.** An empty sort is honoured, and so is one naming exactly the
mapped key fields, in order, all ascending — that IS the scan order. Everything else is refused by
name: a non-key field has no index to sort by, and **descending is refused deliberately** rather
than shipped on `reversed: true`, because the emulator this adapter is tested against **silently
ignores** that option (measured: it answered ascending, with no error), so a descending path could
not be verified. A non-zero `offset` is refused too — Bigtable has no row offset, and discarding
scanned rows would read and bill them.

**Three things reach the server, and nothing else.** The row set (an `eq` on every key field is an
exact key; an `eq` pinning a leading prefix is a prefix range; a pinned prefix plus an `in` on the
final field is an explicit key list), byte-exact value equality for each conjunctive non-key `eq`,
and the column projection. Everything else — `contains`, the ordered comparisons, `in` on a non-key
field, any disjunction — is evaluated by the same `matchesFilter` the memory adapter uses as the
portable reference, so the six backends cannot drift about what a `FilterExpression` means. The
invariant is that **a push-down may only ever match a superset** of what the client-side evaluator
keeps; every fallback widens rather than narrows.

Two details of that push-down are correctness requirements rather than tuning. A value test is an
exact BYTE RANGE and never the SDK's string form, which is a **regex** — measured,
`{ value: 'a.*b' }` matched both `a.*b` and `axxb`. And it is wrapped in a `condition` filter rather
than chained directly, because a bare chain STRIPS every non-matching cell, so the row would come
back carrying only the cell that matched. An ordered comparison on a key field is **not** pushed
down either: the composed key is a string, so a numeric key field does not sort numerically inside
it — zero-pad a numeric key field if you need its lexicographic order to match.

**Pagination is a start-key cursor** over the framework's portable keyset codec, which is exactly
what Bigtable's continuation mechanism is. `nextCursor` is non-`null` if and only if the page is
non-terminal, never derived from `rows.length`: a client-side filter can empty a whole raw batch, so
a page bounded by `maxPageFetches` returns zero rows AND a cursor, minted from the last row scanned.

**`rawQuery` is refused by name** with `UnsupportedRawQueryError`. Bigtable has no query language
behind `query(sql, params)` — its data plane is ReadRows, MutateRow and CheckAndMutateRow — so
`IDatabaseService.query()` is unavailable on this arm and an application reaches the injected client
directly.

**Transactions are one row.** Bigtable's only atomicity unit is the single row: a multi-row batch is
atomic per entry and not as a whole. So `beginTransaction()` buffers writes, refuses a second row
key **at the write that crosses the bound** with `BigtableTransactionScopeError`, and commits the
buffer as ONE CheckAndMutateRow whose mutation list applies atomically and in order — a buffered
delete followed by writes replaces the row wholesale. `rollback()` discards and sends nothing, and
is idempotent. Reads inside a transaction observe committed state only.

`create` and `update` are **conditional** writes, not blind ones: Bigtable's `insert` is an upsert,
so `create` would otherwise overwrite an existing row and `update` would fabricate an absent one.
The CheckAndMutateRow match flag is what makes both refusals real, and it holds inside a transaction
too — a buffered `create` whose row turns out to exist is refused at commit.

### What this adapter deliberately cannot do

| Not available                    | Why                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any non-key sort or index        | **Absent from Bigtable.** There are no secondary indexes; the row key is the only ordering. Design the row key for the access pattern, as the platform intends.                                                     |
| Descending scans                 | Refused rather than shipped: the emulator this adapter is tested against silently ignores `reversed: true`, so the path could not be verified. Re-openable by a milestone that can test a live instance.            |
| `offset`                         | **Absent from Bigtable.** Emulating one would read and bill the skipped rows; `findPage` is the route.                                                                                                              |
| `rawQuery` / `query()`           | Refused by name: Bigtable's data plane is ReadRows/MutateRow/CheckAndMutateRow, and GoogleSQL `executeQuery` has no portable member in this contract.                                                               |
| Cell versioning and GC policies  | **Outside the portable contract by design** — no other backend has a counterpart, so exposing it would invent a concept for one adapter. Configure GC on the column family; reach the injected client for versions. |
| Multi-row transactions           | **Absent from Bigtable.** A batch is atomic per entry, not as a whole; a second row key is refused by name rather than promised.                                                                                    |
| Grouping / aggregation and joins | **Absent from the portable contract**, exactly as for Cosmos and DynamoDB. `count` is its only aggregate.                                                                                                           |

### Running the guarded Bigtable suite

`test/integration/real-bigtable-adapter.test.ts` is guarded on `BIGTABLE_EMULATOR_ENDPOINT` and
skipped without it. Against the local emulator:

```bash
docker run -d --name he-bigtable -p 127.0.0.1:8086:8086 \
  gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
  gcloud beta emulators bigtable start --host-port=0.0.0.0:8086

BIGTABLE_EMULATOR_ENDPOINT=127.0.0.1:8086 deno test -A \
  packages/database-plugin/test/integration/real-bigtable-adapter.test.ts
```

The emulator implements **no instance admin API** — `instance.create()` answers `12 UNIMPLEMENTED` —
so instances are implicit and the suite creates tables directly. Unlike the Cosmos one, this suite
**is** run by CI: the image is 1.75 GB against the Cosmos emulator's 2.48 GB, and every push-down
above is only correct if the service agrees.

## Filtering and single-row lookup

`findAll`, `findOne`, and `count` accept an equality `where` map and an optional portable `filter`
expression. The two are conjoined, so existing `where`-only calls are unchanged. Every built-in
adapter — Memory, Prisma, Drizzle, and cloudflare-plugin's D1 — translates the same operators: `eq`,
`contains`, `gt`, `gte`, `lt`, `lte`, and `in`, composed with `and` / `or`.

```typescript
const repo = db.getRepository<User>('User');

const user = await repo.findOne({
  filter: { type: 'comparison', field: 'email', operator: 'eq', value: 'ada@example.com' },
});

const recent = await repo.findAll({
  where: { active: true },
  filter: {
    type: 'or',
    filters: [
      { type: 'comparison', field: 'name', operator: 'contains', value: 'Ada' },
      { type: 'comparison', field: 'age', operator: 'gte', value: 18 },
    ],
  },
  orderBy: { age: 'desc' },
});
```

`findOne` returns the first matching row or `null`; it is `findAll` with `limit: 1`, so it shares
one evaluation path with every adapter. An `in` with an empty list matches nothing, and a list
containing `null` matches rows whose column is null (SQL `IN` never matches `NULL` on its own, so
the adapters emit an explicit null branch).

**`contains` is a substring match, and its case sensitivity belongs to the database.** The Memory
adapter, D1 and Mongo match case-sensitively — Mongo compiles to `$regex`, which MongoDB does not
apply collation to, so a case-insensitive collection collation does not change it. A `LIKE`-based
backend follows the column's collation, which is case-sensitive on PostgreSQL and case-insensitive
on SQLite and most MySQL collations.

**`%` and `_` in the searched value are data, never wildcards — and on the Prisma adapter the
connector decides how that is achieved.** Memory (`includes`), Drizzle (`LIKE … ESCAPE '\'`) and D1
(`instr`) honour it unconditionally. Prisma emits a bare `LIKE` with no `ESCAPE` clause, so the
effective escape character is the connector's own default:

| Prisma connector                                               | `contains` behaviour                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgresql` / `postgres`, `mysql`, `sqlserver`, `cockroachdb` | Value escaped and matched literally — their `LIKE` defaults its escape character to backslash.                                                                                                                                                         |
| `mongodb`                                                      | Value passed through unchanged — `contains` compiles to a `$regex` match, where `%` and `_` are already literal.                                                                                                                                       |
| `sqlite`                                                       | **Refused** with `UnsupportedFilterOperatorError` — Prisma emits no `ESCAPE` clause and SQLite defines no default escape character, so a literal match is not expressible through Prisma's filter API. Use a raw query, or the Memory/Drizzle adapter. |

When the connector cannot be determined the same error is thrown naming the `provider` option; pass
`provider` (e.g. `provider: 'postgresql'`) in the adapter options to name it explicitly.

## The Memory adapter's guarantees

`MemoryAdapter` is the default because it needs no driver, not because it is a stand-in for one. It
is **never given a schema**, so what it can and cannot enforce follows from that, and the difference
matters most to the people it is aimed at: develop against the default, deploy against Prisma or
Drizzle, and an unenforced rule becomes a 500 in production.

| Behaviour                           | Memory                                        | Prisma / Drizzle |
| ----------------------------------- | --------------------------------------------- | ---------------- |
| Unknown `select` / `orderBy` column | **Refused by name**                           | Refused by name  |
| Unknown `where` / `filter` field    | Matches nothing                               | Refused          |
| Unique constraint                   | Not enforced — a duplicate value is accepted  | Enforced         |
| Column types                        | Not enforced — a string into an Int is stored | Enforced         |
| Foreign keys, checks, defaults      | Not enforced                                  | Enforced         |

Only the first row is something this adapter can decide, and it does: a `select` or `orderBy` field
that **no stored row carries** is refused with the entity, the clause and the observed column list,
matching what Drizzle answers for the same call. Two consequences of measuring rather than declaring
are worth knowing: a field carried by at least one row counts as known (so a sparse optional column
works), and an entity holding no rows at all accepts anything, because there is nothing to observe
and nothing to return.

`where` and `filter` are deliberately **not** checked. Without a schema this adapter cannot tell an
unknown column from one that is absent on every row, and returning no rows is a defensible answer to
the second — whereas ordering by a column no row has returns rows in an arbitrary order and
projecting one silently changes the response shape.

Uniqueness and types are outside what any schema-less store can do. **Use the Memory adapter for
development and tests, and run integration tests against the backend you deploy on.**

## What a refused query returns to the client

The three query-shape refusals — `UnsupportedQueryFeatureError`, `UnsupportedFilterOperatorError`
and `UnsupportedRawQueryError` — are answered **`501 Not Implemented`** when `@setu-ts/exceptions`'
`errorHandler` is registered. The **status and the detail sentence are the invariant**; the body's
shape is the format that application configured. Under `format: 'rfc9457'`:

```json
{
  "type": "about:blank",
  "title": "Not Implemented",
  "status": 501,
  "detail": "Query feature 'orderBy' is not supported by the 'dynamodb' database adapter."
}
```

Under the `default` format the same refusal reads
`{"statusCode":501,"message":"Not Implemented","details":{"detail":"…"}}`, and with no
`errorHandler` registered, `{"error":"Not Implemented","detail":"…"}`.

`501` because the condition is permanent and the backend genuinely does not implement what the query
asked for. This is the shape you meet when **switching backends**, which is what the portable
contract is for: an application that works on MongoDB will answer `501` on an ordered endpoint under
DynamoDB rather than the `500 Internal Server Error` it used to (M89b).

**The error's `message` is never served.** It is the full diagnostic — it names entities, columns
and sort keys — and it reaches the log alone, where `errorHandler` records it unmasked along with
the cause chain. The served `detail` is composed from the framework's own identifiers, which is what
lets a refusal be readable without becoming a disclosure channel.

The transaction and concurrency errors (`MongoTransactionUnavailableError`,
`CosmosTransactionScopeError`, `CosmosConcurrentModificationError`, `BigtableTransactionScopeError`)
deliberately keep the masked `500`: they may quote backend state, and a concurrency conflict is
transient rather than permanent. Branch on them with `instanceof` — every one is exported.

## Transactions

`IUnitOfWork` groups repository work into one transaction. Prisma exposes only callback-style
`$transaction` with a default timeout, so the adapter bridges that model rather than offering
imperative begin/commit.

## Exports

| Export                                    | Kind      |
| ----------------------------------------- | --------- |
| `createDrizzleDatabase`                   | function  |
| `createDrizzleDataSource`                 | function  |
| `createInjectedBigtableLoader`            | function  |
| `createInjectedDynamoLoader`              | function  |
| `createLazyBigtableLoader`                | function  |
| `createLazyDynamoLoader`                  | function  |
| `createPrismaDataSource`                  | function  |
| `DatabasePlugin`                          | function  |
| `decodeCursor`                            | function  |
| `encodeCursor`                            | function  |
| `getDrizzleDatabase`                      | function  |
| `getDrizzleTransaction`                   | function  |
| `keysetPredicate`                         | function  |
| `BaseRepository`                          | class     |
| `BigtableAdapter`                         | class     |
| `BigtableTransactionScopeError`           | class     |
| `CosmosAdapter`                           | class     |
| `CosmosConcurrentModificationError`       | class     |
| `CosmosTransactionScopeError`             | class     |
| `DatabaseService`                         | class     |
| `DrizzleAdapter`                          | class     |
| `DrizzleRepository`                       | class     |
| `DynamoAdapter`                           | class     |
| `MemoryAdapter`                           | class     |
| `MongoAdapter`                            | class     |
| `MongoTransactionUnavailableError`        | class     |
| `PrismaAdapter`                           | class     |
| `PrismaRepository`                        | class     |
| `UnitOfWork`                              | class     |
| `UnsupportedFilterOperatorError`          | class     |
| `UnsupportedQueryFeatureError`            | class     |
| `UnsupportedRawQueryError`                | class     |
| `BigtableAdapterOptionsBase`              | interface |
| `BigtableCell`                            | interface |
| `BigtableClientConfiguration`             | interface |
| `BigtableClientLoader`                    | interface |
| `BigtableDatabaseOptions`                 | interface |
| `BigtableEntityMapping`                   | interface |
| `BigtableReadOptions`                     | interface |
| `BigtableReadRow`                         | interface |
| `BigtableRowBoundary`                     | interface |
| `BigtableRowKeyMapping`                   | interface |
| `BigtableRowRange`                        | interface |
| `BigtableValueRange`                      | interface |
| `CosmosAccessCondition`                   | interface |
| `CosmosAdapterOptionsBase`                | interface |
| `CosmosBatchDeleteOperation`              | interface |
| `CosmosBatchInsertOperation`              | interface |
| `CosmosBatchPatchOperation`               | interface |
| `CosmosBatchReplaceOperation`             | interface |
| `CosmosBatchResponse`                     | interface |
| `CosmosContainerDefinition`               | interface |
| `CosmosDatabaseOptions`                   | interface |
| `CosmosEntityMapping`                     | interface |
| `CosmosFeedResponse`                      | interface |
| `CosmosItemResponse`                      | interface |
| `CosmosPatchOperation`                    | interface |
| `CosmosQueryParameter`                    | interface |
| `CosmosQuerySpec`                         | interface |
| `CosmosRequestOptions`                    | interface |
| `CountOptions`                            | interface |
| `CursorPayload`                           | interface |
| `CustomDatabaseOptions`                   | interface |
| `DatabaseAdapterOptions`                  | interface |
| `DatabaseConnectionOptions`               | interface |
| `DrizzleAdapterOptions`                   | interface |
| `DrizzleCompositeKeyOptions`              | interface |
| `DrizzleDatabase`                         | interface |
| `DrizzleDatabaseIdentity`                 | interface |
| `DrizzleDatabaseOptions`                  | interface |
| `DynamoAdapterOptionsBase`                | interface |
| `DynamoAttributeValue`                    | interface |
| `DynamoClientConfiguration`               | interface |
| `DynamoClientLoader`                      | interface |
| `DynamoConditionExpression`               | interface |
| `DynamoDatabaseOptions`                   | interface |
| `DynamoDeleteItemCommandInput`            | interface |
| `DynamoDeleteItemCommandOutput`           | interface |
| `DynamoEntityMapping`                     | interface |
| `DynamoExpressionAttributes`              | interface |
| `DynamoGetItemCommandInput`               | interface |
| `DynamoGetItemCommandOutput`              | interface |
| `DynamoIndexMapping`                      | interface |
| `DynamoPutItemCommandInput`               | interface |
| `DynamoPutItemCommandOutput`              | interface |
| `DynamoQueryCommandInput`                 | interface |
| `DynamoReadCommandInput`                  | interface |
| `DynamoReadCommandOutput`                 | interface |
| `DynamoSdkClient`                         | interface |
| `DynamoSdkCommand`                        | interface |
| `DynamoSdkModule`                         | interface |
| `DynamoTransactDelete`                    | interface |
| `DynamoTransactPut`                       | interface |
| `DynamoTransactUpdate`                    | interface |
| `DynamoTransactWriteItem`                 | interface |
| `DynamoTransactWriteItemsCommandInput`    | interface |
| `DynamoUpdateItemCommandInput`            | interface |
| `DynamoUpdateItemCommandOutput`           | interface |
| `FindOptions`                             | interface |
| `IAdapterTransaction`                     | interface |
| `IBigtableClient`                         | interface |
| `IBigtableInstance`                       | interface |
| `IBigtableRow`                            | interface |
| `IBigtableTable`                          | interface |
| `ICosmosClient`                           | interface |
| `ICosmosContainer`                        | interface |
| `ICosmosDatabase`                         | interface |
| `ICosmosItem`                             | interface |
| `ICosmosItems`                            | interface |
| `ICosmosQueryIterator`                    | interface |
| `IDatabaseAdapter`                        | interface |
| `IDatabaseService`                        | interface |
| `IDataSource`                             | interface |
| `IDynamoClient`                           | interface |
| `IMongoClient`                            | interface |
| `IMongoCollection`                        | interface |
| `IMongoCollectionFindOneAndUpdateOptions` | interface |
| `IMongoCursor`                            | interface |
| `IMongoDatabase`                          | interface |
| `IMongoObjectId`                          | interface |
| `IMongoObjectIdCtor`                      | interface |
| `IMongoSession`                           | interface |
| `IRepository`                             | interface |
| `IUnitOfWork`                             | interface |
| `MemoryDatabaseOptions`                   | interface |
| `MongoAdapterOptionsBase`                 | interface |
| `MongoDatabaseOptions`                    | interface |
| `MongoEntityMapping`                      | interface |
| `MongoOptions`                            | interface |
| `NormalizedQuery`                         | interface |
| `Page`                                    | interface |
| `PageResult`                              | interface |
| `PrismaAdapterOptions`                    | interface |
| `PrismaCompositeKeyOptions`               | interface |
| `PrismaDatabaseOptions`                   | interface |
| `BigtableAdapterOptions`                  | type      |
| `BigtableFilter`                          | type      |
| `BigtableMutation`                        | type      |
| `BigtableRowData`                         | type      |
| `BigtableValueEncoding`                   | type      |
| `BuiltInDatabaseOptions`                  | type      |
| `CosmosAdapterOptions`                    | type      |
| `CosmosBatchOperation`                    | type      |
| `CosmosPartitionKeyValue`                 | type      |
| `CursorValue`                             | type      |
| `DatabaseAdapterType`                     | type      |
| `DatabasePluginOptions`                   | type      |
| `DataSource`                              | type      |
| `DrizzleTransaction`                      | type      |
| `DrizzleTransactionBridge`                | type      |
| `DynamoAdapterOptions`                    | type      |
| `DynamoAttributeMap`                      | type      |
| `DynamoCommandConstructor`                | type      |
| `DynamoDateEncoding`                      | type      |
| `DynamoScanCommandInput`                  | type      |
| `DynamoTransactWriteItemsCommandOutput`   | type      |
| `EntityKey`                               | type      |
| `FilterComparison`                        | type      |
| `FilterExpression`                        | type      |
| `FilterOperator`                          | type      |
| `MongoAdapterOptions`                     | type      |
| `MongoWriteOptions`                       | type      |
| `OrderDirection`                          | type      |
| `PageOptions`                             | type      |
| `PrismaSqlProvider`                       | type      |
| `SqlJsonDialect`                          | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#databaseplugin-setu-tsdatabase-plugin).
