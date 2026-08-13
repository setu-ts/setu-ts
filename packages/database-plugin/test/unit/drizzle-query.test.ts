// deno-lint-ignore-file require-await -- structural service doubles implement async contracts
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAdapterTransaction, IDatabaseAdapter } from '@setu-ts/common';
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
import { createDrizzleDatabase, getDrizzle } from '../../src/index.ts';
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
    getRepository: <Entity, Id = string>(): IRepository<Entity, Id> => {
      throw new Error('unused');
    },
    transaction: <T>(): Promise<T> => Promise.reject(new Error('unused')),
    query: <T>(): Promise<T[]> => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    isHealthy: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

describe('getDrizzle', () => {
  it('returns the identical configured instance and callback-scoped transaction', async () => {
    const fakeDb = createFakeDrizzleInstance();
    const database = createDrizzleDatabase(fakeDb);
    const adapter = new DrizzleAdapter({
      drizzleInstance: database,
      drizzleTables: { User: createFakeDrizzleTable('user') },
    });
    await adapter.connect();
    const service = adapterService(adapter, 'drizzle');

    expect(getDrizzle(service, database)).toBe(fakeDb);
    await service.transaction(async (uow: IUnitOfWork) => {
      expect(getDrizzle(uow, database)).toBe(fakeDb);
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
      const database = createDrizzleDatabase(createFakeDrizzleInstance());
      expect(() => getDrizzle(adapterService(adapter, type), database)).toThrow(expected);
      expect(() =>
        getDrizzle(
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
    const database = createDrizzleDatabase(createFakeDrizzleInstance());
    expect(() => getDrizzle(externalService(), database)).toThrow(invalid);
    const externalUow: IUnitOfWork = {
      getRepository: <Entity, Id = string>(): IRepository<Entity, Id> => {
        throw new Error('unused');
      },
    };
    expect(() => getDrizzle(externalUow, database)).toThrow(invalid);
    expect(() => getDrizzle(null as unknown as IDatabaseService, database)).toThrow(invalid);
    expect(() => getDrizzle('database' as unknown as IDatabaseService, database)).toThrow(invalid);
    expect(() => getDrizzle((() => undefined) as unknown as IDatabaseService, database)).toThrow(
      invalid,
    );
  });

  it('rejects a witness belonging to another configured database', async () => {
    const first = createFakeDrizzleInstance();
    const second = createFakeDrizzleInstance();
    const firstDatabase = createDrizzleDatabase(first);
    const secondDatabase = createDrizzleDatabase(second);
    const adapter = new DrizzleAdapter({
      drizzleInstance: firstDatabase,
      drizzleTables: { User: createFakeDrizzleTable('user') },
    });
    await adapter.connect();
    const service = adapterService(adapter, 'drizzle');

    expect(() => getDrizzle(service, secondDatabase)).toThrow(
      'Drizzle query access requires the witness configured for this database scope.',
    );
  });
});
