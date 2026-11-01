# @setu-ts/database-plugin

Database access with the repository pattern and Unit of Work. Registers an `IDatabaseService` under
`CAPABILITIES.DATABASE` (`'database'`).

Driver errors that pass through `IDatabaseService` (repositories, transactions, `query()`) are
scrubbed before they are classified or logged. Drizzle's `Failed query:` wrapper keeps its SQL with
placeholders and loses its bound values, from the message, the whole multiline stack header and
`params`. A SQLSTATE class 22 cause (data exception: invalid text, out of range, bad date, bad enum)
is rebuilt from its code, because PostgreSQL's message quotes the rejected input. Classification is
unchanged. Two limits: an error from a query built through `getDrizzleDatabase(...)`, or a raw
driver call, never passes through the service and is logged as the driver wrote it; and the scrub
walks at most five causes, so a value nested deeper survives. It is not a general log-redaction
policy, and request paths logged by the request logger are outside it.

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
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const app = createApplication({
  plugins: [RuntimePlugin(), DatabasePlugin({ type: 'prisma', options: { prismaClient } })],
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

## The repository surface

### Portable data guarantees (M119e, 0.11.0)

| Operation / condition                                                              | Guarantee                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown payload field on Drizzle, Prisma or D1 `create` / `update` / `updateWhere` | `UnknownPayloadFieldError` (400); no field or value in the HTTP detail                                                                                          |
| Unknown payload field on Memory, MongoDB, DynamoDB, Cosmos DB or Bigtable          | Stored and returned; restrict fields with the route's body schema                                                                                               |
| PostgreSQL refused field value through Drizzle repositories                        | `InvalidFieldValueError` (400), including malformed UUID keys; fixed detail, scrubbed cause                                                                     |
| Prisma validation other than unknown arguments, or known-request `P2007`           | `InvalidFieldValueError` (400), including malformed UUID keys and conditional writes                                                                            |
| D1 STRICT-table field type refusal                                                 | `InvalidFieldValueError` (400)                                                                                                                                  |
| Tenant column on Drizzle                                                           | Resolve the property first, otherwise a unique SQL column name; unresolved or ambiguous mappings throw `TenantColumnUnresolvedError` (500) before statement I/O |
| Explicit Drizzle `entities.<Entity>.primaryKey` missing from a registered table    | `MissingKeyColumnError` at connect; an id-less query-only table without an override remains valid until repository creation                                     |
| Scoped keyset cursors (all eight adapters)                                         | Bound to entity, key columns and sort; a fingerprint is a correctness check, and tenant predicates still authorize access                                       |

`UnknownPayloadFieldError` is defined in `@setu-ts/common` and re-exported by this package as the
same class. Prisma conditional-write validation uses the same 400 split as ordinary writes,
replacing its previous 501. Prisma refusal causes are new errors with the original name and a fixed
message naming only the name and code; the original query and payload are discarded.

### Drizzle pool setup

The application owns the pool and should report its idle-client errors:

```typescript
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describeError } from '@setu-ts/common';
import { createDrizzleDatabase, DatabasePlugin } from '@setu-ts/database-plugin';

const pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
pool.on('error', (error: Error) => logger.warn('Database pool error', { error: describeError(error) }));
const database = drizzle(pool);
const plugin = DatabasePlugin({
  type: 'drizzle',
  options: {
    drizzleInstance: createDrizzleDatabase(database, (db, work) => db.transaction(work)),
    drizzleTables: { User: users },
  },
});
```

When the pool has no `'error'` listener, the framework attaches one after connect, reporting through
the optional logger's `warn`. Without a logger it still attaches the listener. Existing app
listeners are preserved. The listener remains for the pool's lifetime; the app closes its pool.

`IDatabaseService.getRepository<Entity, Id>(name)` returns `IRepository<Entity, Id>`. This table
describes the port and `BaseRepository`; see the backend restrictions below rather than assuming
every backend supports every query.

| Method                                                                  | Promise result / missing record / refusal                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `findById(id: Id)`                                                      | `Entity \| null`                                                                 |
| `findAll(options?: FindOptions)`                                        | `Entity[]`; no matches gives `[]`                                                |
| `findOne(options?: FindOptions)`                                        | `Entity \| null`; applies a limit of one                                         |
| `create(data: Partial<Entity>)`                                         | Persisted `Entity`, including generated fields                                   |
| `update(id: Id, data: Partial<Entity>)`                                 | Updated `Entity`; missing record rejects                                         |
| `delete(id: Id)`                                                        | `boolean`; `false` when missing                                                  |
| `updateWhere?(id: Id, where: WritePrecondition, data: Partial<Entity>)` | `Entity \| null`; `null` when missing or predicate mismatches                    |
| `deleteWhere?(id: Id, where: WritePrecondition)`                        | `boolean`; `false` when missing or predicate mismatches                          |
| `exists(id: Id)`                                                        | `boolean`; `false` when missing                                                  |
| `count(options?: CountOptions)`                                         | `number`; zero when no matches                                                   |
| `findPage(options: PageOptions)`                                        | `Page<Entity>`; `UnsupportedQueryFeatureError` if the source lacks cursor paging |

The interface's `@since` annotations record introduction history:

<!-- version:history -->

| First release | Methods                                                                |
| ------------- | ---------------------------------------------------------------------- |
| 0.1.0         | `findById`, `findAll`, `create`, `update`, `delete`, `exists`, `count` |
| 0.2.0         | `findOne`, `findPage`                                                  |
| 0.9.0         | `updateWhere`, `deleteWhere`                                           |

Conditional methods are optional on the port. `BaseRepository` exposes them but rejects with
`UnsupportedQueryFeatureError` before I/O if the data source lacks them or the precondition/update
is invalid. `WritePrecondition` is `Readonly<Record<string, string | number>>`: a non-empty equality
map conjoined with the primary key. See the backend limits for
[Cosmos](#what-this-adapter-deliberately-cannot-do) and
[Bigtable](#what-this-adapter-deliberately-cannot-do-1). Precondition field names must be non-empty
and may not start with `$`, contain a dot, or equal `__proto__`; values must be strings or finite
numbers.

`FindOptions` fields:

| Field     | Type                             | Meaning                                    |
| --------- | -------------------------------- | ------------------------------------------ |
| `where`   | `Record<string, unknown>`        | Equality conditions                        |
| `filter`  | `FilterExpression`               | Portable expression conjoined with `where` |
| `orderBy` | `Record<string, OrderDirection>` | Field directions (`'asc'` / `'desc'`)      |
| `limit`   | `number`                         | Maximum results                            |
| `offset`  | `number`                         | Results to skip                            |
| `select`  | `readonly string[]`              | Projected fields                           |
| `cursor`  | `string`                         | Continuation position for `findPage`       |

`PageOptions` is an alias of `FindOptions`. `findPage` refuses a cursor with a non-zero offset with
`PageNormalizationError`; `findAll` is the offset/limit path and does not consume a cursor. See the
[Cosmos](#what-this-adapter-deliberately-cannot-do) and
[Bigtable](#what-this-adapter-deliberately-cannot-do-1) backend tables for query refusals.

| Other shape    | Fields                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| `CountOptions` | Optional `where: Record<string, unknown>` and `filter: FilterExpression` |
| `Page<Entity>` | `rows: Entity[]`, `nextCursor: string \| null` (`null` ends traversal)   |

Use the same query on each page:

```typescript
import type { IRepository } from '@setu-ts/database-plugin';

interface Invoice { id: string; status: string; }
export async function readInvoices(invoices: IRepository<Invoice>): Promise<Invoice[]> {
  const rows: Invoice[] = [];
  let cursor: string | null = null;
  do {
    const page = await invoices.findPage({
      limit: 100,
      orderBy: { id: 'asc' },
      ...(cursor === null ? {} : { cursor }),
    });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}
```

Check for the optional conditional method, then distinguish a mismatch from a successful write:

```typescript
import type { IRepository } from '@setu-ts/database-plugin';

interface Invoice { id: string; status: string; }
export async function payInvoice(invoices: IRepository<Invoice>, id: string): Promise<boolean> {
  if (!invoices.updateWhere) throw new Error('Conditional writes are required');
  const updated = await invoices.updateWhere(id, { status: 'pending' }, { status: 'paid' });
  return updated !== null;
}
```

## Transaction isolation

Pass an isolation level when a read-modify-write needs an explicit concurrency guarantee:

```typescript
await db.transaction(
  async (uow) => {
    // Read and update through transaction-scoped repositories.
  },
  { isolation: 'serializable' },
);
```

Omitting the option preserves each adapter's current default. A requested level is never silently
downgraded: this package's adapters throw `UnsupportedIsolationLevelError`; D1 throws its own
`CloudflareUnsupportedError` because plugins must not depend on one another.

| Adapter                           | Supported isolation                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Prisma                            | PostgreSQL, MySQL, and SQL Server: all four; CockroachDB and SQLite: `serializable`; MongoDB: none |
| Drizzle                           | All four, when its bridge is explicitly wrapped with `withIsolationSupport()`                      |
| Memory                            | `serializable`, process-local only                                                                 |
| MongoDB                           | None                                                                                               |
| D1, DynamoDB, Cosmos DB, Bigtable | None; their transactional primitives are not levelled                                              |

A custom `IDatabaseAdapter` must declare `transactionIsolationLevels` before callers can request
isolation through the database service; an omitted declaration is refused rather than silently using
the adapter default. Prisma needs a resolved `provider` for an isolation request: when its client
provider cannot be detected, set `options.provider` explicitly.

## Optimistic locking

`updateVersioned` and `deleteVersioned` write only while the record still carries the version you
read, and tell a lost race (`409`) from a missing record (`404`) for you:

```typescript
import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import { updateVersioned, type IDatabaseService } from '@setu-ts/database-plugin';

interface Article {
  id: string;
  title: string;
  version: number;
}

export async function editArticle(
  ctx: IRequestContext,
  db: IDatabaseService,
): Promise<HandlerResult> {
  const body = (await ctx.request.json()) as { title: string; version: number };
  const repo = db.getRepository<Article>('Article');
  // Writes { title, version: body.version + 1 } only while version === body.version.
  const article = await updateVersioned(repo, ctx.params['id']!, body.version, {
    title: body.title,
  });
  return ctx.response.json(article);
}
```

- A stale version throws `VersionConflictError` (`409 Conflict`, "The record was changed after it
  was read. Reload it and try again."); a missing record throws `EntityNotFoundError`
  (`404 Not Found`). With `errorHandler` registered both are served as Problem Details, with no id
  or version in the body's `detail`. Pass `{ entity: 'Article' }` to have the errors carry the
  entity for your logs.
- The helper owns the version field (default `version`, or `{ field: 'lockVersion' }`): `data` must
  not set it, the expected version must be a non-negative safe integer, and both are refused before
  any I/O. `create` does not stamp a first version — include `version: 1` yourself.
- It works with any repository that has `updateWhere` — an outer repository, `uow.getRepository()`
  and a tenant repository. Inside a transaction it applies on Drizzle, Prisma and MongoDB; the
  buffered transaction sources (memory, D1, DynamoDB, Cosmos, Bigtable) answer
  `UnsupportedQueryFeatureError('conditional-write')` (`501`) rather than a non-atomic write.
- On a miss the record is read once to choose the error, so a delete that lands in between is
  reported as not found.
- An invalid expected version (a missing `?version` read with `Number(...)` is `NaN`) or a payload
  that sets the version field answers `400 Bad Request`, as every refused conditional-write
  precondition does.

`getRepository(entity)` returns the same repository for every call with that entity name. Pass
entity names from your code, never from request input: on the memory and MongoDB adapters every new
name is kept for the service's lifetime.

## Tenant data-store bridge

`createDatabaseTenantDataStore` is the one shipped `ITenantDataStore` over `IDatabaseService`. Pass
it to the multi-tenancy plugin's `dataStore` option and tenant-scoped repositories read and write
through this backend:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createDatabaseTenantDataStore, DatabasePlugin } from '@setu-ts/database-plugin';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DatabasePlugin({ type: 'memory' }),
    MultiTenancyPlugin({
      resolver: 'header',
      database: 'column-per-tenant',
      dataStore: createDatabaseTenantDataStore(),
    }),
  ],
});
await app.start({ port: 3000 });
```

The factory is resolved in `onInit`, so `DatabasePlugin` may be registered before OR after the
tenancy plugin — every `register()` phase completes before any `onInit`.

The bridge supports the **`'column-per-tenant'`** strategy only: it conjoins the tenant column to
every read and stamps it on every write (the column is spread LAST, so a caller's filter cannot
override it, and stripped from every `update` payload, so no write can move a row between tenants).
`'schema-per-tenant'` and `'database-per-tenant'` throw `TenantStoreStrategyUnsupportedError` at
startup, because `IRepository` offers no schema or database switch. The tenant column comes from
that strategy — `'tenant_id'` by default, `database: new ColumnPerTenant('org_id')` for another — so
there is one place to name it. Lookups by key go through the repository's own `findById`, so an
entity whose primary key is not `id` (a MongoDB `primaryKey: 'user_id'`, a composite key) is
addressed the way its adapter is configured; the tenant column is then checked on the row that comes
back. `update` and `delete` guard the tenant column in the write itself through `updateWhere` /
`deleteWhere`, which every built-in non-transactional data source offers. A custom data source
without them falls back to an ownership read followed by a key-addressed write: if the row is
deleted and a row from another tenant is created under the same caller-supplied key in between, the
write lands on that row (a `delete` still reports `true`; an `update` refuses to return the foreign
row, but has already written it). Generated keys never reuse a key, so let the backend generate
them, or implement the two members.

The bridge also implements the optional `updateWhere` / `deleteWhere` of `ITenantDataStore` (M128),
so a tenant repository supports conditional writes and `updateVersioned`. Your `where` and the
tenant column become one precondition; a `where` naming the tenant column is refused; and there is
no ownership-read fallback — a data source without conditional writes answers `conditional-write`
instead. `DatabaseTenantDataStore` is also exported for an application that holds its own
`IDatabaseService` and constructs the store directly; its optional second constructor argument names
the column for a store used outside the multi-tenancy plugin.

## Transactional outbox store

`createDatabaseOutboxStore` is the shipped `IOutboxStore` (the port in `@setu-ts/common`) over
`IDatabaseService`. Pass it to the messaging plugin's `outbox.store` option: the outbox writes each
integration event as a row in the SAME transaction as the business change, through your own unit of
work, and a relay publishes the rows afterwards.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { createDatabaseOutboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    // The relay is a scheduled job: without a scheduler (or `relay: { schedule:
    // false }` and your own trigger) `start()` rejects OutboxRelayUnscheduledError.
    SchedulerPlugin(),
    DatabasePlugin({ type: 'memory' }),
    MessagingPlugin({ outbox: { store: createDatabaseOutboxStore() } }),
  ],
});
await app.start();
```

The write, the relay, its promise and the per-backend provisioning are documented in the
[messaging-plugin README](https://github.com/setu-ts/setu-ts/tree/main/packages/messaging-plugin#transactional-outbox).

The factory resolves `CAPABILITIES.DATABASE` in `onInit`, so the two plugins may be registered in
either order. Options: `entity` (default `'Outbox'`) and `database`, which selects a named
connection (`DatabasePlugin({ name })` → `database.<name>`). That connection must be the database
your unit of work belongs to: a row written through another database's unit of work is never relayed
by this store.

**The discriminator.** Every row carries `kind: 'setu-outbox'`; every read requires it, and a lookup
by id treats a row of another `kind` as missing. An outbox sharing an entity with business data (a
Cosmos container is queried as a whole) never reads, counts, transitions or deletes a business
document that happens to carry `status: 'pending'` or `'sent'`.

**Transitions are conditional.** `claim` compares `kind`, `pending` and the read `claimVersion`,
increments the version once and writes the lease. `markSent` and `markFailure` require the held
version; `deleteNow` uses the same predicate through `deleteWhere`. A version miss on a pending row
answers `claim-lost` and writes nothing. `markFailure` clears the lease; `markInvalid` requires only
`kind` and `pending`, writes `failed`/`invalid-row`, clears the lease and preserves attempts.
`release('retry')` requires `failed`, resets attempts, the lease and `lastError`, and keeps the
version — so a row poisoned for an exhausted `claimVersion` (`MAX_SAFE_INTEGER`, stored by a normal
claim of a row at `MAX_SAFE_INTEGER - 1`, which takes 2^53 − 1 claims of one row or an edit) is
poisoned again by the next sweep; `release('discard')` or editing the row are the only ways out. A
miss is re-read for classification; unexplained misses retry at most three rounds. Sources without
native conditional support are refused; there is no fallback. Absent optional columns are written as
`NULL` and read back as absent. `sentBy` is an operator diagnostic only.

**Startup check.** `verify()`, run by the outbox before it schedules the relay or accepts a write,
runs the relay's first query, a transactional read, and two conditional capability probes on the
fixed non-UUID id `setu-outbox-claim-probe` with `{ kind, status: 'pending', claimVersion: -1 }`: an
`updateWhere` writing `{ claimVersion: 0 }` and a `deleteWhere` (needed because `retainSentMs: 0`
deletes a sent row conditionally after publishing it). No row can carry version `-1`, so neither
probe writes, even to a row appended under the probe id. `verify()` rejects with
`OutboxStoreUnavailableError` (`reason`, `entity`, the adapter error as `cause`) when any step
fails:

| Backend               | Verdict                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory                | supported (single process)                                                                                                                           |
| Prisma                | supported; the table must exist                                                                                                                      |
| Drizzle               | supported; `drizzleTables` must register the outbox table                                                                                            |
| D1                    | supported; the table must exist                                                                                                                      |
| MongoDB               | supported on a replica set; a standalone server is refused (`reason: 'mongodb-replica-set'`)                                                         |
| DynamoDB              | supported with a GSI `{ partitionKey: 'status', sortKey: 'position' }`, projection `ALL`; refused without it (`'dynamodb-index'`)                    |
| Cosmos                | supported when the outbox entity maps to the business container and its partition-key path is a column the row carries (`tenantId` or `orderingKey`) |
| No conditional writes | refused (`'conditional-writes-unsupported'`): `updateWhere` or `deleteWhere` is absent, or either rejects `conditional-write`                        |
| Bigtable              | refused (`'bigtable'`): no secondary index, so the relay query cannot run — use a change-data-capture relay                                          |

Any other refusal — a missing or unreadable table — is `reason: 'entity-unavailable'`. On the memory
adapter and MongoDB a missing entity cannot be detected (both create lazily), so that check passes
there by construction. No portable migration exists (`migrate()` always rejects): create the table
yourself. The old M107 SQL schema lacks the claim fields and is refused at startup as
`entity-unavailable`. A claim reads a version in `[0, Number.MAX_SAFE_INTEGER - 1]` and stores one
more, so the stored value reaches `Number.MAX_SAFE_INTEGER`, which is exhausted; PostgreSQL uses
`bigint`, SQLite/D1 use 64-bit `INTEGER`, and JSON backends store the number. For PostgreSQL:

```sql
CREATE TABLE setu_outbox (
  id            text    PRIMARY KEY,
  kind          text    NOT NULL,
  topic         text    NOT NULL,
  envelope      text    NOT NULL,
  options       text    NOT NULL,
  ordering_key  text,
  tenant_id     text,
  traceparent   text,
  position      text    NOT NULL,
  created_at    bigint  NOT NULL,
  status        text    NOT NULL,
  attempts      integer NOT NULL,
  available_at  bigint  NOT NULL,
  claim_version bigint  NOT NULL,
  lease_until   bigint  NOT NULL,
  last_error    text,
  settled_at    bigint,
  sent_by       text
);
CREATE INDEX setu_outbox_relay ON setu_outbox (kind, status, position);
CREATE INDEX setu_outbox_purge ON setu_outbox (kind, status, settled_at);
```

Map it with `drizzleTables: { Outbox: pgTable('setu_outbox', { … }) }` (JS keys `orderingKey`,
`tenantId`, `createdAt`, `availableAt`, `claimVersion`, `leaseUntil`, `lastError`, `settledAt`,
`sentBy` over the snake_case columns; `claim_version` and `lease_until` must be 64-bit; the `bigint`
columns in `{ mode: 'number' }`).

## Consumer inbox store

`createDatabaseInboxStore` is the shipped `IInboxStore` (the port in `@setu-ts/common`) over
`IDatabaseService`. Pass it to the messaging plugin's `inbox.store` option: an
`onIntegrationEvent(..., { inbox: { consumer } })` subscription then records each event it applied
as a marker in the SAME transaction as the handler's writes, and hands the handler that
transaction's unit of work.

The delivery path, its promise, the failure and parking policy and the per-backend notes are
documented in the
[messaging-plugin README](https://github.com/setu-ts/setu-ts/tree/main/packages/messaging-plugin#consumer-inbox).

The factory resolves `CAPABILITIES.DATABASE` (or `database.<name>` with `database`) in `onInit`.
Options: `entity` (default `'Inbox'`) and `database`. The handlers must write to that database: the
marker is created in its transaction, so a handler writing elsewhere gets no once-only guarantee.

**The marker's insert is the authority.** `run` opens one transaction, creates the marker in it
first, then runs the handler; any rejection rolls both back. Every row carries `kind: 'setu-inbox'`
and every read requires it. The failure count compares `kind` and the read `attempts` value in the
write, retrying at most five rounds; `release` requires `kind` and `status: 'parked'`. Without
conditional support, or for a non-safe-integer stored count, the two-call fallback can lose an
increment under concurrent failures.

**Startup check.** `verify()` refuses Cosmos DB and Bigtable by adapter arm or class
(`'cosmos-unsupported'`, `'bigtable-unsupported'`), runs retention's first query, and runs a
transaction that writes two probe rows and always rolls back — which is what refuses a standalone
MongoDB (`'mongodb-standalone'`) and an adapter bounded to one row per transaction
(`'transaction-scope'`). Anything else is `'entity-unavailable'`. Nothing the probe writes survives.
Create the table yourself; for PostgreSQL:

```sql
CREATE TABLE setu_inbox (
  id          text    PRIMARY KEY,
  kind        text    NOT NULL,
  consumer    text    NOT NULL,
  topic       text    NOT NULL,
  envelope_id text,
  status      text    NOT NULL,
  attempts    integer NOT NULL,
  updated_at  bigint  NOT NULL,
  last_error  text,
  envelope    text
);
CREATE INDEX setu_inbox_status ON setu_inbox (kind, status, updated_at);
```

Map it with `drizzleTables: { Inbox: pgTable('setu_inbox', { … }) }` (JS keys `envelopeId`,
`updatedAt`, `lastError` over the snake_case columns; `updated_at` in `{ mode: 'number' }`).

### Tier-C idempotency store

`createDatabaseIdempotencyStore()` uses the default entity name `Idempotency`. Create the PostgreSQL
table before using the store:

```sql
CREATE TABLE setu_idempotency (
  id          text   PRIMARY KEY,
  kind        text   NOT NULL,
  role        text   NOT NULL,
  fingerprint text   NOT NULL,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  result      text
);
CREATE INDEX setu_idempotency_expiry ON setu_idempotency (kind, role, expires_at);
```

For SQLite (including D1), use:

```sql
CREATE TABLE setu_idempotency (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,
  role        TEXT    NOT NULL,
  fingerprint TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  result      TEXT
);
CREATE INDEX setu_idempotency_expiry ON setu_idempotency (kind, role, expiresAt);
```

The expiry index serves the purge query over `kind`, `role`, and expiry time. For Drizzle on
PostgreSQL, register the table under the default entity name:

```typescript
import { bigint, pgTable, text } from 'drizzle-orm/pg-core';

const tables = {
  drizzleTables: {
    Idempotency: pgTable('setu_idempotency', {
      id: text('id').primaryKey(),
      kind: text('kind').notNull(),
      role: text('role').notNull(),
      fingerprint: text('fingerprint').notNull(),
      createdAt: bigint('created_at', { mode: 'number' }).notNull(),
      expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
      result: text('result'),
    }),
  },
};
```

Pass `tables.drizzleTables` as the database plugin's `drizzleTables` option. The JavaScript keys
`createdAt` and `expiresAt` map to `created_at` and `expires_at`; `{ mode: 'number' }` keeps epoch
milliseconds numeric for the store.

## Scoped RBAC sources

`createDatabaseGrantSource({ entity })` and `createDatabaseRoleSource({ entity })` feed AuthPlugin's
`scopedRbac` option from the application's own database — one row per grant, and one row per (scope,
role, permission) for roles a tenant defines at runtime. Both return factories AuthPlugin resolves
at `onInit`, read the default database through the repository surface with portable filters (so
every adapter works), and refuse a non-identifier column name when called.

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { createDatabaseGrantSource, createDatabaseRoleSource } from '@setu-ts/database-plugin';

export const auth = AuthPlugin({
  rbac: { roles: { approver: { permissions: ['invoices:approve'] } } },
  scopedRbac: {
    // Columns default to subject / role / scopeType / scopeId; both scope
    // columns null is a global grant.
    sources: [{ kind: 'custom', source: createDatabaseGrantSource({ entity: 'role_grants' }) }],
    // Columns default to scopeType / scopeId / role / permission.
    customRoles: createDatabaseRoleSource({ entity: 'tenant_roles' }),
  },
});
```

A check's question is one query: the subject's rows that are global or in one of the asked scopes.
More than `limit` matching rows (default 10 001 for grants, 100 000 for role rows) refuse the
question, so the check denies, rather than answering with an arbitrary subset.

## Migrations and readiness

Opt in on any connection with `DatabasePlugin({ readiness: { migrations: MIGRATION_NAMES } })`,
importing `MIGRATION_NAMES` from your generated `./src/migrations/index.ts`. Without `readiness`,
the indicator's status and data are unchanged. After the existing reachability checks, a separate
ledger probe caches reads for 5 seconds and bounds each read at 2 seconds:

| Ledger                                        | Indicator                               | Migration data                         |
| --------------------------------------------- | --------------------------------------- | -------------------------------------- |
| Expected names missing                        | `degraded`: `/ready` 503, `/health` 200 | `{ state: 'pending', pending: count }` |
| All expected names present                    | Existing `up` or `degraded` status      | `{ state: 'current', applied: count }` |
| Read rejected, timed out, or over 10,000 rows | `down`                                  | `{ state: 'unreadable' }`              |

Additional names from a newer build add `unknown: count` to current data and preserve status, so old
replicas stay ready during rolling deploys. Names never appear in health data. **Since M119b
(V10-31)** the ledger is read only when the connection result is not `down` and its `data.reachable`
is not `false` or `'unknown'`; otherwise the result is returned unchanged with
`data.migrations.state: 'unknown'` added — an adapter with no reachability check (`reachable`
omitted) is still checked. A paused database therefore reads `degraded` within one ~2 s bound
instead of `down` after two stacked bounds. Expected names must be unique non-empty strings, at most
10,000; `ledgerEntity`, when supplied, must be non-empty. Invalid options throw `TypeError` at
construction without echoing values. This checks migration history, not every application table: an
intact ledger cannot prove that someone has not independently dropped a business table.

`createMigrationLedger(database, { entity? })` returns `IMigrationLedger`: `applied()` reads names,
`record(name, appliedAt)` inserts caller-supplied ISO-8601 time, and `remove(name)` resolves even if
absent. `DatabaseReadinessOptions.ledgerEntity` defaults to `MIGRATION_LEDGER_ENTITY`
(`'setu_migrations'`). A ledger created without `MigrationLedgerOptions.entity` — which is how the
generated `run.ts` creates it — uses the `ledgerEntity` its connection was registered with, so
setting it once on `DatabasePlugin` is enough; an explicit `entity` overrides it. `applied()`
requests only `id`, with a limit of 10,001, and rejects above 10,000 rows with
`MigrationLedgerError`, whose `reason` is `'oversized'`. The framework reads no clock for ledger
writes and never creates schema.

Create this PostgreSQL table (also shipped in `test/fixtures/migration-ledger-postgres.sql`):

```sql
CREATE TABLE setu_migrations (
  id text PRIMARY KEY,
  applied_at text NOT NULL
);
```

SQLite / D1 (`test/fixtures/migration-ledger-sqlite.sql`):

```sql
CREATE TABLE setu_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  appliedAt TEXT NOT NULL
);
```

| Adapter  | Application setup                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma   | Create the SQL table and expose a `setu_migrations` model with `id` and `appliedAt` mapped to `applied_at`.                                          |
| Drizzle  | Create the SQL table and add `setu_migrations` to `drizzleTables`, with `id: text('id').primaryKey()` and `appliedAt: text('applied_at').notNull()`. |
| D1       | Create the SQLite table above, whose `appliedAt` column matches the repository field directly.                                                       |
| MongoDB  | No DDL; the default entity collection is sufficient, or map it through `collections`.                                                                |
| DynamoDB | Provision a table with partition key `id`; map `entities.setu_migrations` to `{ table: 'your-table', partitionKey: 'id' }`.                          |
| Cosmos   | Provision a container with partition path `/id`; map `containers.setu_migrations` to `{ container: 'your-container', partitionKey: 'id' }`.          |
| Bigtable | Provision a table and map `tables.setu_migrations` with its row-key and column-family configuration, as for other entities.                          |
| Memory   | No DDL. History is process-local; run migrations in the serving process. A separate runner process loses its history at exit.                        |

Measured locally through `createMigrationLedger` and repository read-back (2026-10-19):

| Adapter                   | Duplicate `record` rejection | Preserved driver cause                                                   |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Memory                    | `DuplicateKeyError`          | None                                                                     |
| Drizzle / real PostgreSQL | `DuplicateKeyError`          | Drizzle `Error` → pg `DatabaseError` (`name: 'error'`, SQLSTATE `23505`) |
| MongoDB replica set       | `DuplicateKeyError`          | `MongoServerError`, code `11000`                                         |
| DynamoDB Local            | `DuplicateKeyError`          | `ConditionalCheckFailedException`                                        |

Other adapters were not measured for duplicate rejection. The ledger propagates the adapter's create
rejection unchanged. **Run one migration job**: no portable lock prevents two jobs from applying a
change concurrently. A duplicate ledger insert makes the race visible after execution. **The ledger
is only as trustworthy as whoever can write it**: a database principal able to write
`setu_migrations` can mark a replica ready, or make the runner skip or re-run a migration — the same
trust it already holds over the schema.

`setu generate migration` maintains `run.ts` and `index.ts` and exports `MIGRATION_NAMES` from the
barrel. Migrations receive `{ database }`. The runner applies only pending names oldest first;
`--down` reverses only applied names newest first. It writes/removes the row after each successful
change, outside any transaction. A crash between a change and its ledger write re-runs that change:
make migrations idempotent. A failure stops the run and names the migration.

On socket targets, executing `run.ts` dynamically loads `setu.config.ts`, awaits `createApp()`,
starts the whole app without a port, resolves the default database and stops the app in `finally`.
Every plugin's start-up effects therefore run for the runner's lifetime — queue processors,
scheduled jobs and broker subscriptions included. On Deno, run it with the same permission flags as
your `start` task rather than `-A`. Importing `runMigrations` does not load the application. For a
named connection, call `runMigrations('up', { database, ledger: createMigrationLedger(database) })`
from your own module. Workers emit no entry block: call the function from code holding platform
bindings or use `wrangler d1 migrations`.

## Options

| Option      | Type                                                                                                 | Default     | Description                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `type`      | `'memory' \| 'prisma' \| 'drizzle' \| 'mongodb' \| 'dynamodb' \| 'cosmos' \| 'bigtable' \| 'custom'` | `'memory'`  | Backend adapter.                                                                                              |
| `name`      | `string`                                                                                             | `'default'` | Named connection for multi-database use.                                                                      |
| `options`   | per-arm (see `type`)                                                                                 | —           | Adapter-specific configuration.                                                                               |
| `readiness` | `DatabaseReadinessOptions`                                                                           | —           | Opt-in expected migration names and ledger entity; see [Migrations and readiness](#migrations-and-readiness). |

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
   `P1012: The datasource property 'url' is no longer supported in schema files`; the connection
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
const drizzleDatabase = createDrizzleDatabase(db, (database, work) => database.transaction(work));

DatabasePlugin({
  type: 'drizzle',
  options: {
    drizzleInstance: drizzleDatabase,
    drizzleTables: { User: users },
  },
});
```

A Drizzle table whose key column is not a column of the table is refused when the repository is
created — `getRepository` (and the Unit of Work's data source) — naming the table and the missing
column, instead of surfacing lazily inside `findById`, `update` or `delete`. A `create`, `update` or
`updateWhere` payload that names a field that is not a column of the table is likewise refused by
name before any I/O, instead of being dropped by Drizzle and surfacing as the driver's raw
`Failed query`. That refusal is `UnknownPayloadFieldError`, answered `400 Bad Request` with the
fixed detail `The request names a field this resource does not have.` — a body passed straight to
`repo.update(id, body)` carries the client's fields, so an extra one is the caller's error. The
message names the entity and the field for the log; the served detail names neither.

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
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import {
  createDrizzleDatabase,
  getDrizzleDatabase,
  getDrizzleTransaction,
} from '@setu-ts/database-plugin';

const users = pgTable('users', { id: text('id'), teamId: integer('team_id') });
const teams = pgTable('teams', { id: integer('id'), name: text('name') });

const drizzleDatabase = createDrizzleDatabase(drizzleDb, (database, work) =>
  database.transaction(work),
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
[`mongodb`](https://www.npmjs.com/package/mongodb) driver (`mongodb`). It implements all six
`IDataSource` methods and translates all six `NormalizedQuery` members natively — `where` and
`filter` become a match document, `orderBy`/`offset`/`limit`/`select` become
`sort`/`skip`/`limit`/`projection`. Nothing is filtered, sorted or paginated in JavaScript.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(
  DatabasePlugin({
    type: 'mongodb',
    options: {
      url: 'mongodb://127.0.0.1:27017/app',
      collections: { User: { collection: 'users', primaryKey: 'user_id' } },
    },
  }),
);
```

| `options` field | Type                                 | Default            | Read by                                                                                                             |
| --------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `url`           | `string`                             | —                  | The lazy client path. Required unless `client` is supplied; also supplies `database` when that option is absent.    |
| `client`        | `IMongoClient`                       | —                  | `connect()`. An already-constructed client; when present the lazy `import('mongodb')` never runs.                   |
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

**Transactions** use a driver session. They require a replica set, and the refusal is late — never
at `connect()` — so a standalone `mongod` remains a valid deployment for an application that never
opens one. On the real driver it surfaces at the first operation inside the transaction, not at
`beginTransaction()`: `startTransaction()` resolves, and that operation rejects with the driver's
own `MongoServerError` (`code: 20`, `codeName: 'IllegalOperation'`), unwrapped (measured, M107).
`MongoTransactionUnavailableError` wraps only a `startTransaction()` that itself throws, which the
real driver does not.

## The Azure Cosmos DB backend

`type: 'cosmos'` serves the `database` capability from Azure Cosmos DB's **NoSQL (SQL) API**, over
[`@azure/cosmos`](https://www.npmjs.com/package/@azure/cosmos) (`@azure/cosmos`). Every
`NormalizedQuery` member is translated natively — `where`/`filter` become a bound SQL predicate,
`orderBy` an `ORDER BY`, `offset`/`limit` an `OFFSET … LIMIT`, and `select` a projection list.
Nothing is filtered, sorted or paginated in JavaScript.

Cosmos DB's **MongoDB API** is a different wire protocol and is served by the `'mongodb'` arm
pointed at a Cosmos connection string, not by this one. That route is documented rather than tested,
and the reason is a **version floor rather than a dead image**: the emulator's MongoDB endpoint
(`AZURE_COSMOS_EMULATOR_ENABLE_MONGODB_ENDPOINT`) tops out at API version **4.0**, which reports
wire version 7, while the `mongodb` driver this package pins requires wire version 8 (MongoDB 4.2).
Measured: the endpoint completes a handshake and then refuses with
`reports maximum wire version 7, but this version of the Node.js Driver requires at least 8`. A live
Azure Cosmos for MongoDB account offers server versions above that floor, so the route is
**unverified against a live account** rather than known to fail.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(
  DatabasePlugin({
    type: 'cosmos',
    options: {
      endpoint: 'https://my-account.documents.azure.com:443/',
      key: cosmosKey,
      database: 'app',
      containers: { Order: { container: 'orders', partitionKey: 'tenantId' } },
    },
  }),
);
```

| `options` field | Type                                  | Default | Read by                                                                                                                          |
| --------------- | ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`      | `string`                              | —       | The lazy client path. Required unless `client` is supplied.                                                                      |
| `key`           | `string`                              | —       | The lazy client path. Required unless `client` is supplied.                                                                      |
| `client`        | `ICosmosClient`                       | —       | `connect()`. When present the lazy `import('@azure/cosmos')` never runs — the route for an Entra ID (managed identity) client.   |
| `database`      | `string`                              | —       | **Required on both arms.** A Cosmos endpoint encodes no database name, so unlike a MongoDB URI there is nothing to fall back to. |
| `containers`    | `Record<string, CosmosEntityMapping>` | `{}`    | Per-entity `{ container?, primaryKey?, partitionKey? }`. An unmapped entity uses its own name and `'id'`.                        |
| `logQueries`    | `boolean`                             | `false` | The database service, exactly as for every other arm.                                                                            |

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
(`@google-cloud/bigtable`).

**Bigtable inverts the DynamoDB problem.** Its row key is a single lexicographically-sorted string,
so `findById` fits it natively with no key object at all. What it lacks instead is everything
_around_ the key: there is **no secondary index of any kind**, so a predicate on a non-key column is
a scan, and `orderBy` is row-key order or nothing.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(
  DatabasePlugin({
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
  }),
);
```

| `options` field  | Type                                    | Default | Read by                                                                                                                             |
| ---------------- | --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`      | `string`                                | —       | The lazy client path. Required unless `client` is supplied.                                                                         |
| `instance`       | `string`                                | —       | **Required on both arms.** A table is addressed as `project/instance/table`, and neither a client nor a project encodes it.         |
| `apiEndpoint`    | `string`                                | —       | The lazy client path. The emulator address; an endpoint alone reaches `cbtemulator` with no credentials.                            |
| `client`         | `IBigtableClient`                       | —       | `connect()`. When present the lazy `import('@google-cloud/bigtable')` never runs.                                                   |
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

| Behaviour                           | Memory                                        | Prisma / Drizzle                         |
| ----------------------------------- | --------------------------------------------- | ---------------------------------------- |
| Unknown `select` / `orderBy` column | **Refused by name**                           | Refused by name                          |
| Unknown `where` / `filter` field    | Matches nothing                               | Refused                                  |
| Duplicate primary key               | **Refused** (a caller-supplied key)           | Refused                                  |
| Changing a primary key by `update`  | **Refused** (`PrimaryKeyChangeError`, `400`)  | Refused (`PrimaryKeyChangeError`, `400`) |
| Unique constraint                   | Not enforced — a duplicate value is accepted  | Enforced                                 |
| Column types                        | Not enforced — a string into an Int is stored | Enforced                                 |
| Foreign keys, checks, defaults      | Not enforced                                  | Enforced                                 |

This refusal is now portable. On **every** adapter — Memory, Drizzle, Prisma, MongoDB, DynamoDB,
Cosmos DB, Cloud Bigtable and the D1 adapter in `@setu-ts/cloudflare-plugin` — an `update` or
`updateWhere` payload that carries a key column whose value is not `undefined` and differs from the
addressed key's value is refused with `PrimaryKeyChangeError` (`400`), before any I/O. An equal
value is accepted; it is compared as a string for `string`, `number`, `bigint` and `ObjectId`-like
values, and by time for `Date` values. That is why `update('5', { id: 5 })` is accepted — a route
parameter is a string, a JSON body carries a number — while `'05'` against `5` is refused. The check
covers scalar key columns. Through Prisma, a body passed straight to `update` can still change a key
column that is also a relation's foreign key with a nested relation write such as
`{ tenant: { connect: … } }`; this case has not been tested against a generated client, so write the
fields you mean rather than forwarding a body.

The first two rows are things this adapter can decide, and it does. The primary key is the one
constraint it knows, and every lookup by id addresses the first match, so a `create` whose
caller-supplied key is already stored is refused instead of leaving a second, unaddressable row. For
`select`/`orderBy`: a `select` or `orderBy` field that **no stored row carries** is refused with the
entity, the clause and the observed column list, matching what Drizzle answers for the same call.
Two consequences of measuring rather than declaring are worth knowing: a field carried by at least
one row counts as known (so a sparse optional column works), and an entity holding no rows at all
accepts anything, because there is nothing to observe and nothing to return.

`where` and `filter` are deliberately **not** checked. Without a schema this adapter cannot tell an
unknown column from one that is absent on every row, and returning no rows is a defensible answer to
the second — whereas ordering by a column no row has returns rows in an arbitrary order and
projecting one silently changes the response shape.

Uniqueness and types are outside what any schema-less store can do. **Use the Memory adapter for
development and tests, and run integration tests against the backend you deploy on.**

### Development: preserve caught causes

When an adapter replaces a caught error with a more actionable framework error, it forwards the
original value through native `ErrorOptions` (`new Error(message, { cause })`). The replacement
explains the failed framework operation; the cause preserves the driver diagnostic for logs. A catch
that intentionally drops a cause must carry a `drops-cause: <reason>` marker and be justified in its
test.

## What a driver condition returns to the client

Four driver conditions are classified (`classifyDriverError`, internal) at `DatabaseService` and
answered as typed errors, so a caller can `instanceof` them instead of matching message text:

| Condition                                                                                                                                                                                                                                                                                                                                                                  | Thrown as                    | Served status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------- |
| The backend rejected a write because a concurrent transaction changed the same data (SQLSTATE class `40`, Prisma `P2034`, Mongo `TransientTransactionError`, gRPC `ABORTED`, Cosmos `449`)                                                                                                                                                                                 | `SerializationConflictError` | `409`         |
| The database, its pool, or its network is temporarily unreachable (SQLSTATE class `08`, `57P03`, both node-postgres connect-timeout messages (`timeout exceeded when trying to connect`, `Connection terminated due to connection timeout`), `MongoNetworkError`/`MongoServerSelectionError`, gRPC `UNAVAILABLE`, Cosmos `429`/`503`, the net errno `ECONNREFUSED` family) | `DatabaseUnavailableError`   | `503`         |
| node-postgres's `query_timeout` fired on a query (the driver's `Query read timeout` rejection)                                                                                                                                                                                                                                                                             | `DatabaseTimeoutError`       | `504`         |
| The write would duplicate a primary key or a unique index (SQLSTATE `23505`, Prisma `P2002`, MySQL `ER_DUP_ENTRY`, MongoDB `11000`, Cosmos `409`, SQLite and D1 `UNIQUE constraint failed`)                                                                                                                                                                                | `DuplicateKeyError`          | `409`         |

`DuplicateKeyError` is exported from `@setu-ts/common`, not from this package, because more than one
package raises or recognises it (the D1 adapter in `@setu-ts/cloudflare-plugin`, and any store that
records "already processed" with a unique insert). Unlike a serialization conflict it is **not**
retryable: the same write fails the same way. The memory, DynamoDB and Bigtable adapters raise it
themselves, and it carries the targeted `entity` when the failing call names one. A duplicate found
at `commit()` (D1's batch, a Cosmos transactional batch, a DynamoDB `TransactWriteItems` cancelled
by a create's guard, a buffered memory or Bigtable create) is mapped too; every other commit
rejection is still rethrown unchanged, because its outcome can be unknown.

**Connection loss during an outage (M128).** The connection-loss signals measured during the
`0.11.0` outage runs are classified by one rule: if the server said the statement did not run, or
the driver refused before sending it, the answer is `DatabaseUnavailableError` (`503`); if the
connection dropped under a statement in flight, with no answer, it is `DatabaseTimeoutError`
(`504`), because a write's outcome is then unknown.

| Driver        | `503` (not applied)                                                                                                          | `504` (outcome unknown)                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| node-postgres | SQLSTATE `57P01`; `Client has encountered a connection error and is not queryable`; `Client was closed and is not queryable` | `Connection terminated unexpectedly`     |
| Prisma 7      | `P1001`, `P2028`; under `P2039`/`P2010`, the adapter's `originalCode` `57P01` (pg) or `45028`, `45013`, `1053` (mariadb)     | adapter `originalCode` `45009` (mariadb) |
| mysql2        | `ER_SERVER_SHUTDOWN`                                                                                                         | `PROTOCOL_CONNECTION_LOST`               |
| libsql        | `SQLITE_BUSY`                                                                                                                | —                                        |
| MongoDB       | `MongoWaitQueueTimeoutError`, `MongoPoolClearedError`, code `10107`                                                          | —                                        |

The older `ECONNRESET`/`EPIPE`/`MongoNetworkError` arms still answer `503` even for a write in
flight; that is a known limitation.

**A Drizzle transaction survives a lost connection (M128).** A pg client checked out for a
transaction has no `'error'` listener of its own, so a backend killed mid-transaction used to exit
the process. The plugin attaches one to every checked-out client of the pool behind your
`drizzleInstance` (through pg-pool's `'acquire'`/`'release'` events) and logs the event at `warn`;
the transaction's next statement answers `503`.

**Errors your own transaction work throws are not classified (M128).** Inside
`db.transaction(async (uow) => …)`, repository calls are classified as above; anything else the work
throws — an HTTP call refused with `ECONNREFUSED`, your own error — reaches you as itself, so a
refused webhook is no longer reported as "database unavailable".

All four carry the original driver error as `cause` — the SQLSTATE and the failing statement stay
reachable for the log (M90j) — and none serves driver text: the body's `detail` is a fixed sentence.
Unlike a `DatabaseUnavailableError`, a `DatabaseTimeoutError` does not say the operation did not
happen: the timed-out statement may have run, so a write's outcome is unknown and a retry of a write
must be idempotent. **No classified answer carries `Retry-After`**: the hint channel has no header,
and the framework holds no honest horizon for a pool's saturation. Catch-then-throw sites and the
typed Drizzle builder (`getDrizzleDatabase`) bypass the classifier — the operator work is M90j's
row.

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

A cursor the backend cannot use is not one of these. A `?cursor=` token that is malformed, that was
made under a different sort (a sort-fingerprint mismatch), or whose decoded key-value list is the
wrong shape for the target is refused with `InvalidCursorError` (from `@setu-ts/common`), answered
**`400 Bad Request`** with the fixed detail `The pagination cursor is not valid for this query.`,
before any backend call. The error's `message` names the entity and which check failed, and never
the token or its values. On Drizzle and Prisma, a cursor that decodes cleanly but carries a value of
the wrong type for its sort column — PostgreSQL refuses it with `22P02`, `22003`, `22007` or
`22008`, Prisma with its own validation error — is answered the same `400`; a page requested without
a cursor keeps the driver's error. `501` remains for a backend that cannot page the query at all.

**The error's `message` is never served.** It is the full diagnostic — it names entities, columns
and sort keys — and it reaches the log alone, where `errorHandler` records it unmasked along with
the cause chain. The served `detail` is composed from the framework's own identifiers, which is what
lets a refusal be readable without becoming a disclosure channel.

`migrate()` also answers `501`, through the separately named `UnsupportedMigrationError`.
Programmatic migration is unsupported by every current adapter and belongs to that adapter's CLI; it
is a framework capability boundary, not a raw query or query-shape refusal.

**Not every `UnsupportedQueryFeatureError` is branded, and that is deliberate.** The class is shared
by two kinds of refusal: a caller-caused query shape, and a **configuration** refusal. Only the
former is answered `501`; the latter keeps the masked `500` that is correct for an internal fault.
Branding the constructor unconditionally made a blank `columnFamily` — a value the developer wrote —
answer every request
`501 "Query feature 'mapping' is not supported by the 'bigtable' database adapter."`, which is a lie
twice over. The split is an allowlist of `feature` values (`attribute-value`, `composite-key`,
`cursor-pagination`, `key`, `nested-path`, `offset`, `order-by`/`orderBy`, `row-key`, `update`);
`mapping`, `endpoint`, `date-encoding` and `transaction` are excluded, and **an unclassified value
is not branded** — so a feature name added later keeps its masked `500` until someone decides
otherwise.

The transaction and concurrency errors (`MongoTransactionUnavailableError`,
`CosmosTransactionScopeError`, `CosmosConcurrentModificationError`, `BigtableTransactionScopeError`)
deliberately keep the masked `500`: they may quote backend state, and a concurrency conflict is
transient rather than permanent. Branch on them with `instanceof` — every one is exported.

## Bounding a call

The plugin adds no call deadline of its own. A JavaScript deadline cannot cancel the statement — the
connection stays occupied, so a deadline only moves the hang from the caller to pool exhaustion —
and inside a transaction it rejects while the statement may still commit. The bound is the driver's
own, enforced by the driver that owns the connection; on node-postgres a query that hits
`query_timeout` rejects with the driver's `Query read timeout`, and the timed-out client is released
with the error and removed from the pool, so the bound does not leak a connection. A call that hits
the bound is answered `504 Gateway Timeout` with `DatabaseTimeoutError`; the statement may have run,
so a write's outcome is unknown and a retry of a write must be idempotent.

| Adapter                  | The driver's own call bound                                                                                                                  | Status               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Drizzle on node-postgres | Set `query_timeout` and `connectionTimeoutMillis` on the `Pool` you pass Drizzle                                                             | **verified** (M113g) |
| Prisma                   | no per-call option; Prisma 7 runs over a driver adapter, so set that driver's bound (for `@prisma/adapter-pg`, the same `pg` `Pool` options) | **unverified**       |
| MongoDB                  | `MongoClient`'s `timeoutMS` (client-side operation timeout), or a per-operation `maxTimeMS`                                                  | **unverified**       |
| DynamoDB                 | the AWS SDK v3 `NodeHttpHandler` `requestTimeout`                                                                                            | **unverified**       |
| Cosmos DB                | `connectionPolicy.requestTimeout` on the `CosmosClient` options                                                                              | **unverified**       |
| Bigtable                 | the gRPC call deadline (`timeout` in google-gax call options)                                                                                | **unverified**       |
| D1                       | none the binding exposes; only the platform's own query limits apply                                                                         | **unverified**       |

Inside `service.transaction(...)` the bound applies twice. The timed-out statement rejects after
`query_timeout`, and the `ROLLBACK` that follows waits behind it on the same connection until its
own bound expires, so the caller receives `DatabaseTimeoutError` after about twice `query_timeout`
(measured: about 2.03 s with `query_timeout: 1000` against a paused PostgreSQL 16), still while the
database is paused. It is a bound on each statement, not a deadline on the transaction.

## Health reporting

The `database` indicator gates on the service's lifecycle first (a closed database reads `down`
immediately), then reports reachability from the adapter's own probe. **Since M95b** the payload
carries `reachable` whenever the adapter can probe:

| `reachable`                                                        | Status     | `/ready` |
| ------------------------------------------------------------------ | ---------- | -------- |
| `true`                                                             | `up`       | 200      |
| `false`                                                            | `down`     | 503      |
| `'unknown'`                                                        | `degraded` | 503      |
| `'unknown'` while the pool is saturated and queries are completing | `up`       | 200      |
| omitted                                                            | `up`       | 200      |

The rows are the whole decision. **Since M101a** a saturated pool is not an outage. When the Drizzle
adapter's `poolStats` reports every connection busy with callers waiting (`idle === 0` and
`waiting > 0`), the probe queues no `SELECT 1` behind the callers it would be measuring, and the
indicator reports `up` with `reachable: 'unknown'` and the snapshot in `data.capacity` — failing
`/ready` there would pull every saturated replica out of rotation at once. A full pool is ALSO what
a hung database looks like (every connection stuck on a server that never answers, callers piling
up), so the row additionally requires that a query through the adapter completed within the last 10
seconds. The indicator samples the adapter's completed-query count on each poll, so a hang is
detected at most one poll interval plus that window after the last completion; a saturated pool
whose queries have all stopped completing reports `degraded` and `/ready` answers 503. Only queries
the adapter runs are counted (`query()`, repositories, the Unit of Work's data sources): once
`getDrizzleDatabase` or `getDrizzleTransaction` has handed out the native instance, its queries
bypass the adapter, so progress is unobservable and a saturated pool keeps reading `up` — the
indicator cannot then tell a hang from load. Queries the application runs on its own Drizzle
instance are not counted either; an application that queries mainly that way should expect a busy
pool to read `degraded`. That row needs `poolStats`: without it the indicator cannot tell saturation
from trouble, so a pool connection timeout or a probe that does not answer reports `degraded`. A
pool connection timeout used to report `down` (it answered `false`); it is now `degraded`, because
the database never answered either way. A probe that **exists and did not answer** inside the
2-second bound is evidence of trouble and reports `degraded` — never `up`, which is the claim that
let a stopped database keep taking traffic (X51-1: the indicator used to read the lifecycle
`isReady()`, which only says `connect()` once succeeded). An adapter that ships **no probe** is the
opposite case: a probe that was never written is evidence of nothing, so the payload omits
`reachable` and the status is today's — mapping a missing probe to `degraded` would fail `/ready`
for every healthy Cosmos, Bigtable and DynamoDB application on upgrade.

Shipped probes: MongoDB (`db.command({ ping: 1 })` through the optional `IMongoDatabase.command?`
facade member), Prisma and Drizzle (`SELECT 1`; Drizzle omits the probe for instances without
`execute()`), memory (its own connection state — the process is the backend). Cosmos, Bigtable and
DynamoDB omit the probe until each gains one optional member on its own client facade; their
payloads are unchanged. A custom adapter opts in by declaring `isHealthy?(): Promise<boolean>` on
the adapter — `true` when the backend answered, `false` when it refused, or omit the member rather
than inventing an answer. The lifecycle read still gates the probe, so an adapter whose probe
forgets to re-derive `isReady()` cannot report `up` for a connection it has already dropped; a probe
SHOULD still answer `false` once disconnected, because `DatabaseService.reachability()` is also read
directly.

## Transactions

`IUnitOfWork` groups repository work into one transaction. Prisma exposes only callback-style
`$transaction` with a default timeout, so the adapter bridges that model rather than offering
imperative begin/commit.

## Exports

| Export                                    | Kind      |
| ----------------------------------------- | --------- |
| `createDatabaseGrantSource`               | function  |
| `createDatabaseIdempotencyStore`          | function  |
| `createDatabaseInboxStore`                | function  |
| `createDatabaseOutboxStore`               | function  |
| `createDatabaseRoleSource`                | function  |
| `createDatabaseTenantDataStore`           | function  |
| `createDrizzleDatabase`                   | function  |
| `createDrizzleDataSource`                 | function  |
| `createInjectedBigtableLoader`            | function  |
| `createInjectedDynamoLoader`              | function  |
| `createLazyBigtableLoader`                | function  |
| `createLazyDynamoLoader`                  | function  |
| `createMigrationLedger`                   | function  |
| `createPrismaDataSource`                  | function  |
| `DatabasePlugin`                          | function  |
| `decodeCursor`                            | function  |
| `deleteVersioned`                         | function  |
| `encodeCursor`                            | function  |
| `getDrizzleDatabase`                      | function  |
| `getDrizzleTransaction`                   | function  |
| `keysetPredicate`                         | function  |
| `updateVersioned`                         | function  |
| `withIsolationSupport`                    | function  |
| `BaseRepository`                          | class     |
| `BigtableAdapter`                         | class     |
| `BigtableTransactionScopeError`           | class     |
| `CosmosAdapter`                           | class     |
| `CosmosConcurrentModificationError`       | class     |
| `CosmosTransactionScopeError`             | class     |
| `DatabaseService`                         | class     |
| `DatabaseTenantDataStore`                 | class     |
| `DatabaseTimeoutError`                    | class     |
| `DatabaseUnavailableError`                | class     |
| `DrizzleAdapter`                          | class     |
| `DrizzleRepository`                       | class     |
| `DynamoAdapter`                           | class     |
| `EntityNotFoundError`                     | class     |
| `InboxStoreUnavailableError`              | class     |
| `MemoryAdapter`                           | class     |
| `MigrationLedgerError`                    | class     |
| `MissingKeyColumnError`                   | class     |
| `MongoAdapter`                            | class     |
| `MongoTransactionUnavailableError`        | class     |
| `OutboxStoreUnavailableError`             | class     |
| `PrismaAdapter`                           | class     |
| `PrismaRepository`                        | class     |
| `SerializationConflictError`              | class     |
| `TenantColumnUnresolvedError`             | class     |
| `TenantStoreStrategyUnsupportedError`     | class     |
| `TransactionalStoreUnavailableError`      | class     |
| `UnitOfWork`                              | class     |
| `UnknownPayloadFieldError`                | class     |
| `UnsupportedFilterOperatorError`          | class     |
| `UnsupportedIsolationLevelError`          | class     |
| `UnsupportedMigrationError`               | class     |
| `UnsupportedQueryFeatureError`            | class     |
| `UnsupportedRawQueryError`                | class     |
| `VersionConflictError`                    | class     |
| `MIGRATION_LEDGER_ENTITY`                 | const     |
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
| `DatabaseGrantSourceOptions`              | interface |
| `DatabaseIdempotencyStoreOptions`         | interface |
| `DatabaseInboxStoreOptions`               | interface |
| `DatabaseOutboxStoreOptions`              | interface |
| `DatabasePoolCapacity`                    | interface |
| `DatabaseReadinessOptions`                | interface |
| `DatabaseRoleSourceOptions`               | interface |
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
| `GrantFields`                             | interface |
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
| `IMigrationLedger`                        | interface |
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
| `MigrationLedgerOptions`                  | interface |
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
| `RoleFields`                              | interface |
| `TransactionOptions`                      | interface |
| `VersionedDeletable`                      | interface |
| `VersionedWritable`                       | interface |
| `VersionedWriteOptions`                   | interface |
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
| `TransactionIsolationLevel`               | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#databaseplugin-setu-tsdatabase-plugin).

## Readiness and dependency outages (M113b)

The database driver's existing unavailable-errno classification uses the shared
`isConnectionFaultCode(code)` predicate from `@setu-ts/common`. The eight-code set is
module-private; status classification is unchanged.
