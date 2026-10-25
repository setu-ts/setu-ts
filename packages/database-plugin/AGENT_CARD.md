# @setu-ts/database-plugin — repositories and transactions

**Add it:** `setu add database` installs it; add `DatabasePlugin({ type: 'memory' })` to
`setu.config.ts`. It provides `CAPABILITIES.DATABASE` (`IDatabaseService`).

## Create and read an entity from routes

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';

type User = { id: string; email: string; active: boolean };
export function registerUserRoutes(router: IRouterApi): void {
  router.post('/users', {
    handler: async (ctx) => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const users = db.getRepository<User>('User');
      const user = await users.create({
        id: (await ctx.request.json<User>()).id, email: 'ada@example.com', active: true,
      });
      return ctx.response.status(201).json(user);
    },
  });
  router.get('/users/:id', {
    handler: async (ctx) => {
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const user = await db.getRepository<User>('User').findById(ctx.params.id!);
      return user ? ctx.response.json(user) : ctx.response.status(404).json({ error: 'missing' });
    },
  });
}
```

## Update within one transaction

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';

const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
await db.transaction(async (uow) => {
  const users = uow.getRepository<{ id: string; active: boolean }>('User');
  await users.update('user-1', { active: false });
});
```

## Behaviour the types do not show

- The default adapter is memory and loses data when the process ends.
- `findById` and `findOne` return `null` when absent.
- Only repositories obtained from the unit of work share its transaction. Success commits; failure
  attempts rollback and rejects.
- Unsupported transaction isolation levels reject rather than silently downgrading.
- Raw `query` rejects on memory; `migrate` rejects on every current adapter.

## Other options

Drizzle uses an application-owned node-postgres pool. Attach an error listener before registration:

```ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describeError } from '@setu-ts/common';
import { createDrizzleDatabase, DatabasePlugin } from '@setu-ts/database-plugin';

const pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
pool.on('error', (error) => logger.warn('Database pool error', { error: describeError(error) }));
const database = drizzle(pool);
const plugin = DatabasePlugin({ type: 'drizzle', options: {
  drizzleInstance: createDrizzleDatabase(database, (db, work) => db.transaction(work)),
  drizzleTables: { User: users },
} });
```

The framework attaches a reporting listener only when the pool has none (also without a logger). The
app owns pool shutdown. Drizzle tenant columns resolve to model properties once per entity;
ambiguous or absent columns are server configuration faults (`TenantColumnUnresolvedError`). Drizzle
and D1 refuse unknown payload fields; schema-less adapters store them. Validate route body fields
explicitly. PostgreSQL field type refusals on Drizzle and D1 STRICT-table type refusals are
`InvalidFieldValueError` (400).

- `type` also selects `'prisma'`, `'drizzle'`, `'mongodb'`, `'dynamodb'`, `'cosmos'`, `'bigtable'`
  or `'custom'`.
- `name` selects a named database token; `readiness` configures migration readiness checks.
- `findAll` supports filtering and ordering; `findPage` supplies cursor pagination where supported.
