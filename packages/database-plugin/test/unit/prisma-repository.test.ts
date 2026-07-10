// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy IRepository
/**
 * Unit tests for PrismaRepository and createPrismaDataSource.
 *
 * Uses the fake Prisma client with in-memory store so data source methods
 * exercise real delegate calls (findUnique/findMany/create/update/delete/count).
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createPrismaDataSource,
  PrismaRepository,
} from '../../src/adapters/prisma/prisma-repository.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';

describe('PrismaRepository', () => {
  it('instantiates with a data source', () => {
    const fakeClient = createFakePrismaClient();
    const ds = createPrismaDataSource(fakeClient, 'User');
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

describe('createPrismaDataSource — with fake client', () => {
  let fakeClient: ReturnType<typeof createFakePrismaClient>;
  let ds: DataSource;

  beforeEach(() => {
    fakeClient = createFakePrismaClient();
    ds = createPrismaDataSource(fakeClient, 'User');
  });

  it('returns a data source with all required methods', () => {
    expect(typeof ds.findAll).toBe('function');
    expect(typeof ds.findById).toBe('function');
    expect(typeof ds.create).toBe('function');
    expect(typeof ds.update).toBe('function');
    expect(typeof ds.delete).toBe('function');
    expect(typeof ds.count).toBe('function');
  });

  it('findById returns entity when found via findUnique', async () => {
    // Seed a user
    await ds.create({ name: 'Alice' });
    const user = await ds.findById('1');
    expect(user).not.toBeNull();
    expect(user?.name).toBe('Alice');
  });

  it('findById returns null when not found', async () => {
    const result = await ds.findById('999');
    expect(result).toBeNull();
  });

  it('findAll returns seeded entities', async () => {
    await ds.create({ name: 'Alice' });
    await ds.create({ name: 'Bob' });
    const results = await ds.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(results.length).toBe(2);
  });

  it('create delegates to delegate.create', async () => {
    const result = await ds.create({ name: 'Charlie' });
    expect(result.name).toBe('Charlie');
    expect(result.id).toBeDefined();
  });

  it('update delegates to delegate.update', async () => {
    const created = await ds.create({ name: 'Alice' });
    const updated = await ds.update(created.id as string, { name: 'Alice Updated' });
    expect(updated.name).toBe('Alice Updated');
  });

  it('update throws when entity not found', async () => {
    await expect(ds.update('999', { name: 'Nobody' })).rejects.toThrow();
  });

  it('delete returns true when entity exists', async () => {
    const created = await ds.create({ name: 'Alice' });
    const deleted = await ds.delete(created.id as string);
    expect(deleted).toBe(true);
  });

  it('delete returns false when entity not found (P2025 caught)', async () => {
    const deleted = await ds.delete('999');
    expect(deleted).toBe(false);
  });

  it('count returns number of entities', async () => {
    await ds.create({ name: 'Alice' });
    await ds.create({ name: 'Bob' });
    const count = await ds.count({});
    expect(count).toBe(2);
  });
});
