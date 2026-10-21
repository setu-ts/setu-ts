# @setu-ts/database-plugin — repositories, Unit of Work and ORM adapters

`setu add database` prints the `DatabasePlugin({ type: 'memory' })` line to add; no scaffold
registers it. It provides `IDatabaseService` under `CAPABILITIES.DATABASE`, or under
`database.<name>` when `name` is set. Adapters: `MemoryAdapter` (default), `PrismaAdapter`,
`DrizzleAdapter`, `MongoAdapter`, DynamoDB, Cosmos DB and Bigtable.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import { DatabasePlugin, type IDatabaseService } from '@setu-ts/database-plugin';

export async function createDatabaseApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), DatabasePlugin({ type: 'memory' })],
  });
  await app.start(); // capabilities exist only after start()
  return { app, db: app.services.get<IDatabaseService>(CAPABILITIES.DATABASE) };
}
```

```ts
import type { IDatabaseService } from '@setu-ts/database-plugin';

interface User { id: string; email: string; active: boolean }

export async function deactivate(db: IDatabaseService, id: string): Promise<boolean> {
  const users = db.getRepository<User, string>('User');
  await db.transaction(async (uow) => {
    await uow.getRepository<User, string>('User').update(id, { active: false });
  });
  return (await users.findById(id))?.active === false;
}
```

- `type` defaults to `'memory'`; `'prisma'` requires `options.prismaClient`, `'drizzle'`
  `drizzleInstance` and `drizzleTables`, `'custom'` `adapter`.
- Repositories expose `findById`, `findAll`, `findOne`, `create`, `update`, `delete`, `exists`,
  `count` and `findPage`; `findAll` takes `where`, `filter`, `orderBy`, `limit`, `offset`, `select`
  and `cursor`; a query carrying both offset and cursor is refused.
- `transaction(work, { isolation: 'serializable' })` commits on success and rolls back with the
  error. An unsupported level throws `UnsupportedIsolationLevelError`, never a silent downgrade.
- `query` runs raw SQL (the memory adapter answers 501); `migrate` always rejects with
  `UnsupportedMigrationError`.
- Bridge factories: `createDatabaseTenantDataStore`, `createDatabaseOutboxStore`,
  `createDatabaseInboxStore` and `createDatabaseIdempotencyStore`.
- `getDrizzleDatabase`/`getDrizzleTransaction` give typed Drizzle access.
- `readiness: { migrations: [...] }` adds a schema indicator; pass `provider` when Prisma cannot
  detect the connector, or `contains` throws `UnsupportedFilterOperatorError`.
