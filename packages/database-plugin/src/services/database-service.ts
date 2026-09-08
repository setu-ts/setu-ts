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
import type {
  EntityKey,
  IDatabaseAdapter,
  NormalizedQuery,
  PageResult,
  TransactionOptions,
} from '@setu-ts/common';
import {
  assertDrizzleAdapter,
  DRIZZLE_QUERY_HANDLE,
  type NativeDrizzleQueryHandle,
  readDrizzleQueryHandle,
} from '../query/drizzle-query.ts';
import type { IDynamoAccessPathReportingDataSource } from '../adapters/dynamo/dynamo-data-source.ts';
import {
  DatabaseUnavailableError,
  SerializationConflictError,
  UnsupportedIsolationLevelError,
  UnsupportedMigrationError,
  UnsupportedRawQueryError,
} from '../errors.ts';
import { classifyDriverError } from '../errors/classify.ts';

/**
 * Reads DynamoDB's optional access-path diagnostic without widening the
 * portable data-source contract all adapters implement.
 */
function accessPathOf(dataSource: DataSource): string | undefined {
  const reporter = dataSource as DataSource & Partial<IDynamoAccessPathReportingDataSource>;
  return reporter.getLastAccessPath?.();
}

/**
 * Maps a driver rejection onto the package-owned classified error
 * (X38-1/X35-2, M90f), or returns the ORIGINAL when no signal matches.
 *
 * The classifier returns a KIND; the caller-facing object is built HERE,
 * carrying the driver error as `cause` so the operator's diagnostic — the
 * SQLSTATE, the statement — stays reachable for the log while the served
 * `detail` stays the class's fixed sentence.
 */
function classifiedOrOriginal(error: unknown, adapterType: DatabaseAdapterType): unknown {
  const kind = classifyDriverError(error, adapterType);
  if (kind === 'conflict') {
    return new SerializationConflictError(
      'The database rejected the write because a concurrent transaction changed the same data.',
      { cause: error },
    );
  }
  if (kind === 'unavailable') {
    return new DatabaseUnavailableError(
      'The database or its connection pool is temporarily unavailable.',
      { cause: error },
    );
  }
  return error;
}

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
class InternalRepo<Entity, Id extends EntityKey = string> extends BaseRepository<Entity, Id> {
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

  /** Creates a database service over one adapter and repository data-source factory. */
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

  /** Returns a repository bound to the named entity on the outer database scope. */
  getRepository<Entity, Id extends EntityKey = string>(entity: string): IRepository<Entity, Id> {
    if (this._closed) {
      throw new Error('DatabaseService is closed');
    }
    const dataSource = this.wrapDataSource(entity, this._createDataSource(entity));
    return new InternalRepo<Entity, Id>(dataSource);
  }

  /** Provide the configured native Drizzle instance through the internal protocol. */
  [DRIZZLE_QUERY_HANDLE](): NativeDrizzleQueryHandle {
    assertDrizzleAdapter(this._adapterType);
    const handle = readDrizzleQueryHandle(this._adapter);
    if (handle.scope !== 'outer') {
      throw new Error(
        "Drizzle query access expected 'outer' scope but received 'transaction' scope.",
      );
    }
    return handle;
  }

  /** @inheritdoc */
  async transaction<T>(
    work: (uow: IUnitOfWork) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    if (this._closed) {
      throw new Error('DatabaseService is closed');
    }
    if (
      options?.isolation !== undefined &&
      !this._adapter.transactionIsolationLevels?.includes(options.isolation)
    ) {
      throw new UnsupportedIsolationLevelError(this._adapterType, options.isolation);
    }

    // X35-2 (M90f): the acquisition sits OUTSIDE the try below, so a
    // connection-pool timeout — raised exactly here — never reached that
    // catch, and a classifier placed only there would leave the headline
    // row unfixed. The acquisition is classified itself.
    const txn = await this._adapter.beginTransaction(options).catch((error: unknown): never => {
      throw classifiedOrOriginal(error, this._adapterType);
    });
    let committing = false;
    try {
      const uow = new UnitOfWork(
        txn,
        (entity: string) => {
          const scopedDs = txn.createDataSource(entity);
          return new InternalRepo<unknown>(this.wrapDataSource(entity, scopedDs));
        },
        this._adapterType,
      );
      const result = await work(uow);
      committing = true;
      await txn.commit();
      return result;
    } catch (error) {
      // The primary operation error determines the client response. A lost
      // connection commonly makes rollback fail too; that secondary failure
      // must not replace the classified cause.
      await txn.rollback().catch(() => {});
      // A commit rejection can mean the server applied the write before its
      // acknowledgement was lost. Its outcome is unknown, so never advertise
      // the retry-safe contract reserved for definitely rejected operations.
      if (committing) throw error;
      // X38-1 (M90f): a conflict surfaced inside a repository call was
      // already classified by the `wrapDataSource` wrapper, and
      // `classifyDriverError` returns `null` for a package-owned error — so
      // it is rethrown verbatim and the caller's `cause` stays the driver
      // error, never the first wrapper.
      throw classifiedOrOriginal(error, this._adapterType);
    }
  }

  /**
   * @inheritdoc
   *
   * The memory adapter rejects with {@linkcode UnsupportedRawQueryError}, so
   * every refusal from this `Promise`-returning method is observable through
   * either `await` or `.catch()`.
   */
  query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (this._adapterType === 'memory') {
      return Promise.reject(
        new UnsupportedRawQueryError(
          'memory',
          'The memory adapter does not support raw SQL queries.',
        ),
      );
    }
    // X38-1/X35-2 (M90f): a raw statement reaches the driver with no
    // wrapper around it — the fourth interception site.
    return this._adapter.rawQuery<T>(sql, params).catch((error: unknown): never => {
      throw classifiedOrOriginal(error, this._adapterType);
    });
  }

  /** @inheritdoc */
  migrate(): Promise<void> {
    return Promise.reject(
      new UnsupportedMigrationError(
        'Programmatic migrations are not supported by the current database adapters.',
      ),
    );
  }

  /**
   * Reports whether {@linkcode close} has run — a LIFECYCLE-only read that
   * reaches no adapter and performs no I/O (M90b).
   *
   * `isHealthy()` answers two questions at once: the service's own lifecycle
   * AND the adapter's readiness. The `database` health indicator gates on
   * lifecycle uncached — a closed database must read `down` immediately,
   * never from an outcome cached before close — and bounds the adapter
   * question inside its cached probe. Reading `isHealthy()` for the gate
   * therefore called the adapter on the ONE path that is deliberately
   * outside that bound, and made a poll cost two readiness reads instead of
   * one. This is the gate.
   *
   * @returns `true` once the service has been closed
   * @since 0.5.0
   */
  get isClosed(): boolean {
    return this._closed;
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
   * and monotonic duration when `logQueries` is enabled, and every driver
   * rejection is classified onto a caller-actionable package error (M90f,
   * X38-1/X35-2) — ALWAYS, not only when logging is on.
   *
   * The classification is not a logging feature: the default configuration
   * has `logQueries` off, and a conflict that only became a `409` with
   * verbose logging on would be the defect X38-1 files, reintroduced by an
   * option. So the wrapper is installed unconditionally; only the log line
   * is conditional.
   *
   * @param entity - Entity name
   * @param ds - Underlying data source
   * @returns Wrapped data source
   */
  private wrapDataSource(entity: string, ds: DataSource): DataSource {
    const enabled = this._options?.logQueries === true && this._logger !== undefined;
    const logger = this._logger;
    const now = this._now;
    const adapterType = this._adapterType;

    // `findPage` is OPTIONAL on `IDataSource` and is bound here, before the
    // spread, for two reasons. (1) The spread below carries only OWN ENUMERABLE
    // members — a data source whose `findPage` lives on its PROTOTYPE (a class
    // implementation, which the contract's method signatures invite) would be
    // silently dropped, and `BaseRepository.findPage` would then refuse by name
    // on an adapter that supports cursor pagination exactly when
    // `logQueries` is on. (2) Forwarding is the wrapper's job, not the
    // spread's: the override below logs the operation like every other
    // member. The conditional spread also preserves the §3.7 semantics — when
    // the underlying source has no `findPage`, the wrapper fabricates none, so
    // absence still means "cannot page by cursor", never "no more rows".
    const findPageImpl = ds.findPage?.bind(ds);

    return {
      // Spread FIRST, so an OWN ENUMERABLE member `IDataSource` does not
      // REQUIRE — an optional method added to the contract later, or an
      // adapter-specific extra — passes through instead of being silently
      // dropped. The six required methods then override it below.
      //
      // Hand-listing every member is what let the `count` filter go missing:
      // an object literal satisfies `DataSource` with each optional member
      // absent, so the type checker cannot see the omission and the wrapper
      // only diverges when logging is on.
      //
      // A member reached through a PROTOTYPE is deliberately not carried, and
      // the obvious fix is worse than the gap. `Object.create(ds)` delegates
      // every unlisted member, but calls it with `this` bound to the wrapper
      // rather than to `ds` — measured: a class method reading a `#private`
      // field then throws `TypeError: Cannot read private member … from an
      // object whose class did not declare it`. That is the M52c detached-
      // method defect, and both loggers `logger-plugin` ships are written with
      // `#` fields. The six REQUIRED members are unaffected either way: each
      // override below calls `ds.method(...)`, so a class-based data source
      // keeps its receiver and its private state (pinned by a test).
      ...ds,
      ...(findPageImpl === undefined ? {} : {
        async findPage(query: NormalizedQuery): Promise<PageResult> {
          const start = now();
          try {
            const result = await findPageImpl(query);
            if (enabled && logger !== undefined) {
              const accessPath = accessPathOf(ds);
              logger.debug(`[${entity}] findPage`, {
                operation: 'findPage',
                durationMs: now() - start,
                ...(accessPath === undefined ? {} : { accessPath }),
              });
            }
            return result;
          } catch (error) {
            throw classifiedOrOriginal(error, adapterType);
          }
        },
      }),
      async findAll(query) {
        const start = now();
        try {
          const result = await ds.findAll(query);
          if (enabled && logger !== undefined) {
            const accessPath = accessPathOf(ds);
            logger.debug(`[${entity}] findAll`, {
              operation: 'findAll',
              durationMs: now() - start,
              ...(accessPath === undefined ? {} : { accessPath }),
            });
          }
          return result;
        } catch (error) {
          throw classifiedOrOriginal(error, adapterType);
        }
      },
      async findById(id) {
        const start = now();
        try {
          const result = await ds.findById(id);
          if (enabled && logger !== undefined) {
            logger.debug(`[${entity}] findById`, {
              operation: 'findById',
              durationMs: now() - start,
            });
          }
          return result;
        } catch (error) {
          throw classifiedOrOriginal(error, adapterType);
        }
      },
      async create(data) {
        const start = now();
        try {
          const result = await ds.create(data);
          if (enabled && logger !== undefined) {
            logger.debug(`[${entity}] create`, {
              operation: 'create',
              durationMs: now() - start,
            });
          }
          return result;
        } catch (error) {
          throw classifiedOrOriginal(error, adapterType);
        }
      },
      async update(id, data) {
        const start = now();
        try {
          const result = await ds.update(id, data);
          if (enabled && logger !== undefined) {
            logger.debug(`[${entity}] update`, {
              operation: 'update',
              durationMs: now() - start,
            });
          }
          return result;
        } catch (error) {
          throw classifiedOrOriginal(error, adapterType);
        }
      },
      async delete(id) {
        const start = now();
        try {
          const result = await ds.delete(id);
          if (enabled && logger !== undefined) {
            logger.debug(`[${entity}] delete`, {
              operation: 'delete',
              durationMs: now() - start,
            });
          }
          return result;
        } catch (error) {
          throw classifiedOrOriginal(error, adapterType);
        }
      },
      // BOTH parameters are forwarded. Taking only `where` dropped the
      // portable `filter` argument, so `repo.count({ filter })` answered a
      // different number with `logQueries: true` than with it off.
      async count(where, filter) {
        const start = now();
        try {
          const result = await ds.count(where, filter);
          if (enabled && logger !== undefined) {
            const accessPath = accessPathOf(ds);
            logger.debug(`[${entity}] count`, {
              operation: 'count',
              durationMs: now() - start,
              ...(accessPath === undefined ? {} : { accessPath }),
            });
          }
          return result;
        } catch (error) {
          throw classifiedOrOriginal(error, adapterType);
        }
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
 * Delegates to `MemoryAdapter.createDataSource`, which owns the single
 * implementation — the promoted {@linkcode IDatabaseAdapter} port put it on
 * the adapter, so the plugin no longer has to cast to reach it.
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
  return adapter.createDataSource(entity, primaryKey);
}
