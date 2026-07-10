// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy IRepository
/**
 * Unit tests for DrizzleRepository and createDrizzleDataSource.
 *
 * Uses the fake Drizzle instance with in-memory store so data source methods
 * exercise real chainable query builder calls.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createDrizzleDataSource,
  DrizzleRepository,
} from '../../src/adapters/drizzle/drizzle-repository.ts';
import type { DrizzleInstance } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';

describe('DrizzleRepository', () => {
  it('instantiates with a data source', () => {
    const fakeDb = createFakeDrizzleInstance();
    const ds = createDrizzleDataSource(
      fakeDb as unknown as DrizzleInstance,
      'user',
      { user: {} },
      {
        eq: (col, val) => ({ _operator: 'eq', arguments: [col, val], id: val }),
        and: (...exprs) => ({ _operator: 'and', arguments: exprs }),
        asc: (col) => ({ _operator: 'asc', arguments: [col] }),
        desc: (col) => ({ _operator: 'desc', arguments: [col] }),
      },
    );
    const repo = new DrizzleRepository(ds);
    expect(repo).toBeDefined();
  });

  it('delegates findById to data source', async () => {
    const ds: DataSource = {
      async findAll() {
        return [];
      },
      async findById(id) {
        return { id, name: 'fromDS' };
      },
      async create(data) {
        return data as Record<string, unknown>;
      },
      async update(_id, data) {
        return data as Record<string, unknown>;
      },
      async delete() {
        return true;
      },
      async count() {
        return 0;
      },
    };
    const repo = new DrizzleRepository<{ id: string; name: string }>(ds);
    const result = await repo.findById('1');
    expect(result?.name).toBe('fromDS');
  });
});

describe('createDrizzleDataSource — with fake instance', () => {
  let fakeDb: ReturnType<typeof createFakeDrizzleInstance>;
  let ds: DataSource;

  beforeEach(() => {
    fakeDb = createFakeDrizzleInstance();
    ds = createDrizzleDataSource(
      fakeDb as unknown as DrizzleInstance,
      'user',
      { user: {} },
      {
        eq: (col, val) => ({ _operator: 'eq', arguments: [col, val], id: val }),
        and: (...exprs) => ({ _operator: 'and', arguments: exprs }),
        asc: (col) => ({ _operator: 'asc', arguments: [col] }),
        desc: (col) => ({ _operator: 'desc', arguments: [col] }),
      },
    );
  });

  it('returns a data source with all required methods', () => {
    expect(typeof ds.findAll).toBe('function');
    expect(typeof ds.findById).toBe('function');
    expect(typeof ds.create).toBe('function');
    expect(typeof ds.update).toBe('function');
    expect(typeof ds.delete).toBe('function');
    expect(typeof ds.count).toBe('function');
  });

  it('findById returns entity when found', async () => {
    await fakeDb.insert('user').values({ id: '1', name: 'Alice' }).execute();
    const user = await ds.findById('1');
    expect(user).not.toBeNull();
    expect(user?.name).toBe('Alice');
  });

  it('findById returns null when not found', async () => {
    const result = await ds.findById('999');
    expect(result).toBeNull();
  });

  it('findAll returns seeded entities', async () => {
    await fakeDb.insert('user').values({ id: '1', name: 'Alice' }).execute();
    await fakeDb.insert('user').values({ id: '2', name: 'Bob' }).execute();
    const results = await ds.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(results.length).toBe(2);
  });

  it('create delegates to insert', async () => {
    const result = await ds.create({ name: 'Charlie' });
    expect(result.name).toBe('Charlie');
  });

  it('update delegates to update chain', async () => {
    await fakeDb.insert('user').values({ id: '1', name: 'Alice' }).execute();
    const updated = await ds.update('1', { name: 'Alice Updated' });
    expect(updated).toBeDefined();
  });

  it('delete removes entity', async () => {
    await fakeDb.insert('user').values({ id: '1', name: 'Alice' }).execute();
    const deleted = await ds.delete('1');
    expect(deleted).toBe(true);
  });

  it('count returns number of entities', async () => {
    await fakeDb.insert('user').values({ id: '1', name: 'Alice' }).execute();
    await fakeDb.insert('user').values({ id: '2', name: 'Bob' }).execute();
    const count = await ds.count({});
    expect(count).toBe(2);
  });
});
