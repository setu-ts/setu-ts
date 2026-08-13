// deno-lint-ignore-file require-await -- interface methods must be async
/**
 * Unit tests for UnitOfWork.
 *
 * Tests cover:
 * - getRepository returns a repository built from scoped factory
 * - commit calls transaction.commit
 * - rollback calls transaction.rollback
 * - double commit/rollback throws
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { UnitOfWork } from '../../src/unitOfWork/unit-of-work.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import type { IRepository } from '../../src/interfaces/index.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { BaseRepository } from '../../src/repositories/base-repository.ts';
import { createDrizzleDatabase, getDrizzleTransaction } from '../../src/index.ts';
import {
  DRIZZLE_QUERY_HANDLE,
  type NativeDrizzleQueryHandle,
} from '../../src/query/drizzle-query.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';

function mockDataSource(): DataSource {
  return {
    async findAll() {
      return [];
    },
    async findById() {
      return null;
    },
    async create(data) {
      return data;
    },
    async update(_id, data) {
      return data;
    },
    async delete() {
      return true;
    },
    async count() {
      return 0;
    },
  };
}

function mockRepoFactory(): (entity: string) => IRepository<unknown> {
  return (_entity: string): IRepository<unknown> => {
    return new (class extends BaseRepository<unknown> {
      constructor() {
        super(mockDataSource());
      }
    })();
  };
}

describe('UnitOfWork', () => {
  it('preserves the two-argument constructor and rejects typed access as an external scope', () => {
    const txn: IAdapterTransaction = {
      async commit() {},
      async rollback() {},
      createDataSource: mockDataSource,
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    expect(uow.getRepository('User')).toBeDefined();
    const database = createDrizzleDatabase(
      createFakeDrizzleInstance(),
      (configured, work) => configured.transaction(work),
    );
    expect(() => getDrizzleTransaction(uow, database)).toThrow(
      'Drizzle query access requires a database-plugin service or unit of work.',
    );
  });

  it('returns the transaction native handle for a Drizzle Unit of Work', () => {
    const native = { kind: 'native-tx' };
    const database = createDrizzleDatabase(
      createFakeDrizzleInstance(),
      (configured, work) => configured.transaction(work),
    );
    const txn: IAdapterTransaction & {
      [DRIZZLE_QUERY_HANDLE](): NativeDrizzleQueryHandle;
    } = {
      async commit() {},
      async rollback() {},
      createDataSource: mockDataSource,
      [DRIZZLE_QUERY_HANDLE]: () => ({
        database,
        query: native,
        scope: 'transaction',
      }),
    };
    const uow = new UnitOfWork(txn, mockRepoFactory(), 'drizzle');
    expect(getDrizzleTransaction(uow, database)).toBe(native);
  });

  // The public constructor accepts any ITransaction, so a caller can hand it a
  // provider that reports the OUTER scope — the adapter itself is one. Returning
  // that object would silently escape the transaction: writes would commit
  // immediately and survive a rollback, which is the one guarantee this seam
  // exists to provide.
  it('refuses a transaction handle that reports the outer scope', () => {
    const database = createDrizzleDatabase(
      createFakeDrizzleInstance(),
      (configured, work) => configured.transaction(work),
    );
    const outerScoped: IAdapterTransaction & {
      [DRIZZLE_QUERY_HANDLE](): NativeDrizzleQueryHandle;
    } = {
      async commit() {},
      async rollback() {},
      createDataSource: mockDataSource,
      [DRIZZLE_QUERY_HANDLE]: () => ({
        database,
        query: { kind: 'outer-database' },
        scope: 'outer',
      }),
    };

    const uow = new UnitOfWork(outerScoped, mockRepoFactory(), 'drizzle');

    expect(() => getDrizzleTransaction(uow, database)).toThrow(
      "Drizzle query access expected 'transaction' scope but received 'outer' scope.",
    );
  });
  it('getRepository returns a repository', () => {
    const txn: IAdapterTransaction = {
      async commit() {},
      async rollback() {},
      createDataSource(): DataSource {
        return mockDataSource();
      },
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    const repo = uow.getRepository('User');
    expect(repo).toBeDefined();
  });

  it('commit calls transaction.commit', async () => {
    let committed = false;
    const txn: IAdapterTransaction = {
      async commit() {
        committed = true;
      },
      async rollback() {},
      createDataSource(): DataSource {
        return mockDataSource();
      },
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    await uow.commit();
    expect(committed).toBe(true);
  });

  it('rollback calls transaction.rollback', async () => {
    let rolledBack = false;
    const txn: IAdapterTransaction = {
      async commit() {},
      async rollback() {
        rolledBack = true;
      },
      createDataSource(): DataSource {
        return mockDataSource();
      },
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    await uow.rollback();
    expect(rolledBack).toBe(true);
  });

  it('throws when committing twice', async () => {
    const txn: IAdapterTransaction = {
      async commit() {},
      async rollback() {},
      createDataSource(): DataSource {
        return mockDataSource();
      },
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    await uow.commit();
    await expect(uow.commit()).rejects.toThrow();
  });

  it('throws when rolling back after commit', async () => {
    const txn: IAdapterTransaction = {
      async commit() {},
      async rollback() {},
      createDataSource(): DataSource {
        return mockDataSource();
      },
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    await uow.commit();
    await expect(uow.rollback()).rejects.toThrow();
  });

  it('throws when committing after rollback', async () => {
    const txn: IAdapterTransaction = {
      async commit() {},
      async rollback() {},
      createDataSource(): DataSource {
        return mockDataSource();
      },
    };
    const uow = new UnitOfWork(txn, mockRepoFactory());
    await uow.rollback();
    await expect(uow.commit()).rejects.toThrow();
  });
});
