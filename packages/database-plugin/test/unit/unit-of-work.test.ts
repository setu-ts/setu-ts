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
import type { IAdapterTransaction } from '../../src/adapters/adapter.ts';
import type { IRepository } from '../../src/interfaces/index.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { BaseRepository } from '../../src/repositories/base-repository.ts';

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
