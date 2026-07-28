# @hono-enterprise/database-plugin

Database access with the repository pattern and Unit of Work. Registers an `IDatabaseService` under
`CAPABILITIES.DATABASE` (`'database'`).

Three adapters ship: `MemoryAdapter` (zero-dependency default), `PrismaAdapter` (over
`npm:@prisma/client`), and `DrizzleAdapter`.

## Installation

```typescript
import { DatabasePlugin } from '@hono-enterprise/database-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { DatabasePlugin, type IDatabaseService } from '@hono-enterprise/database-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    DatabasePlugin({ type: 'prisma', options: { url: 'postgresql://localhost:5432/app' } }),
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

## Transactions

`IUnitOfWork` groups repository work into one transaction. Prisma exposes only callback-style
`$transaction` with a default timeout, so the adapter bridges that model rather than offering
imperative begin/commit.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
