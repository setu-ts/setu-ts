# @setu-ts/database-plugin — repositories and transactions

**Add it:** `setu add database`; register `DatabasePlugin({ type: 'memory' })`, or set a starter's
`database` option. Provides `CAPABILITIES.DATABASE` (`IDatabaseService`).

## Create and read an entity

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

- The default memory adapter loses data on exit.
- `findById` and `findOne` return `null` when absent.
- Only unit-of-work repositories join its transaction; a throw rolls back.
- Unsupported isolation levels reject.
- `query` rejects on memory; `migrate` on every adapter.
- DynamoDB/Cosmos/Bigtable calls end at `requestTimeoutMs` (15000, `0` off): 504.
- `/ready`: DynamoDB/Bigtable read `readinessEntity`; Cosmos `database.read()`.
- Give a Drizzle `pg` Pool an `'error'` listener (README).

## Other options

- `type` also takes `'prisma'`, `'drizzle'`, `'mongodb'`, `'dynamodb'`, `'cosmos'`, `'bigtable'` or
  `'custom'`.
- `name` names a database token; `readiness` checks migrations.
- `createDatabaseTenantRegistry()` feeds multi-tenancy `tenants`.
- `findAll` filters and orders; `findPage` pages by cursor where supported.
