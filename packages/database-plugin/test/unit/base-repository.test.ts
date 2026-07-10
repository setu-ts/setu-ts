// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy IRepository
/**
 * Unit tests for BaseRepository.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BaseRepository, type DataSource } from '../../src/repositories/base-repository.ts';

interface TestEntity {
  id: string;
  name: string;
  active: boolean;
}

/** Create a simple in-memory data source for testing. */
function createTestDataSource(): DataSource & { records: Partial<TestEntity>[] } {
  const records: Partial<TestEntity>[] = [];
  return {
    records,
    async findAll(query) {
      let result = [...records];
      for (const [key, value] of Object.entries(query.where)) {
        result = result.filter((r) => r[key as keyof TestEntity] === value);
      }
      return result as unknown as Record<string, unknown>[];
    },
    async findById(id: string | number) {
      const found = records.find((r) => r.id === id);
      return found ? { ...found } as unknown as Record<string, unknown> : null;
    },
    async create(data) {
      const entity = { id: crypto.randomUUID(), ...data };
      records.push(entity);
      return entity as unknown as Record<string, unknown>;
    },
    async update(id: string | number, data) {
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) throw new Error('not found');
      records[index] = { ...records[index], ...data };
      return { ...records[index] } as unknown as Record<string, unknown>;
    },
    async delete(id: string | number) {
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    },
    async count(where) {
      let result = [...records];
      for (const [key, value] of Object.entries(where)) {
        result = result.filter((r) => r[key as keyof TestEntity] === value);
      }
      return result.length;
    },
  };
}

class TestRepository extends BaseRepository<TestEntity, string> {
  constructor(dataSource: ReturnType<typeof createTestDataSource>) {
    super(dataSource);
  }
}

describe('BaseRepository', () => {
  let ds: ReturnType<typeof createTestDataSource>;
  let repo: TestRepository;

  beforeEach(() => {
    ds = createTestDataSource();
    repo = new TestRepository(ds);
  });

  describe('findById', () => {
    it('returns entity when found', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      const entity = await repo.findById('1');
      expect(entity).not.toBeNull();
      expect(entity!.name).toBe('Alice');
    });

    it('returns null when not found', async () => {
      const entity = await repo.findById('missing');
      expect(entity).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns all entities when no options', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: false });
      const entities = await repo.findAll();
      expect(entities.length).toBe(2);
    });

    it('filters by where clause', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: false });
      const entities = await repo.findAll({ where: { active: true } });
      expect(entities.length).toBe(1);
      expect(entities[0].name).toBe('Alice');
    });

    it('respects limit', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: true });
      ds.records.push({ id: '3', name: 'Charlie', active: true });
      const entities = await repo.findAll({ limit: 2 });
      expect(entities.length).toBe(2);
    });

    it('respects offset', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: true });
      const entities = await repo.findAll({ offset: 1 });
      expect(entities.length).toBe(1);
      expect(entities[0].name).toBe('Bob');
    });

    it('projects fields', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      const entities = await repo.findAll({ select: ['name'] });
      expect(entities.length).toBe(1);
      expect(entities[0].name).toBe('Alice');
      expect('id' in entities[0]).toBe(false);
    });
  });

  describe('create', () => {
    it('creates and returns the entity', async () => {
      const entity = await repo.create({ name: 'Alice', active: true });
      expect(entity.name).toBe('Alice');
      expect(entity.id).toBeDefined();
    });
  });

  describe('update', () => {
    it('updates and returns the entity', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      const entity = await repo.update('1', { name: 'Alicia' });
      expect(entity.name).toBe('Alicia');
      expect(entity.active).toBe(true);
    });
  });

  describe('delete', () => {
    it('returns true when deleted', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      const deleted = await repo.delete('1');
      expect(deleted).toBe(true);
    });

    it('returns false when not found', async () => {
      const deleted = await repo.delete('missing');
      expect(deleted).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true when entity exists', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      expect(await repo.exists('1')).toBe(true);
    });

    it('returns false when entity does not exist', async () => {
      expect(await repo.exists('missing')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns total count', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: false });
      expect(await repo.count()).toBe(2);
    });

    it('counts with filter', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: false });
      expect(await repo.count({ where: { active: true } })).toBe(1);
    });
  });
});
