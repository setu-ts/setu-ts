/**
 * Unit tests for BaseRepository.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BaseRepository, type DataSource } from '../../src/repositories/base-repository.ts';
import {
  applyOrderBy,
  applyPagination,
  matchesFilter,
  matchesWhere,
  projectFields,
} from '../../src/query/query-builder.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import type { FindOptions } from '../../src/query/find-options.ts';

interface TestEntity {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Create a simple in-memory data source for testing.
 *
 * `findAll` evaluates the WHOLE `NormalizedQuery` — where, orderBy, offset/limit
 * and select — because that is what a real DataSource does (all three adapters
 * do). The previous double honored only `where`, so the `limit` / `offset` /
 * `select` tests were really exercising BaseRepository's duplicate pass, which
 * hid that applying `offset` twice emptied every page after the first.
 */
function createTestDataSource(): DataSource & { records: Partial<TestEntity>[] } {
  const records: Partial<TestEntity>[] = [];
  return {
    records,
    async findAll(query) {
      await Promise.resolve();
      let result = [...records] as unknown as Record<string, unknown>[];
      if (Object.keys(query.where).length > 0) {
        result = result.filter((row) => matchesWhere(row, query.where));
      }
      if (query.filter !== undefined) {
        const filter = query.filter;
        result = result.filter((row) => matchesFilter(row, filter));
      }
      result = applyOrderBy(result, query.orderBy);
      result = applyPagination(result, query.offset, query.limit);
      if (query.select.length > 0) {
        return result.map((row) => projectFields(row, query.select) as Record<string, unknown>);
      }
      return result;
    },
    async findById(id: string | number) {
      await Promise.resolve();
      const found = records.find((r) => r.id === id);
      return found ? { ...found } as unknown as Record<string, unknown> : null;
    },
    async create(data) {
      await Promise.resolve();
      const entity = { id: crypto.randomUUID(), ...data };
      records.push(entity);
      return entity as unknown as Record<string, unknown>;
    },
    async update(id: string | number, data) {
      await Promise.resolve();
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) throw new Error('not found');
      records[index] = { ...records[index], ...data };
      return { ...records[index] } as unknown as Record<string, unknown>;
    },
    async delete(id: string | number) {
      await Promise.resolve();
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    },
    async count(where) {
      await Promise.resolve();
      let result = [...records];
      for (const [key, value] of Object.entries(where)) {
        result = result.filter((r) => r[key as keyof TestEntity] === value);
      }
      return result.length;
    },
  };
}

class TestRepository extends BaseRepository<TestEntity, string> {
  constructor(dataSource: DataSource & { records: Partial<TestEntity>[] }) {
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

  describe('findOne', () => {
    it('returns the first matching entity through the adapter filter', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      ds.records.push({ id: '2', name: 'Bob', active: true });

      const entity = await repo.findOne({
        filter: { type: 'comparison', field: 'name', operator: 'contains', value: 'ob' },
      });

      expect(entity?.id).toBe('2');
    });

    it('returns null when no entity matches', async () => {
      expect(
        await repo.findOne({
          filter: { type: 'comparison', field: 'name', operator: 'eq', value: 'Nobody' },
        }),
      ).toBeNull();
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

  describe('findPage', () => {
    it('refuses by name when the data source omits findPage', async () => {
      // Build a fake data source that has all required members EXCEPT findPage.
      // Use an anonymous subclass to bypass the protected constructor.
      class StubRepo extends BaseRepository<TestEntity, string> {
        constructor() {
          super({
            findAll: async () => await Promise.resolve([]),
            findById: async () => await Promise.resolve(null),
            create: async () => await Promise.resolve({}),
            update: async () => await Promise.resolve({}),
            delete: async () => await Promise.resolve(false),
            count: async () => await Promise.resolve(0),
          } as unknown as DataSource);
        }
      }
      const repoWithoutFindPage = new StubRepo();
      await expect(repoWithoutFindPage.findPage({} as FindOptions)).rejects.toThrow(
        UnsupportedQueryFeatureError,
      );
      await expect(repoWithoutFindPage.findPage({} as FindOptions)).rejects.toThrow(
        'cursor pagination',
      );
    });

    it('still passes scalar round trips through findById/update/delete', async () => {
      ds.records.push({ id: '1', name: 'Alice', active: true });
      const entity = await repo.findById('1');
      expect(entity).not.toBeNull();
      expect(entity!.name).toBe('Alice');

      const updated = await repo.update('1', { name: 'Alicia' });
      expect(updated.name).toBe('Alicia');

      const deleted = await repo.delete('1');
      expect(deleted).toBe(true);
    });

    it('forwards findPage when the data source exposes it', async () => {
      const dsWithFindPage = createTestDataSource();
      // Add findPage to the test data source.
      (dsWithFindPage as unknown as DataSource & {
        findPage?: () => Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }>;
      }).findPage = async () => ({
        rows: [{ id: '1', name: 'Page1', active: true }],
        nextCursor: null,
      });
      const repoWithFindPage = new TestRepository(dsWithFindPage);
      const page = await repoWithFindPage.findPage({});
      expect(page.rows.length).toBe(1);
      expect(page.rows[0].name).toBe('Page1');
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('composite key round trip', () => {
    interface CompositeEntity {
      tenantId: string;
      userId: string;
      name: string;
    }

    class CompositeRepo
      extends BaseRepository<CompositeEntity, { tenantId: string; userId: string }> {
      constructor(dataSource: DataSource) {
        super(dataSource);
      }
    }

    function createCompositeDataSource(): DataSource {
      const records: Record<string, unknown>[] = [];
      return {
        async findAll(query) {
          await Promise.resolve();
          let result = [...records] as Record<string, unknown>[];
          if (Object.keys(query.where).length > 0) {
            result = result.filter((row) => matchesWhere(row, query.where));
          }
          if (query.filter !== undefined) {
            result = result.filter((row) => matchesFilter(row, query.filter!));
          }
          result = applyOrderBy(result, query.orderBy);
          result = applyPagination(result, query.offset, query.limit);
          if (query.select.length > 0) {
            return result.map((row) => projectFields(row, query.select) as Record<string, unknown>);
          }
          return result;
        },
        async findById(id) {
          await Promise.resolve();
          if (typeof id === 'string' || typeof id === 'number') {
            const found = records.find((r) => r.id === id);
            return found ?? null;
          }
          const found = records.find(
            (r) =>
              (r as Record<string, unknown>)['tenantId'] === id['tenantId'] &&
              (r as Record<string, unknown>)['userId'] === id['userId'],
          );
          return found ?? null;
        },
        async create(data) {
          await Promise.resolve();
          const entity = { tenantId: 't1', userId: 'u1', ...data };
          records.push(entity);
          return entity;
        },
        async update(id, data) {
          await Promise.resolve();
          const index = records.findIndex((r) => {
            if (typeof id === 'string' || typeof id === 'number') return r.id === id;
            return (r as Record<string, unknown>)['tenantId'] === id['tenantId'] &&
              (r as Record<string, unknown>)['userId'] === id['userId'];
          });
          if (index === -1) throw new Error('not found');
          records[index] = { ...records[index], ...data };
          return records[index];
        },
        async delete(id) {
          await Promise.resolve();
          const index = records.findIndex((r) => {
            if (typeof id === 'string' || typeof id === 'number') return r.id === id;
            return (r as Record<string, unknown>)['tenantId'] === id['tenantId'] &&
              (r as Record<string, unknown>)['userId'] === id['userId'];
          });
          if (index === -1) return false;
          records.splice(index, 1);
          return true;
        },
        async count(where) {
          await Promise.resolve();
          return records.filter((r) => matchesWhere(r, where)).length;
        },
      };
    }

    it('round-trips findById through a repository declared with a composite key type', async () => {
      const ds = createCompositeDataSource();
      const repo = new CompositeRepo(ds);
      await repo.create({ name: 'Alice' });
      const found = await repo.findById({ tenantId: 't1', userId: 'u1' });
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Alice');
      const missing = await repo.findById({ tenantId: 't2', userId: 'u9' });
      expect(missing).toBeNull();
    });

    it('round-trips update through a repository declared with a composite key type', async () => {
      const ds = createCompositeDataSource();
      const repo = new CompositeRepo(ds);
      await repo.create({ name: 'Alice' });
      const updated = await repo.update({ tenantId: 't1', userId: 'u1' }, { name: 'Alicia' });
      expect(updated.name).toBe('Alicia');
    });

    it('round-trips delete through a repository declared with a composite key type', async () => {
      const ds = createCompositeDataSource();
      const repo = new CompositeRepo(ds);
      await repo.create({ name: 'Alice' });
      expect(await repo.delete({ tenantId: 't1', userId: 'u1' })).toBe(true);
      const found = await repo.findById({ tenantId: 't1', userId: 'u1' });
      expect(found).toBeNull();
      expect(await repo.delete({ tenantId: 't1', userId: 'u1' })).toBe(false);
    });
  });
});

// @ts-expect-error — `Date` is not assignable to `EntityKey` (`string | number | Record<...>`).
// This pins that an out-of-constraint `Id` type is refused at the declaration site.
// A type that is not a subtype of EntityKey (e.g. `Date`, `symbol`, `null`) would be rejected
// by the `Id extends EntityKey` constraint on `IRepository` / `BaseRepository`.
class _BadIdRepo extends BaseRepository<TestEntity, Date> {
  constructor(ds: DataSource) {
    super(ds);
  }
}
