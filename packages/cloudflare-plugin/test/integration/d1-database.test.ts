/**
 * D1 as a first-class database backend, driven through a REAL kernel
 * application and the REAL `DatabasePlugin`.
 *
 * This is the milestone's end-to-end evidence, and it is deliberately not a
 * mock-call assertion: every write is read back through the same public
 * repository surface an application uses, because an adapter whose `create()`
 * echoes its input and whose `findAll()` returns `[]` passes any test that
 * only asserts the calls it made (the M10 defect).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { HealthCheckResult, IApplication } from '@setu-ts/common';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';

import { D1Adapter } from '../../src/index.ts';
import { SqliteD1 } from '../d1-fakes.ts';

const SCHEMA = 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, age INTEGER)';

interface User {
  id: string;
  name: string;
  age: number;
}

/** Boot an application whose `database` capability is served by D1. */
async function bootApp(): Promise<{
  app: IApplication;
  db: IDatabaseService;
  d1: SqliteD1;
}> {
  const d1 = new SqliteD1(SCHEMA);
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DatabasePlugin({
        type: 'custom',
        adapter: new D1Adapter(d1, { tables: { User: { table: 'users' } } }),
      }),
    ],
  });
  await app.start();
  return { app, db: app.services.get<IDatabaseService>(CAPABILITIES.DATABASE), d1 };
}

describe('D1 through DatabasePlugin — the repository surface', () => {
  it('creates a user and reads it back through findById', async () => {
    const { app, db } = await bootApp();
    const users = db.getRepository<User>('User');

    const created = await users.create({ id: 'u1', name: 'ada', age: 36 });
    expect(created).toMatchObject({ id: 'u1', name: 'ada', age: 36 });

    // Read back through the SAME public API — this is the deliverable.
    const read = await users.findById('u1');
    expect(read).toMatchObject({ id: 'u1', name: 'ada', age: 36 });

    await app.stop();
  });

  it('filters, sorts and paginates through findAll', async () => {
    const { app, db } = await bootApp();
    const users = db.getRepository<User>('User');
    await users.create({ id: 'u1', name: 'ada', age: 36 });
    await users.create({ id: 'u2', name: 'bob', age: 24 });
    await users.create({ id: 'u3', name: 'ada', age: 51 });

    expect(await users.findAll({ where: { name: 'ada' }, orderBy: { age: 'desc' } }))
      .toMatchObject([{ id: 'u3' }, { id: 'u1' }]);
    expect(await users.findAll({ orderBy: { age: 'asc' }, limit: 1, offset: 1 }))
      .toMatchObject([{ id: 'u1' }]);
    expect(await users.findAll({ select: ['name'], orderBy: { age: 'asc' } }))
      .toEqual([{ name: 'bob' }, { name: 'ada' }, { name: 'ada' }]);

    await app.stop();
  });

  // Every operator the portable filter advertises, EXECUTED against real
  // SQLite through the same repository an application holds. `d1-sql.test.ts`
  // asserts the generated statement as a string, which cannot tell whether
  // SQLite accepts it or whether the rows that come back are the right ones.
  it('EXECUTES every advertised filter operator through the repository', async () => {
    const { app, db } = await bootApp();
    const users = db.getRepository<User>('User');
    await users.create({ id: 'u1', name: 'ada', age: 36 });
    await users.create({ id: 'u2', name: 'bob', age: 24 });
    await users.create({ id: 'u3', name: '50%_off', age: 51 });

    const ids = async (filter: Parameters<typeof users.findAll>[0]): Promise<string[]> =>
      (await users.findAll({ ...filter, orderBy: { id: 'asc' } })).map((row) => row.id);

    expect(
      await ids({ filter: { type: 'comparison', field: 'name', operator: 'eq', value: 'ada' } }),
    )
      .toEqual(['u1']);
    // `instr` is a literal substring match, so the `%` and `_` are data here,
    // not wildcards — an unescaped LIKE would return every row.
    expect(
      await ids({
        filter: { type: 'comparison', field: 'name', operator: 'contains', value: '%_off' },
      }),
    ).toEqual(['u3']);
    expect(await ids({ filter: { type: 'comparison', field: 'age', operator: 'gt', value: 36 } }))
      .toEqual(['u3']);
    expect(await ids({ filter: { type: 'comparison', field: 'age', operator: 'gte', value: 36 } }))
      .toEqual(['u1', 'u3']);
    expect(await ids({ filter: { type: 'comparison', field: 'age', operator: 'lt', value: 36 } }))
      .toEqual(['u2']);
    expect(await ids({ filter: { type: 'comparison', field: 'age', operator: 'lte', value: 36 } }))
      .toEqual(['u1', 'u2']);
    expect(
      await ids({
        filter: { type: 'comparison', field: 'id', operator: 'in', value: ['u1', 'u3'] },
      }),
    ).toEqual(['u1', 'u3']);
    expect(await ids({ filter: { type: 'comparison', field: 'id', operator: 'in', value: [] } }))
      .toEqual([]);
    expect(
      await ids({
        filter: {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'age', operator: 'gte', value: 36 },
            {
              type: 'or',
              filters: [
                { type: 'comparison', field: 'name', operator: 'eq', value: 'ada' },
                { type: 'comparison', field: 'age', operator: 'gt', value: 50 },
              ],
            },
          ],
        },
      }),
    ).toEqual(['u1', 'u3']);

    // The equality map and the expression are conjoined, not exclusive.
    expect(
      await ids({
        where: { name: 'ada' },
        filter: { type: 'comparison', field: 'age', operator: 'gt', value: 30 },
      }),
    ).toEqual(['u1']);
    expect(
      await users.count({
        where: { name: 'ada' },
        filter: { type: 'comparison', field: 'age', operator: 'gt', value: 30 },
      }),
    ).toBe(1);

    await app.stop();
  });

  it('finds one row through findOne, and null when nothing matches', async () => {
    const { app, db } = await bootApp();
    const users = db.getRepository<User>('User');
    await users.create({ id: 'u1', name: 'ada', age: 36 });
    await users.create({ id: 'u2', name: 'bob', age: 51 });

    const found = await users.findOne({
      filter: { type: 'comparison', field: 'age', operator: 'gte', value: 40 },
    });

    expect(found).toMatchObject({ id: 'u2', name: 'bob' });
    expect(
      await users.findOne({
        filter: { type: 'comparison', field: 'name', operator: 'eq', value: 'nobody' },
      }),
    ).toBeNull();

    await app.stop();
  });

  it('updates, counts, checks existence and deletes', async () => {
    const { app, db } = await bootApp();
    const users = db.getRepository<User>('User');
    await users.create({ id: 'u1', name: 'ada', age: 36 });

    expect(await users.update('u1', { age: 37 })).toMatchObject({ age: 37 });
    expect(await users.findById('u1')).toMatchObject({ age: 37 }); // persisted
    expect(await users.count()).toBe(1);
    expect(await users.count({ where: { name: 'nobody' } })).toBe(0);
    expect(await users.exists('u1')).toBe(true);

    expect(await users.delete('u1')).toBe(true);
    expect(await users.findById('u1')).toBeNull();
    expect(await users.delete('u1')).toBe(false);
    expect(await users.exists('u1')).toBe(false);

    await app.stop();
  });

  it('runs a raw SQL query through the service', async () => {
    const { app, db } = await bootApp();
    await db.getRepository<User>('User').create({ id: 'u1', name: 'ada', age: 36 });

    const rows = await db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM users WHERE age > ?1',
      [30],
    );

    expect(rows).toEqual([{ total: 1 }]);
    await app.stop();
  });
});

describe('D1 through DatabasePlugin — Unit of Work', () => {
  it('commits every repository write in the transaction as one batch', async () => {
    const { app, db, d1 } = await bootApp();

    const result = await db.transaction(async (uow) => {
      const users = uow.getRepository<User>('User');
      await users.create({ id: 'u1', name: 'ada', age: 36 });
      await users.create({ id: 'u2', name: 'bob', age: 24 });
      return 'done';
    });

    expect(result).toBe('done');
    expect(d1.batches).toHaveLength(1);
    expect(d1.batches[0]).toHaveLength(2);

    // Visible through the public surface once committed.
    const users = db.getRepository<User>('User');
    expect(await users.count()).toBe(2);

    await app.stop();
  });

  it('forwards an expression filter to a transaction-scoped count', async () => {
    const { app, db } = await bootApp();
    const users = db.getRepository<User>('User');
    await users.create({ id: 'u1', name: 'ada', age: 36 });
    await users.create({ id: 'u2', name: 'bob', age: 24 });

    // Reads inside a D1 transaction see committed state (writes are deferred
    // to one batch), so this counts the two rows above — the point is that the
    // transaction source passes the filter through rather than dropping it.
    const counted = await db.transaction((uow) =>
      uow.getRepository<User>('User').count({
        filter: { type: 'comparison', field: 'age', operator: 'gte', value: 30 },
      })
    );

    expect(counted).toBe(1);
    await app.stop();
  });

  it('rolls back and writes nothing when the callback throws', async () => {
    const { app, db, d1 } = await bootApp();

    await expect(db.transaction(async (uow) => {
      await uow.getRepository<User>('User').create({ id: 'u1', name: 'ada', age: 36 });
      throw new Error('business rule failed');
    })).rejects.toThrow('business rule failed');

    expect(d1.batches).toEqual([]);
    expect(await db.getRepository<User>('User').count()).toBe(0);

    await app.stop();
  });
});

describe('D1 through DatabasePlugin — lifecycle wiring', () => {
  it('reports healthy through the registered database indicator', async () => {
    const { app } = await bootApp();

    const indicators = app.services.getAll<
      { name: string; check: () => Promise<HealthCheckResult> }
    >(CAPABILITIES.HEALTH_INDICATOR);
    const indicator = indicators.find((i) => i.name === CAPABILITIES.DATABASE);

    expect(indicator).toBeDefined();
    expect(await indicator!.check()).toMatchObject({ status: 'up' });

    await app.stop();
  });

  it('disconnects the adapter on shutdown, so the app stops serving queries', async () => {
    const d1 = new SqliteD1(SCHEMA);
    const adapter = new D1Adapter(d1);
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
    });
    await app.start();

    expect(adapter.isReady()).toBe(true);
    await app.stop();
    expect(adapter.isReady()).toBe(false);
  });
});
