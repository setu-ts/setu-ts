// deno-lint-ignore-file require-await -- structural service doubles implement async contracts
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey, IAdapterTransaction, IDatabaseAdapter } from '@setu-ts/common';
import type {
  DatabaseAdapterType,
  IDatabaseService,
  IRepository,
  IUnitOfWork,
} from '../../src/interfaces/index.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import { UnitOfWork } from '../../src/unitOfWork/unit-of-work.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import {
  createDrizzleDatabase,
  type DrizzleDatabase,
  getDrizzleDatabase,
  getDrizzleTransaction,
} from '../../src/index.ts';
import { DRIZZLE_QUERY_HANDLE } from '../../src/query/drizzle-query.ts';
import { isDrizzleDatabase, readDrizzleDatabase } from '../../src/query/drizzle-database.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

function emptySource(): DataSource {
  return {
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    create: (data) => Promise.resolve(data),
    update: (_id, data) => Promise.resolve(data),
    delete: () => Promise.resolve(false),
    count: () => Promise.resolve(0),
  };
}

function adapterService(adapter: IDatabaseAdapter, type: DatabaseAdapterType): DatabaseService {
  return new DatabaseService(adapter, () => emptySource(), type);
}

function transaction(): IAdapterTransaction {
  const handle: IAdapterTransaction = {
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    createDataSource: () => emptySource(),
  };
  return handle;
}

function externalService(): IDatabaseService {
  return {
    getRepository: <Entity, Id extends EntityKey = string>(): IRepository<Entity, Id> => {
      throw new Error('unused');
    },
    transaction: <T>(): Promise<T> => Promise.reject(new Error('unused')),
    query: <T>(): Promise<T[]> => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    isHealthy: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

describe('typed Drizzle accessors', () => {
  it('returns the identical configured instance and callback-scoped transaction', async () => {
    const fakeDb = createFakeDrizzleInstance();
    const database = createDrizzleDatabase(fakeDb, (database, work) => database.transaction(work));
    const adapter = new DrizzleAdapter({
      drizzleInstance: database,
      drizzleTables: { User: createFakeDrizzleTable('user') },
    });
    await adapter.connect();
    const service = adapterService(adapter, 'drizzle');

    expect(getDrizzleDatabase(service, database)).toBe(fakeDb);
    await service.transaction(async (uow: IUnitOfWork) => {
      expect(getDrizzleTransaction(uow, database)).toBe(fakeDb);
    });
  });

  for (const type of ['memory', 'prisma', 'custom'] as const) {
    it(`names '${type}' on service and Unit-of-Work failures`, () => {
      const adapter: IDatabaseAdapter = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        isReady: () => true,
        createDataSource: () => emptySource(),
        beginTransaction: () => Promise.resolve(transaction()),
        rawQuery: <T>() => Promise.resolve([] as T[]),
      };
      const expected =
        `Drizzle query access requires adapter 'drizzle'; configured adapter is '${type}'.`;
      const database = createDrizzleDatabase(
        createFakeDrizzleInstance(),
        (configured, work) => configured.transaction(work),
      );
      expect(() => getDrizzleDatabase(adapterService(adapter, type), database)).toThrow(expected);
      expect(() =>
        getDrizzleTransaction(
          new UnitOfWork(transaction(), () => {
            throw new Error('unused');
          }, type),
          database,
        )
      ).toThrow(expected);
    });
  }

  it('rejects external structural service and Unit-of-Work scopes', () => {
    const invalid = 'Drizzle query access requires a database-plugin service or unit of work.';
    const database = createDrizzleDatabase(
      createFakeDrizzleInstance(),
      (configured, work) => configured.transaction(work),
    );
    expect(() => getDrizzleDatabase(externalService(), database)).toThrow(invalid);
    const externalUow: IUnitOfWork = {
      getRepository: <Entity, Id extends EntityKey = string>(): IRepository<Entity, Id> => {
        throw new Error('unused');
      },
    };
    expect(() => getDrizzleTransaction(externalUow, database)).toThrow(invalid);
    expect(() => getDrizzleDatabase(null as unknown as IDatabaseService, database)).toThrow(
      invalid,
    );
    expect(() => getDrizzleDatabase('database' as unknown as IDatabaseService, database)).toThrow(
      invalid,
    );
    expect(() => getDrizzleDatabase((() => undefined) as unknown as IDatabaseService, database))
      .toThrow(
        invalid,
      );
  });

  it('keeps widened services runtime-truthful as outer scopes', async () => {
    const fakeDb = createFakeDrizzleInstance();
    const database = createDrizzleDatabase(
      fakeDb,
      (configured, work) => configured.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: database,
      drizzleTables: { User: createFakeDrizzleTable('user') },
    });
    await adapter.connect();
    const service: IUnitOfWork = adapterService(adapter, 'drizzle');

    expect(() => getDrizzleTransaction(service, database)).toThrow(
      "Drizzle query access expected 'transaction' scope but received 'outer' scope.",
    );
  });

  it('rejects mutation, spread, assignment, prototype, and clone lookalikes', async () => {
    const fakeDb = createFakeDrizzleInstance();
    const database = createDrizzleDatabase(
      fakeDb,
      (configured, work) => configured.transaction(work),
    );
    const invalid =
      'DrizzleAdapter requires options.drizzleInstance to be created by createDrizzleDatabase().';

    expect(Object.isFrozen(database)).toBe(true);
    expect(Object.getPrototypeOf(database)).toBeNull();
    expect(Reflect.set(database, 'database', fakeDb)).toBe(false);
    expect(() => Object.assign(database, { database: fakeDb })).toThrow();

    const lookalikes: unknown[] = [
      { ...database },
      Object.assign({}, database),
      Object.create(database),
      Object.create(null),
      structuredClone(database),
    ];
    for (const lookalike of lookalikes) {
      const adapter = new DrizzleAdapter({
        drizzleInstance: lookalike as DrizzleDatabase<object>,
        drizzleTables: { User: createFakeDrizzleTable('user') },
      });
      await expect(adapter.connect()).rejects.toThrow(invalid);
    }
  });

  it('rejects non-object configuration values before private-state lookup', async () => {
    const invalid =
      'DrizzleAdapter requires options.drizzleInstance to be created by createDrizzleDatabase().';
    for (const value of ['database', true, 1]) {
      const adapter = new DrizzleAdapter({
        drizzleInstance: value as unknown as DrizzleDatabase<object>,
        drizzleTables: { User: createFakeDrizzleTable('user') },
      });
      await expect(adapter.connect()).rejects.toThrow(invalid);
    }
  });

  it('rejects every unconfigured Promise-adopting or thenable wrapper before native work', async () => {
    const fakeDb = createFakeDrizzleInstance();
    const variants = [
      'distinct Promise',
      'then chain',
      'Promise.resolve',
      'custom thenable',
      'async wrapper',
    ] as const;

    for (const variant of variants) {
      let unitOfWorkEntered = false;
      const unsafe = {
        ...fakeDb,
        transaction(work: (transaction: typeof fakeDb) => Promise<void>): Promise<void> {
          unitOfWorkEntered = true;
          const result = work(fakeDb);
          switch (variant) {
            case 'distinct Promise':
              return new Promise((resolve, reject) => result.then(resolve, reject));
            case 'then chain':
              return result.then(() => undefined);
            case 'Promise.resolve':
              return Promise.resolve(result);
            case 'custom thenable':
              return Promise.resolve({ then: result.then.bind(result) });
            case 'async wrapper':
              return (async (): Promise<void> => await result)();
          }
        },
      };
      const adapter = new DrizzleAdapter({
        drizzleInstance: unsafe as unknown as DrizzleDatabase<object>,
        drizzleTables: { User: createFakeDrizzleTable('user') },
      });

      await expect(adapter.connect()).rejects.toThrow(
        'options.drizzleInstance to be created by createDrizzleDatabase()',
      );
      expect(unitOfWorkEntered).toBe(false);
    }
  });

  it('rejects a witness belonging to another configured database', async () => {
    const first = createFakeDrizzleInstance();
    const second = createFakeDrizzleInstance();
    const firstDatabase = createDrizzleDatabase(
      first,
      (configured, work) => configured.transaction(work),
    );
    const secondDatabase = createDrizzleDatabase(
      second,
      (configured, work) => configured.transaction(work),
    );
    const adapter = new DrizzleAdapter({
      drizzleInstance: firstDatabase,
      drizzleTables: { User: createFakeDrizzleTable('user') },
    });
    await adapter.connect();
    const service = adapterService(adapter, 'drizzle');

    expect(() => getDrizzleDatabase(service, secondDatabase)).toThrow(
      'Drizzle query access requires the configuration registered for this database scope.',
    );
  });

  // A scope that implements the internal symbol but answers with a handle this
  // package never built is not a plugin scope. Accepting it would let an
  // arbitrary object nominate any value as "the configured database", which is
  // the whole reason the handle carries a registered identity rather than a
  // plain object.
  it('rejects a scope whose internal handle is not package-created', () => {
    const database = createDrizzleDatabase(
      createFakeDrizzleInstance(),
      (configured, work) => configured.transaction(work),
    );
    const forgedHandles = [
      // A structural look-alike identity that was never registered.
      { database: { forged: true }, query: { kind: 'native' }, scope: 'outer' },
      // A registered identity carrying a scope this package never emits.
      { database, query: { kind: 'native' }, scope: 'sideways' },
      // No handle at all.
      null,
    ];

    for (const forged of forgedHandles) {
      const scope = {
        ...externalService(),
        [DRIZZLE_QUERY_HANDLE]: () => forged,
      } as unknown as IDatabaseService;

      expect(() => getDrizzleDatabase(scope, database)).toThrow(
        'Drizzle query access requires a database-plugin service or unit of work.',
      );
    }
  });
});

describe('drizzle configuration registry', () => {
  // `readDrizzleDatabase` and `isDrizzleDatabase` both accept functions as
  // candidate keys, because a WeakMap does. A function is the one object type
  // an application could plausibly hand over by mistake — a driver factory
  // rather than the driver — so both paths need to reject rather than throw a
  // bare TypeError.
  it('rejects function and null candidates that were never registered', () => {
    const unregisteredFunction = (): void => {};

    expect(isDrizzleDatabase(unregisteredFunction)).toBe(false);
    expect(isDrizzleDatabase(null)).toBe(false);
    expect(() => readDrizzleDatabase(unregisteredFunction)).toThrow(
      'DrizzleAdapter requires options.drizzleInstance to be created by createDrizzleDatabase().',
    );
    expect(() => readDrizzleDatabase(null)).toThrow(
      'DrizzleAdapter requires options.drizzleInstance to be created by createDrizzleDatabase().',
    );
  });

  it('recognises a registered configuration through the same predicate', () => {
    const database = createDrizzleDatabase(
      createFakeDrizzleInstance(),
      (configured, work) => configured.transaction(work),
    );

    expect(isDrizzleDatabase(database)).toBe(true);
    expect(readDrizzleDatabase(database).database).toBeDefined();
  });
});
