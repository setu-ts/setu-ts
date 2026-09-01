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
import { createDrizzleDatabase, getDrizzleDatabase } from '../../src/index.ts';
import { DRIZZLE_QUERY_HANDLE } from '../../src/query/drizzle-query.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';

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

    it('adds accessPath only for DynamoDB Query and Scan reads', async () => {
      const dynamoLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
      const client: IDynamoClient = {
        query: () => Promise.resolve({ Items: [{ pk: { S: 'query' } }] }),
        scan: () => Promise.resolve({ Items: [{ pk: { S: 'scan' } }] }),
        getItem: () => Promise.resolve({}),
        putItem: () => Promise.resolve({}),
        updateItem: () => Promise.resolve({}),
        deleteItem: () => Promise.resolve({}),
        transactWriteItems: () => Promise.resolve({}),
        destroy() {},
      };
      const dynamoService = new DatabaseService(
        adapter as unknown as IDatabaseAdapter,
        () =>
          createDynamoDataSource(client, 'Item', {
            Item: {
              partitionKey: 'pk',
              indexes: { byStatus: { partitionKey: 'status' } },
            },
          }),
        'dynamodb',
        { logQueries: true },
        {
          debug: (msg: string, meta?: Record<string, unknown>) => {
            dynamoLogs.push(meta === undefined ? { msg } : { msg, meta });
          },
        },
        () => 10,
      );

      const repo = dynamoService.getRepository<Record<string, unknown>>('Item');
      await repo.findAll({ where: { pk: 'query' } });
      await repo.findAll({ where: { status: 'open' } });
      await repo.findAll({ where: { value: 1 } });
      await repo.count({ where: { pk: 'query' } });
      await repo.findPage({ where: { pk: 'query' }, limit: 1 });

      expect(dynamoLogs).toEqual([
        {
          msg: '[Item] findAll',
          meta: { operation: 'findAll', durationMs: 0, accessPath: 'Query' },
        },
        {
          msg: '[Item] findAll',
          meta: { operation: 'findAll', durationMs: 0, accessPath: 'byStatus' },
        },
        {
          msg: '[Item] findAll',
          meta: { operation: 'findAll', durationMs: 0, accessPath: 'Scan' },
        },
        {
          msg: '[Item] count',
          meta: { operation: 'count', durationMs: 0, accessPath: 'Query' },
        },
        {
          msg: '[Item] findPage',
          meta: { operation: 'findPage', durationMs: 0, accessPath: 'Query' },
        },
      ]);

      const memoryRepo = service.getRepository<Record<string, unknown>>('MemoryItem');
      await memoryRepo.findAll();
      const memoryLog = logs.find((entry) => entry.msg === '[MemoryItem] findAll');
      expect(memoryLog?.meta).toBeDefined();
      expect('accessPath' in (memoryLog?.meta ?? {})).toBe(false);
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

    it('keeps a class-based data source working, private state included', async () => {
      // The spread copies own enumerable properties only, so a prototype
      // member is NOT carried. That is deliberate: `Object.create(ds)` would
      // carry it but call it with `this` bound to the wrapper, and a method
      // reading a `#private` field then throws — the M52c detached-method
      // defect. What the contract actually guarantees is the six REQUIRED
      // members, and each override calls `ds.method(...)`, so the receiver and
      // its private state survive. This pins both halves.
      const base = createMemoryDataSource(adapter, 'Proto');

      class ProtoDataSource {
        readonly #marker = 'private-state';
        findAll = base.findAll;
        findById = base.findById;
        create = base.create;
        update = base.update;
        delete = base.delete;
        count = base.count;
        /** Prototype-backed, and reads private state — the hazardous shape. */
        describeShape(): string {
          return `prototype:${this.#marker}`;
        }
      }
      const source = new ProtoDataSource();

      const logging = new DatabaseService(
        adapter as unknown as IDatabaseAdapter,
        () => source as unknown as DataSource,
        'memory',
        { logQueries: true },
        { debug: () => {} },
      );
      const repo = logging.getRepository<{ id: string; qty: number }>('Proto');

      // Every required member still routes through the wrapper to the real
      // instance, so a class-based source is fully usable with logging on.
      await repo.create({ id: 'x1', qty: 4 });
      expect((await repo.findById('x1'))?.qty).toBe(4);
      expect(await repo.count()).toBe(1);

      const wrapped = (repo as unknown as {
        _dataSource: { describeShape?: () => string };
      })._dataSource;
      // The prototype-only extra is not carried — documented, not accidental.
      expect(wrapped.describeShape).toBeUndefined();
      // And it is still callable on the instance itself, which is what proves
      // the member exists and that only the WRAPPER declines to forward it.
      expect(source.describeShape()).toBe('prototype:private-state');
    });
  });

  describe('the outer Drizzle query scope', () => {
    it("refuses an adapter handle reporting 'transaction' scope", () => {
      // The mirror of the refusal M69's review added to `UnitOfWork`: this one
      // guards the OUTER service. An adapter whose handle reports a
      // transaction-scoped query object would hand a caller a native builder
      // bound to a transaction that has already settled, so it is refused by
      // name rather than returned.
      const configured = createDrizzleDatabase(
        createFakeDrizzleInstance(),
        (database, work) => database.transaction(work),
      );
      const misreporting = {
        ...(adapter as unknown as Record<string, unknown>),
        [DRIZZLE_QUERY_HANDLE]: () => ({
          database: configured,
          query: {},
          scope: 'transaction' as const,
        }),
      } as unknown as IDatabaseAdapter;

      const service = new DatabaseService(
        misreporting,
        (entity) => createMemoryDataSource(adapter, entity),
        'drizzle',
      );

      expect(() => getDrizzleDatabase(service, configured)).toThrow(
        "Drizzle query access expected 'outer' scope but received 'transaction' scope.",
      );
    });
  });
});
