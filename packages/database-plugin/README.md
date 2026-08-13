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
import { PrismaClient } from './generated/prisma/client.ts';

const prismaClient = new PrismaClient();

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

For Prisma v7, generate and construct the client in the application, then pass it as
`options.prismaClient`. A framework package cannot locate an application's generated-client output.

For Drizzle, pass both the configured driver and a table registry. The table objects must expose an
`id` column, and every field supplied to repository `where`, `orderBy`, or `select` must be a real
column on that table. Its `create`, `update`, and `delete` operations require a dialect that
supports `RETURNING`, so the adapter can return the actual persisted row instead of guessing:

```typescript
DatabasePlugin({
  type: 'drizzle',
  options: {
    drizzleInstance: db,
    drizzleTables: { User: users },
  },
});
```

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
is case-sensitive on PostgreSQL and case-insensitive on SQLite and most MySQL collations. `%` and
`_` in the searched value are always data, never wildcards.

## Transactions

`IUnitOfWork` groups repository work into one transaction. Prisma exposes only callback-style
`$transaction` with a default timeout, so the adapter bridges that model rather than offering
imperative begin/commit.

## Exports

| Export                      | Kind      |
| --------------------------- | --------- |
| `createDrizzleDataSource`   | function  |
| `createPrismaDataSource`    | function  |
| `DatabasePlugin`            | function  |
| `BaseRepository`            | class     |
| `DatabaseService`           | class     |
| `DrizzleAdapter`            | class     |
| `DrizzleRepository`         | class     |
| `MemoryAdapter`             | class     |
| `PrismaAdapter`             | class     |
| `PrismaRepository`          | class     |
| `UnitOfWork`                | class     |
| `BuiltInDatabaseOptions`    | interface |
| `CountOptions`              | interface |
| `CustomDatabaseOptions`     | interface |
| `DatabaseAdapterOptions`    | interface |
| `DatabaseConnectionOptions` | interface |
| `FindOptions`               | interface |
| `IAdapterTransaction`       | interface |
| `IDatabaseAdapter`          | interface |
| `IDatabaseService`          | interface |
| `IDataSource`               | interface |
| `IRepository`               | interface |
| `IUnitOfWork`               | interface |
| `NormalizedQuery`           | interface |
| `DatabaseAdapterType`       | type      |
| `DatabasePluginOptions`     | type      |
| `DataSource`                | type      |
| `FilterComparison`          | type      |
| `FilterExpression`          | type      |
| `FilterOperator`            | type      |
| `OrderDirection`            | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#databaseplugin-setu-tsdatabase-plugin).
