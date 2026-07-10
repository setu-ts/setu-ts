/**
 * Unit of Work implementation wrapping an {@linkcode ITransaction} and
 * providing transaction-scoped repository access.
 *
 * @module
 */
import type { ITransaction } from '@hono-enterprise/common';
import type { IRepository, IUnitOfWork } from '../interfaces/index.ts';

/**
 * Concrete Unit of Work that holds a transaction and delegates repository
 * creation to the database service within the transaction boundary.
 *
 * @since 0.1.0
 */
export class UnitOfWork implements IUnitOfWork {
  private _committed = false;
  private _rolledBack = false;

  constructor(
    /** The underlying transaction handle from the adapter. */
    private readonly _transaction: ITransaction,
    /** Factory that creates a repository for the given entity name. */
    private readonly _repoFactory: (entity: string) => IRepository<unknown>,
  ) {}

  /** @inheritdoc */
  getRepository<Entity, Id = string>(entity: string): IRepository<Entity, Id> {
    return this._repoFactory(entity) as IRepository<Entity, Id>;
  }

  /**
   * Commit the transaction. Must be called after all operations complete.
   *
   * @throws {Error} If already committed or rolled back
   */
  async commit(): Promise<void> {
    if (this._committed || this._rolledBack) {
      throw new Error('Transaction already finalized');
    }
    await this._transaction.commit();
    this._committed = true;
  }

  /**
   * Roll back the transaction. Called automatically by {@linkcode DatabaseService}
   * on errors, but can also be called explicitly.
   *
   * @throws {Error} If already committed or rolled back
   */
  async rollback(): Promise<void> {
    if (this._committed || this._rolledBack) {
      throw new Error('Transaction already finalized');
    }
    await this._transaction.rollback();
    this._rolledBack = true;
  }
}
