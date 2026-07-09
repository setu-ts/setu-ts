// deno-lint-ignore-file require-await verbatim-module-syntax -- interface methods must be async; type-only imports
/**
 * DatabaseService — the primary service that adapters register under
 * `CAPABILITIES.DATABASE`.
 *
 * Wraps an {@linkcode IOrmAdapter} and exposes repository access, unit of
 * work, raw queries, and lifecycle management.
 *
 * @module
 */
import type { IOrmAdapter } from '@hono-enterprise/common';
import type { DatabaseAdapterOptions, IDatabaseService, IRepository } from '../interfaces/index.ts';
import type { IUnitOfWork } from '../interfaces/index.ts';
import { BaseRepository, type DataSource } from '../repositories/base-repository.ts';
import { UnitOfWork } from '../unitOfWork/unit-of-work.ts';
import { MemoryAdapter } from '../adapters/memory/memory-adapter.ts';

/**
 * Memory-backed repository implementation that delegates CRUD to the
 * in-memory adapter.
 *
 * @internal
 */
class MemoryRepository<Entity, Id = string> extends BaseRepository<Entity, Id> {
  constructor(dataSource: DataSource) {
    super(dataSource);
  }
}

/**
 * Creates a {@linkcode DataSource} backed by a {@linkcode MemoryAdapter}
 * for the given entity name.
 *
 * @param adapter - The memory adapter instance
 * @param entity - Entity name
 * @param primaryKey - Primary key field
 * @returns A data source bound to the entity
 */
function createMemoryDataSource(
  adapter: MemoryAdapter,
  entity: string,
  primaryKey: string = 'id',
): DataSource {
  adapter.getStore(entity, primaryKey); // Ensure store is initialized
  return {
    async findAll(query) {
      return adapter.queryEntities(entity, query);
    },
    async findById(id) {
      return adapter.findEntityById(entity, id);
    },
    async create(data) {
      return adapter.insertEntity(entity, data);
    },
    async update(id, data) {
      return adapter.updateEntity(entity, id, data);
    },
    async delete(id) {
      return adapter.deleteEntity(entity, id);
    },
    async count(where) {
      return adapter.countEntities(entity, where);
    },
  };
}

/**
 * Database service implementation wrapping an ORM adapter.
 *
 * @since 0.1.0
 */
export class DatabaseService implements IDatabaseService {
  private _closed = false;

  constructor(
    /** The underlying ORM adapter. */
    private readonly _adapter: IOrmAdapter,
    /** Adapter-specific options for logging and tuning. */
    private readonly _options?: DatabaseAdapterOptions,
    /** Optional logger for query logging. */
    private readonly _logger?: { debug(msg: string, meta?: Record<string, unknown>): void },
  ) {}

  /** @inheritdoc */
  getRepository<Entity, Id = string>(entity: string): IRepository<Entity, Id> {
    if (this._closed) {
      throw new Error('DatabaseService is closed');
    }
    const dataSource = this.createDataSource(entity);
    return new MemoryRepository<Entity, Id>(dataSource);
  }

  /** @inheritdoc */
  async transaction<T>(work: (uow: IUnitOfWork) => Promise<T>): Promise<T> {
    if (this._closed) {
      throw new Error('DatabaseService is closed');
    }

    const txn = await this._adapter.beginTransaction();
    try {
      const uow = new UnitOfWork(txn, (entity: string) => {
        const dataSource = this.createDataSource(entity);
        return new MemoryRepository<unknown>(dataSource);
      });
      const result = await work(uow);
      await txn.commit();
      return result;
    } catch (error) {
      await txn.rollback();
      throw error;
    }
  }

  /** @inheritdoc */
  async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    // Raw query support is adapter-specific.
    // Memory adapter returns empty; Prisma/Drizzle adapters implement this.
    if (this._logger && this._options?.logQueries) {
      this._logger.debug('Raw query executed (MemoryAdapter: no-op)', {
        sql: _sql,
        params: _params,
      });
    }
    return [];
  }

  /** @inheritdoc */
  async migrate(): Promise<void> {
    // Memory adapter has no migrations.
  }

  /** @inheritdoc */
  async isHealthy(): Promise<boolean> {
    if (this._closed) return false;
    return this._adapter.isReady();
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this._adapter.disconnect();
  }

  /**
   * Creates a data source for the given entity. The exact implementation
   * depends on the adapter type.
   *
   * @param entity - Entity name
   * @returns Data source for the entity
   */
  private createDataSource(entity: string): DataSource {
    // The MemoryAdapter is the only adapter we have a typed handle for.
    // For Prisma/Drizzle the pattern is the same but the lazy import
    // provides a different adapter instance.
    const memoryAdapter = this._adapter as MemoryAdapter;
    if (typeof memoryAdapter.getStore === 'function') {
      return createMemoryDataSource(memoryAdapter as MemoryAdapter, entity);
    }
    throw new Error(`Unsupported adapter type for entity '${entity}'`);
  }
}
