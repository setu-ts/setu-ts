// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy IRepository
/**
 * Unit tests for PrismaRepository and createPrismaDataSource.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createPrismaDataSource,
  PrismaRepository,
} from '../../src/adapters/prisma/prisma-repository.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('PrismaRepository', () => {
  it('instantiates with a data source', () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const repo = new PrismaRepository(ds);
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
    const repo = new PrismaRepository<{ id: string; name: string }>(ds);
    const result = await repo.findById('1');
    expect(result?.name).toBe('fromDS');
  });
});

describe('createPrismaDataSource', () => {
  it('returns a data source with all required methods', () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    expect(typeof ds.findAll).toBe('function');
    expect(typeof ds.findById).toBe('function');
    expect(typeof ds.create).toBe('function');
    expect(typeof ds.update).toBe('function');
    expect(typeof ds.delete).toBe('function');
    expect(typeof ds.count).toBe('function');
  });

  it('findAll returns empty array for stub', async () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const results = await ds.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(results).toEqual([]);
  });

  it('findById returns null for stub', async () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const result = await ds.findById('1');
    expect(result).toBeNull();
  });

  it('create returns data for stub', async () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const result = await ds.create({ name: 'Alice' });
    expect(result.name).toBe('Alice');
  });

  it('update returns data for stub', async () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const result = await ds.update('1', { name: 'Bob' });
    expect(result.name).toBe('Bob');
  });

  it('delete returns false for stub', async () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const result = await ds.delete('1');
    expect(result).toBe(false);
  });

  it('count returns 0 for stub', async () => {
    const ds = createPrismaDataSource(
      {} as import('../../src/adapters/prisma/prisma-adapter.ts').PrismaAdapter,
      'User',
    );
    const result = await ds.count({});
    expect(result).toBe(0);
  });
});
