/**
 * Unit tests for UnitOfWork.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { UnitOfWork } from '../../src/unitOfWork/unit-of-work.ts';
import type { IRepository } from '../../src/interfaces/index.ts';

/** Create a minimal mock repository satisfying IRepository. */
function mockRepo(): IRepository<unknown> {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve({}),
    delete: () => Promise.resolve(false),
    exists: () => Promise.resolve(false),
    count: () => Promise.resolve(0),
  };
}

describe('UnitOfWork', () => {
  it('getRepository returns a repository', () => {
    const repoFactory = () => mockRepo();
    const mockTxn = { commit: () => Promise.resolve(), rollback: () => Promise.resolve() };
    const uow = new UnitOfWork(mockTxn, repoFactory);
    const repo = uow.getRepository('User');
    expect(repo).toBeDefined();
  });

  it('commit calls transaction.commit', async () => {
    let committed = false;
    const mockTxn = {
      commit: () => {
        committed = true;
        return Promise.resolve();
      },
      rollback: () => Promise.resolve(),
    };
    const uow = new UnitOfWork(mockTxn, () => mockRepo());
    await uow.commit();
    expect(committed).toBe(true);
  });

  it('rollback calls transaction.rollback', async () => {
    let rolledBack = false;
    const mockTxn = {
      commit: () => Promise.resolve(),
      rollback: () => {
        rolledBack = true;
        return Promise.resolve();
      },
    };
    const uow = new UnitOfWork(mockTxn, () => mockRepo());
    await uow.rollback();
    expect(rolledBack).toBe(true);
  });

  it('throws when committing twice', async () => {
    const mockTxn = { commit: () => Promise.resolve(), rollback: () => Promise.resolve() };
    const uow = new UnitOfWork(mockTxn, () => mockRepo());
    await uow.commit();
    await expect(uow.commit()).rejects.toThrow('already finalized');
  });

  it('throws when rolling back after commit', async () => {
    const mockTxn = { commit: () => Promise.resolve(), rollback: () => Promise.resolve() };
    const uow = new UnitOfWork(mockTxn, () => mockRepo());
    await uow.commit();
    await expect(uow.rollback()).rejects.toThrow('already finalized');
  });

  it('throws when committing after rollback', async () => {
    const mockTxn = { commit: () => Promise.resolve(), rollback: () => Promise.resolve() };
    const uow = new UnitOfWork(mockTxn, () => mockRepo());
    await uow.rollback();
    await expect(uow.commit()).rejects.toThrow('already finalized');
  });
});
