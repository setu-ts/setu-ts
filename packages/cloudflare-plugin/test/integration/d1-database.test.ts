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
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { HealthCheckResult, IApplication } from '@hono-enterprise/common';
import { DatabasePlugin } from '@hono-enterprise/database-plugin';
import type { IDatabaseService } from '@hono-enterprise/database-plugin';

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
