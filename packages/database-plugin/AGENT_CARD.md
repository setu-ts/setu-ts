# @setu-ts/database-plugin — repositories and transactions

**Add it:** `setu add database` adds it; add `DatabasePlugin({ type: 'memory' })` to
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
- Give a Drizzle `pg` Pool an `'error'` listener; see the README's Drizzle pool setup.

## Other options

- `type` also selects `'prisma'`, `'drizzle'`, `'mongodb'`, `'dynamodb'`, `'cosmos'`, `'bigtable'`
  or `'custom'`.
- `name` selects a named database token; `readiness` configures migration readiness checks.
- `findAll` supports filtering and ordering; `findPage` supplies cursor pagination where supported.
