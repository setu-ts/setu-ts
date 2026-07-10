/**
 * DatabaseService — the primary service that adapters register under
 * `CAPABILITIES.DATABASE`.
 *
 * Wraps an {@linkcode IDatabaseAdapter} and exposes repository access,
 * unit-of-work transactions, raw queries, and lifecycle management.
 *
 * The service owns the **single** query-logging wrapper: every data-source
 * operation (both service-level repositories AND UoW-scoped ones) passes
 * through {@linkcode wrapDataSource}, which logs entity, operation, and
 * monotonic duration when `logQueries` is enabled.
 *
 * @module
 */
import type { DatabaseAdapterOptions, IDatabaseService, IRepository } from '../interfaces/index.ts';
import type { IUnitOfWork } from '../interfaces/index.ts';
import { BaseRepository, type DataSource } from '../repositories/base-repository.ts';
import { UnitOfWork } from '../unitOfWork/unit-of-work.ts';
import type { DatabaseAdapterType } from '../interfaces/index.ts';
import type { IDatabaseAdapter } from '../adapters/adapter.ts';

// ---------------------------------------------------------------------------
// Internal generic repository (was `MemoryRepository` — renamed because it
// serves ALL adapter types, not only memory).
// ---------------------------------------------------------------------------

/**
 * Internal repository implementation that delegates CRUD to a
 * {@linkcode DataSource}.
 *
 * @internal
 */
class InternalRepo<Entity, Id = string> extends BaseRepository<Entity, Id> {
  constructor(dataSource: DataSource) {
    super(dataSource);
  }
}

// ---------------------------------------------------------------------------
// DatabaseService
// ---------------------------------------------------------------------------

/**
 * Database service implementation wrapping an ORM adapter.
 *
 * @since 0.1.0
 */
export class DatabaseService implements IDatabaseService {
  private _closed = false;

  constructor(
    /** The underlying database adapter (internal contract with scoped tx factory). */
    private readonly _adapter: IDatabaseAdapter,
    /** Factory that creates a DataSource for a named entity (non-transactional). */
    private readonly _createDataSource: (entity: string) => DataSource,
    /** The adapter type (used for unsupported-operation checks). */
    private readonly _adapterType: DatabaseAdapterType,
    /** Adapter-specific options for logging and tuning. */
    private readonly _options?: DatabaseAdapterOptions,
    /** Optional logger for query logging. */
    private readonly _logger?: { debug(msg: string, meta?: Record<string, unknown>): void },
    /** Monotonic clock — injected from `ctx.runtime.hrtime()`. NEVER `Date.now()`. */
    private readonly _now: () => number = (): number => {
      // Fallback for tests that do not inject; uses the global monotonic clock.
      return typeof performance !== 'undefined' ? performance.now() : 0;
    },
  ) {}

  /** @inheritdoc */
  getRepository<Entity, Id = string>(entity: string): IRepository<Entity, Id> {
    if (this._closed) {
      throw new Error('DatabaseService is closed');
    }
    const dataSource = this.wrapDataSource(entity, this._createDataSource(entity));
    return new InternalRepo<Entity, Id>(dataSource);
  }

  /** @inheritdoc */
  async transaction<T>(work: (uow: IUnitOfWork) => Promise<T>): Promise<T> {
    if (this._closed) {
      throw new Error('DatabaseService is closed');
    }

    const txn = await this._adapter.beginTransaction();
    try {
      const uow = new UnitOfWork(
        txn,
        (entity: string) => {
          const scopedDs = txn.createDataSource(entity);
          return new InternalRepo<unknown>(this.wrapDataSource(entity, scopedDs));
        },
      );
      const result = await work(uow);
      await txn.commit();
      return result;
    } catch (error) {
      await txn.rollback();
      throw error;
    }
  }

  /** @inheritdoc */
  query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (this._adapterType === 'memory') {
      throw new Error('The memory adapter does not support raw SQL queries.');
    }
    return this._adapter.rawQuery<T>(sql, params);
  }

  /** @inheritdoc */
  migrate(): Promise<void> {
    return Promise.reject(
      new Error('Programmatic migrations are not supported by the current database adapters.'),
    );
  }

  /** @inheritdoc */
  isHealthy(): Promise<boolean> {
    if (this._closed) return Promise.resolve(false);
    return Promise.resolve(this._adapter.isReady());
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this._adapter.disconnect();
  }

  /**
   * Wrap a data-source so that every CRUD op is logged with entity, operation,
   * and monotonic duration when `logQueries` is enabled.
   *
   * When disabled or no logger available, returns the original data source.
   *
   * @param entity - Entity name
   * @param ds - Underlying data source
   * @returns Wrapped (or original) data source
   */
  private wrapDataSource(entity: string, ds: DataSource): DataSource {
    const enabled = this._options?.logQueries === true && this._logger !== undefined;
    if (!enabled) return ds;

    const logger = this._logger;
    const now = this._now;

    return {
      async findAll(query) {
        const start = now();
        const result = await ds.findAll(query);
        logger.debug(`[${entity}] findAll`, { operation: 'findAll', durationMs: now() - start });
        return result;
      },
      async findById(id) {
        const start = now();
        const result = await ds.findById(id);
        logger.debug(`[${entity}] findById`, { operation: 'findById', durationMs: now() - start });
        return result;
      },
      async create(data) {
        const start = now();
        const result = await ds.create(data);
        logger.debug(`[${entity}] create`, { operation: 'create', durationMs: now() - start });
        return result;
      },
      async update(id, data) {
        const start = now();
        const result = await ds.update(id, data);
        logger.debug(`[${entity}] update`, { operation: 'update', durationMs: now() - start });
        return result;
      },
      async delete(id) {
        const start = now();
        const result = await ds.delete(id);
        logger.debug(`[${entity}] delete`, { operation: 'delete', durationMs: now() - start });
        return result;
      },
      async count(where) {
        const start = now();
        const result = await ds.count(where);
        logger.debug(`[${entity}] count`, { operation: 'count', durationMs: now() - start });
        return result;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Memory data-source factory (kept here since memory adapter exposes its own
// CRUD methods directly rather than a generic IEntityDataSource).
// ---------------------------------------------------------------------------

/**
 * Creates a {@linkcode DataSource} backed by a {@linkcode MemoryAdapter}
 * for the given entity name.
 *
 * @param adapter - The memory adapter instance
 * @param entity - Entity name
 * @param primaryKey - Primary key field
 * @returns A data source bound to the entity
 */
export function createMemoryDataSource(
  adapter: import('../adapters/memory/memory-adapter.ts').MemoryAdapter,
  entity: string,
  primaryKey: string = 'id',
): DataSource {
  adapter.getStore(entity, primaryKey); // Ensure store is initialized
  return {
    findAll: (query) => adapter.queryEntities(entity, query),
    findById: (id) => adapter.findEntityById(entity, id),
    create: (data) => adapter.insertEntity(entity, data),
    update: (id, data) => adapter.updateEntity(entity, id, data),
    delete: (id) => adapter.deleteEntity(entity, id),
    count: (where) => adapter.countEntities(entity, where),
  };
}
