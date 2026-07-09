// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy IRepository
/**
 * Unit tests for DrizzleRepository and createDrizzleDataSource.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createDrizzleDataSource,
  DrizzleRepository,
} from '../../src/adapters/drizzle/drizzle-repository.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('DrizzleRepository', () => {
  it('instantiates with a data source', () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
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

describe('createDrizzleDataSource', () => {
  it('returns a data source with all required methods', () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    expect(typeof ds.findAll).toBe('function');
    expect(typeof ds.findById).toBe('function');
    expect(typeof ds.create).toBe('function');
    expect(typeof ds.update).toBe('function');
    expect(typeof ds.delete).toBe('function');
    expect(typeof ds.count).toBe('function');
  });

  it('findAll returns empty array for stub', async () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    const results = await ds.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(results).toEqual([]);
  });

  it('findById returns null for stub', async () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    const result = await ds.findById('1');
    expect(result).toBeNull();
  });

  it('create returns data for stub', async () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    const result = await ds.create({ name: 'Alice' });
    expect(result.name).toBe('Alice');
  });

  it('update returns data for stub', async () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    const result = await ds.update('1', { name: 'Bob' });
    expect(result.name).toBe('Bob');
  });

  it('delete returns false for stub', async () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    const result = await ds.delete('1');
    expect(result).toBe(false);
  });

  it('count returns 0 for stub', async () => {
    const ds = createDrizzleDataSource(
      {} as import('../../src/adapters/drizzle/drizzle-adapter.ts').DrizzleAdapter,
      'users',
    );
    const result = await ds.count({});
    expect(result).toBe(0);
  });
});
