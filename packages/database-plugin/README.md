# @setu-ts/database-plugin

Database access with the repository pattern and Unit of Work. Registers an `IDatabaseService` under
`CAPABILITIES.DATABASE` (`'database'`).

Three adapters ship: `MemoryAdapter` (zero-dependency default), `PrismaAdapter`, and
`DrizzleAdapter`. The application owns the optional ORM clients and injects them into the plugin.

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

| Option    | Type                                | Default     | Description                              |
| --------- | ----------------------------------- | ----------- | ---------------------------------------- |
| `type`    | `'memory' \| 'prisma' \| 'drizzle'` | `'memory'`  | ORM adapter.                             |
| `name`    | `string`                            | `'default'` | Named connection for multi-database use. |
| `options` | `DatabaseAdapterOptions`            | —           | Adapter-specific configuration.          |

A `name` other than `'default'` registers under `database.<name>` (e.g. `database.primary`). Note
the **dot**, not a colon — `createCapabilityToken` rejects colons.

`options` is a `DatabaseAdapterOptions`, and the arms narrow it: `type: 'prisma'` requires
`prismaClient`, `type: 'drizzle'` requires both `drizzleInstance` and `drizzleTables`. Those are
required **by the union**, so omitting one is a compile error rather than a startup throw.

| `options` field      | Type                      | Default | Read by                                                                                                                                      |
| -------------------- | ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `logQueries`         | `boolean`                 | `false` | The database **service**, so it applies to every adapter including `'custom'` — logs entity, operation and monotonic duration.               |
| `prismaClient`       | `unknown`                 | —       | Prisma. Required.                                                                                                                            |
| `provider`           | `PrismaSqlProvider`       | derived | Prisma. Names the connector when it cannot be detected; see `contains` below.                                                                |
| `drizzleInstance`    | `DrizzleDatabaseIdentity` | —       | Drizzle. Required; created by `createDrizzleDatabase()`.                                                                                     |
| `drizzleTables`      | `Record<string, unknown>` | —       | Drizzle. Required; entity name → real table definition.                                                                                      |
| `transactionTimeout` | `number` (ms)             | `30000` | Prisma only. Raises Prisma's ~5 s interactive-transaction default, which is too short for a full Unit of Work. Unread by Memory and Drizzle. |
| `url`                | `string`                  | —       | **Deprecated and unread.** A Prisma v7 client carries its own connection configuration; see below.                                           |

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
adapter and D1 match case-sensitively; a `LIKE`-based backend follows the column's collation, which
is case-sensitive on PostgreSQL and case-insensitive on SQLite and most MySQL collations.

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

## Transactions

`IUnitOfWork` groups repository work into one transaction. Prisma exposes only callback-style
`$transaction` with a default timeout, so the adapter bridges that model rather than offering
imperative begin/commit.

## Exports

| Export | Kind |
| --- | --- |
| `createDrizzleDatabase` | function |
| `createDrizzleDataSource` | function |
| `createPrismaDataSource` | function |
| `DatabasePlugin` | function |
| `getDrizzleDatabase` | function |
| `getDrizzleTransaction` | function |
| `BaseRepository` | class |
| `DatabaseService` | class |
| `DrizzleAdapter` | class |
| `DrizzleRepository` | class |
| `MemoryAdapter` | class |
| `PrismaAdapter` | class |
| `PrismaRepository` | class |
| `UnitOfWork` | class |
| `UnsupportedFilterOperatorError` | class |
| `CountOptions` | interface |
| `CustomDatabaseOptions` | interface |
| `DatabaseAdapterOptions` | interface |
| `DatabaseConnectionOptions` | interface |
| `DrizzleAdapterOptions` | interface |
| `DrizzleDatabase` | interface |
| `DrizzleDatabaseIdentity` | interface |
| `DrizzleDatabaseOptions` | interface |
| `FindOptions` | interface |
| `IAdapterTransaction` | interface |
| `IDatabaseAdapter` | interface |
| `IDatabaseService` | interface |
| `IDataSource` | interface |
| `IRepository` | interface |
| `IUnitOfWork` | interface |
| `MemoryDatabaseOptions` | interface |
| `NormalizedQuery` | interface |
| `PrismaAdapterOptions` | interface |
| `PrismaDatabaseOptions` | interface |
| `BuiltInDatabaseOptions` | type |
| `DatabaseAdapterType` | type |
| `DatabasePluginOptions` | type |
| `DataSource` | type |
| `DrizzleTransaction` | type |
| `DrizzleTransactionBridge` | type |
| `FilterComparison` | type |
| `FilterExpression` | type |
| `FilterOperator` | type |
| `OrderDirection` | type |
| `PrismaSqlProvider` | type |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#databaseplugin-setu-tsdatabase-plugin).
