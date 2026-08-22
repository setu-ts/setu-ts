/**
 * Coverage tests for DatabaseService repository CRUD and wrapDataSource.
 *
 * Drives getRepository CRUD end-to-end through a memory-backed service
 * and reads writes back. Covers wrapDataSource logging, scoped UoW factory,
 * and the repository-delegation wrapper functions.
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMemoryDataSource, DatabaseService } from '../../src/services/database-service.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IDatabaseAdapter } from '@setu-ts/common';
import type { IUnitOfWork } from '../../src/interfaces/index.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('DatabaseService — CRUD read-back and logging coverage', () => {
  let adapter: MemoryAdapter;
  let logs: Array<{ msg: string; meta?: Record<string, unknown> }>;
  let service: DatabaseService;
  let nowValue = 0;

  beforeEach(async () => {
    logs = [];
    nowValue = 0;
    adapter = new MemoryAdapter();
    await adapter.connect();

    service = new DatabaseService(
      adapter as unknown as IDatabaseAdapter,
      (entity) => createMemoryDataSource(adapter, entity),
      'memory',
      { logQueries: true },
      {
        debug: (msg: string, meta?: Record<string, unknown>) => {
          logs.push(meta === undefined ? { msg } : { msg, meta });
        },
      },
      () => {
        nowValue += 10;
        return nowValue;
      },
    );
  });

  describe('getRepository CRUD read-back', () => {
    it('create then findById returns the created entity', async () => {
      const repo = service.getRepository<Record<string, unknown>>('User');
      const created = await repo.create({ id: 'srv1', name: 'Alice' });
      expect(created.name).toBe('Alice');

      const found = await repo.findById('srv1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Alice');
    });

    it('findAll returns entities after create', async () => {
      const repo = service.getRepository<Record<string, unknown>>('User');
      await repo.create({ id: 'srv2', name: 'A' });
      await repo.create({ id: 'srv3', name: 'B' });

      const all = await repo.findAll();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('update then findById returns changed field', async () => {
      const repo = service.getRepository<Record<string, unknown>>('User');
      await repo.create({ id: 'srv4', name: 'Original' });
      const updated = await repo.update('srv4', { name: 'Updated' });
      expect(updated.name).toBe('Updated');

      const found = await repo.findById('srv4');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Updated');
    });

    it('delete then findById returns null', async () => {
      const repo = service.getRepository<Record<string, unknown>>('User');
      await repo.create({ id: 'srv5', name: 'To Delete' });
      const deleted = await repo.delete('srv5');
      expect(deleted).toBe(true);

      const found = await repo.findById('srv5');
      expect(found).toBeNull();
    });

    it('count returns correct count', async () => {
      const repo = service.getRepository<Record<string, unknown>>('User');
      await repo.create({ id: 'srv6', name: 'X' });
      await repo.create({ id: 'srv7', name: 'Y' });

      const total = await repo.count();
      expect(total).toBeGreaterThanOrEqual(2);
    });

    it('exists returns true for existing entity', async () => {
      const repo = service.getRepository<Record<string, unknown>>('User');
      await repo.create({ id: 'srv8', name: 'X' });
      expect(await repo.exists('srv8')).toBe(true);
      expect(await repo.exists('nonexistent')).toBe(false);
    });
  });

  describe('wrapDataSource logs per operation', () => {
    it('logs debug line for each CRUD operation', async () => {
      logs = [];
      const repo = service.getRepository<Record<string, unknown>>('User');

      await repo.create({ id: 'log1', name: 'A' });
      await repo.findById('log1');
      await repo.findAll();
      await repo.update('log1', { name: 'B' });
      await repo.delete('log1');
      await repo.count();

      expect(logs.length).toBeGreaterThanOrEqual(5);

      const logStrs = logs.map((l) => l.msg);
      expect(logStrs.some((s) => s.includes('create'))).toBe(true);
      expect(logStrs.some((s) => s.includes('findAll'))).toBe(true);
      expect(logStrs.some((s) => s.includes('findById'))).toBe(true);
      expect(logStrs.some((s) => s.includes('update'))).toBe(true);
      expect(logStrs.some((s) => s.includes('delete'))).toBe(true);
      expect(logStrs.some((s) => s.includes('count'))).toBe(true);
    });
  });

  describe('scoped UoW factory', () => {
    it('UoW repositories share transaction scope', async () => {
      const result = await service.transaction(async (uow: IUnitOfWork) => {
        const repo = uow.getRepository<Record<string, unknown>>('User');
        await repo.create({ id: 'uow1', name: 'InUoW' });
        return 'done';
      });
      expect(result).toBe('done');

      const found = await adapter.findEntityById('User', 'uow1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('InUoW');
    });

    it('UoW rollback discards writes', async () => {
      await expect(
        service.transaction(async (uow: IUnitOfWork) => {
          const repo = uow.getRepository<Record<string, unknown>>('User');
          await repo.create({ id: 'uow2', name: 'Rolled' });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');

      const found = await adapter.findEntityById('User', 'uow2');
      expect(found).toBeNull();
    });
  });

  describe('the logging wrapper forwards every data-source argument', () => {
    it('honours a portable filter on count with logQueries on', async () => {
      // `IDataSource.count(where, filter?)` takes TWO parameters. The wrapper
      // declared `count(where)` and called `ds.count(where)`, so the filter was
      // dropped and `logQueries: true` silently changed the answer. Every
      // existing test built the service without logging, which is why it
      // survived.
      const repo = service.getRepository<{ id: string; qty: number }>('Widget');
      await repo.create({ id: 'w1', qty: 1 });
      await repo.create({ id: 'w2', qty: 9 });

      const logged = await repo.count({
        filter: { type: 'comparison', field: 'qty', operator: 'gte', value: 5 },
      });
      expect(logged).toBe(1);
      expect(logs.some((entry) => entry.msg === '[Widget] count')).toBe(true);
    });

    it('answers identically with logging on and off', async () => {
      const quiet = new DatabaseService(
        adapter as unknown as IDatabaseAdapter,
        (entity) => createMemoryDataSource(adapter, entity),
        'memory',
      );
      const loud = service;
      for (const target of [quiet, loud]) {
        const repo = target.getRepository<{ id: string; qty: number }>('Gadget');
        await repo.create({ id: `${target === quiet ? 'q' : 'l'}1`, qty: 1 });
        await repo.create({ id: `${target === quiet ? 'q' : 'l'}2`, qty: 9 });
      }
      const filter = {
        type: 'comparison',
        field: 'qty',
        operator: 'gte',
        value: 5,
      } as const;
      expect(await loud.getRepository('Gadget').count({ filter })).toBe(
        await quiet.getRepository('Gadget').count({ filter }),
      );
    });

    it('passes through a member the required contract does not name', () => {
      // The class behind the `count` defect, not just the instance: the wrapper
      // is an object literal, and a literal satisfies `DataSource` with every
      // OPTIONAL member absent — so the type checker cannot see one going
      // missing. An optional method added to `IDataSource` in `common` would be
      // silently dropped whenever `logQueries: true`, exactly as the `filter`
      // argument was. Spreading the wrapped source makes it total.
      const base = createMemoryDataSource(adapter, 'Extra');
      const extended = Object.assign(Object.create(null) as Record<string, unknown>, base, {
        describeShape: () => 'adapter-specific extra',
      });
      const logging = new DatabaseService(
        adapter as unknown as IDatabaseAdapter,
        () => extended as unknown as DataSource,
        'memory',
        { logQueries: true },
        { debug: () => {} },
      );
      const wrapped = (logging.getRepository('Extra') as unknown as {
        _dataSource: { describeShape?: () => string };
      })._dataSource;

      expect(typeof wrapped.describeShape).toBe('function');
      expect(wrapped.describeShape?.()).toBe('adapter-specific extra');
      // The required members still route through the logging wrapper rather
      // than being handed straight back, so the spread has not bypassed it.
      expect(wrapped).not.toBe(extended);
    });
  });
});
