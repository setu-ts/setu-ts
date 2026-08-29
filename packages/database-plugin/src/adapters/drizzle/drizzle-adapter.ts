/**
 * Drizzle ORM adapter — accepts an injected database instance and lazily
 * loads the matching Drizzle query operators.
 *
 * Transaction bridging uses the same two-deferred pattern as Prisma so that
 * `commit()` / `rollback()` properly await the outer transaction promise.
 *
 * @module
 */
import type { DatabaseAdapterOptions } from '../../interfaces/index.ts';
import { escapeLikePattern } from '../../query/like-escape.ts';
import { bindRawStatement, type RawStatementTag } from '../../query/raw-statement.ts';
import type { FilterExpression, IAdapterTransaction, IDatabaseAdapter } from '@setu-ts/common';
import type { DataSource } from '../../repositories/base-repository.ts';
import {
  DRIZZLE_QUERY_HANDLE,
  type DrizzleQueryHandleProvider,
  type NativeDrizzleQueryHandle,
} from '../../query/drizzle-query.ts';
import { readDrizzleDatabase } from '../../query/drizzle-database.ts';
import type { DrizzleDatabaseIdentity } from '../../query/drizzle-database.ts';

// ---------------------------------------------------------------------------
// Drizzle database type — lazily resolved at connect() time.
// ---------------------------------------------------------------------------

/**
 * Structural shape of the Drizzle instance used by this adapter.
 *
 * The instance is injected via `options.drizzleInstance`.
 */
export type DrizzleInstance = {
  select(fields?: Record<string, unknown>): DrizzleSelect;
  insert(table: DrizzleTable): DrizzleInsert;
  update(table: DrizzleTable): DrizzleUpdate;
  delete(table: DrizzleTable): DrizzleDelete;
  execute?(values: unknown): Promise<unknown>;
  query?: Record<string, unknown>;
  transaction<T>(cb: (tx: DrizzleInstance) => Promise<T>): Promise<T>;
};

type DrizzleSelect = {
  from(table: DrizzleTable): DrizzleSelectQuery;
};

type DrizzleSelectQuery = PromiseLike<Record<string, unknown>[]> & {
  where(expr: unknown): DrizzleSelectQuery;
  orderBy(...expressions: unknown[]): DrizzleSelectQuery;
  limit(value: number): DrizzleSelectQuery;
  offset(value: number): DrizzleSelectQuery;
};

type DrizzleInsert = {
  values(data: Record<string, unknown> | Record<string, unknown>[]): DrizzleWriteQuery;
};

type DrizzleWriteQuery = {
  where?(expr: unknown): DrizzleWriteQuery;
  returning(): PromiseLike<Record<string, unknown>[]>;
};

type DrizzleUpdate = {
  set(data: Record<string, unknown>): DrizzleWriteQuery;
};

type DrizzleDelete = {
  where(expr: unknown): DrizzleWriteQuery;
};

type DrizzleTable = Record<string, unknown>;

/**
 * Deferred promise — resolves or rejects exactly once.
 *
 * @internal
 */
class Deferred<T> {
  readonly promise: Promise<T>;
  private _resolve: (value: T) => void = () => {};
  private _reject: (reason: unknown) => void = () => {};
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(value: T): void {
    if (!this.settled) {
      this.settled = true;
      this._resolve(value);
    }
  }

  reject(reason: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this._reject(reason);
    }
  }
}

/** Drizzle operator functions loaded once at connect. */
export type DrizzleOperators = {
  eq: (col: unknown, val: unknown) => unknown;
  and: (...exprs: unknown[]) => unknown;
  or?: (...exprs: unknown[]) => unknown;
  gt?: (col: unknown, val: unknown) => unknown;
  gte?: (col: unknown, val: unknown) => unknown;
  lt?: (col: unknown, val: unknown) => unknown;
  lte?: (col: unknown, val: unknown) => unknown;
  inArray?: (col: unknown, values: readonly unknown[]) => unknown;
  isNull?: (col: unknown) => unknown;
  /**
   * Drizzle's `sql` template tag. `contains` needs it because a bare
   * `like(col, pattern)` cannot carry an `ESCAPE` clause, without which the
   * `%` and `_` a caller searches for stay wildcards on SQLite (which has no
   * default escape character) — a literal search then matches nothing.
   */
  sql?:
    & ((strings: TemplateStringsArray, ...values: unknown[]) => unknown)
    & RawStatementTag;
  /**
   * Drizzle's `SQL` constructor. `rawQuery` needs it because `execute()` takes
   * an `SQLWrapper` — an object carrying `getSQL()` — and a chunk list is the
   * only way to emit a caller's statement text while binding its parameters
   * rather than interpolating them.
   */
  sqlClass?: new (chunks: readonly unknown[]) => unknown;
  asc: (col: unknown) => unknown;
  desc: (col: unknown) => unknown;
  /**
   * Builds Drizzle's `count(*)` aggregate. Selecting it makes the database
   * return the tally as a single row instead of streaming every matching row
   * back for the adapter to measure.
   */
  count: () => unknown;
};

// ---------------------------------------------------------------------------
// Drizzle adapter
// ---------------------------------------------------------------------------

/**
 * Drizzle adapter wrapping a Drizzle database instance.
 *
 * The application injects a configured Drizzle driver through
 * `options.drizzleInstance`; this adapter lazily loads only Drizzle's query
 * operators. `options.drizzleTables` supplies the real table and column
 * objects used for every operation.
 *
 * @since 0.1.0
 */
export class DrizzleAdapter implements IDatabaseAdapter {
  private _db: DrizzleInstance | null = null;
  private _configuredDatabase: DrizzleDatabaseIdentity | null = null;
  private _transactionBridge:
    | ((work: (transaction: unknown) => Promise<void>) => Promise<void>)
    | null = null;
  private _connected = false;
  private readonly _options: DatabaseAdapterOptions | undefined;
  private _operators: DrizzleOperators | null = null;

  constructor(options?: DatabaseAdapterOptions) {
    this._options = options ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    const configured = this.resolveDb();
    this._db = configured.database;
    this._configuredDatabase = configured.configured;
    this._transactionBridge = configured.transaction;

    try {
      const orm = await import('npm:drizzle-orm@0.45.2');
      const ns = orm as Record<string, unknown>;
      const operators: DrizzleOperators = {
        eq: ns.eq as (col: unknown, val: unknown) => unknown,
        and: ns.and as (...exprs: unknown[]) => unknown,
        or: ns.or as (...exprs: unknown[]) => unknown,
        gt: ns.gt as (col: unknown, val: unknown) => unknown,
        gte: ns.gte as (col: unknown, val: unknown) => unknown,
        lt: ns.lt as (col: unknown, val: unknown) => unknown,
        lte: ns.lte as (col: unknown, val: unknown) => unknown,
        inArray: ns.inArray as (col: unknown, values: readonly unknown[]) => unknown,
        isNull: ns.isNull as (col: unknown) => unknown,
        sql: ns.sql as NonNullable<DrizzleOperators['sql']>,
        sqlClass: ns.SQL as NonNullable<DrizzleOperators['sqlClass']>,
        asc: ns.asc as (col: unknown) => unknown,
        desc: ns.desc as (col: unknown) => unknown,
        count: ns.count as () => unknown,
      };
      if (
        typeof operators.eq !== 'function' ||
        typeof operators.and !== 'function' ||
        typeof operators.or !== 'function' ||
        typeof operators.gt !== 'function' ||
        typeof operators.gte !== 'function' ||
        typeof operators.lt !== 'function' ||
        typeof operators.lte !== 'function' ||
        typeof operators.inArray !== 'function' ||
        typeof operators.isNull !== 'function' ||
        typeof operators.sql !== 'function' ||
        typeof operators.sql.raw !== 'function' ||
        typeof operators.sql.param !== 'function' ||
        typeof operators.sqlClass !== 'function' ||
        typeof operators.asc !== 'function' ||
        typeof operators.desc !== 'function' ||
        typeof operators.count !== 'function'
      ) {
        throw new Error('drizzle-orm did not export the required query operators');
      }
      this._operators = operators;
    } catch (error) {
      throw new Error(
        `Failed to load Drizzle query operators: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          'Install drizzle-orm alongside the injected drizzleInstance.',
      );
    }

    // A usable Drizzle adapter must know how entity names map to real tables.
    const tables =
      (this._options as DatabaseAdapterOptions & { drizzleTables?: Record<string, unknown> })
        .drizzleTables;
    if (tables === undefined || Object.keys(tables).length === 0) {
      throw new Error(
        'DrizzleAdapter requires options.drizzleTables with at least one real Drizzle table definition.',
      );
    }
    // The `id` column is a REPOSITORY precondition, not a registry one:
    // `IRepository.findById`/`update`/`delete` are single-key by contract, but
    // a composite-key table registered only so the typed query builder can
    // reach it needs no such column. Enforcing it here made the registry
    // all-or-nothing and locked ordinary join and per-tenant tables out of the
    // whole schema. `createDrizzleDataSourceInner` refuses the same table by
    // name at the moment a repository is actually asked for.
    for (const [name, table] of Object.entries(tables)) {
      if (table == null || typeof table !== 'object') {
        throw new Error(
          `Drizzle table '${name}' must be a table definition; ` +
            'provide a proper Drizzle table definition in options.drizzleTables.',
        );
      }
    }

    this._connected = true;
  }

  /** @inheritdoc */
  disconnect(): Promise<void> {
    this._connected = false;
    this._db = null;
    this._configuredDatabase = null;
    this._transactionBridge = null;
    return Promise.resolve();
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && this._db !== null;
  }

  /** Provide the exact configured instance to the package's typed Drizzle accessor. */
  [DRIZZLE_QUERY_HANDLE](): NativeDrizzleQueryHandle {
    if (!this._db || !this._configuredDatabase) {
      throw new Error('DrizzleAdapter is not connected — call connect() first');
    }
    return { database: this._configuredDatabase, query: this._db, scope: 'outer' };
  }

  /**
   * @inheritdoc
   *
   * Uses the same two-deferred bridge pattern as Prisma.
   */
  async beginTransaction(): Promise<IAdapterTransaction> {
    if (!this.isReady()) {
      throw new Error('DrizzleAdapter is not connected — call connect() first');
    }
    const configuredDatabase = this._configuredDatabase!;
    const transactionBridge = this._transactionBridge!;

    const txReady = new Deferred<DrizzleInstance>();
    const hold = new Deferred<void>();
    const tables = this.resolveTables();
    const operators = this._operators!;

    const outer = transactionBridge(async (tx) => {
      txReady.resolve(this.validateInstance(tx));
      await hold.promise;
    });
    // If the transaction rejects before handing back `tx` (e.g. the driver
    // fails to open it), unblock the waiter so beginTransaction rejects
    // instead of hanging on a promise that never settles.
    outer.catch((err: unknown) => txReady.reject(err));

    let tx: DrizzleInstance;
    try {
      tx = await txReady.promise;
    } catch {
      await outer.catch(() => {});
      throw new Error('Drizzle transaction failed to start');
    }

    const rollbackSentinel = { code: 'ROLLBACK_SENTINEL' };

    const handle: IAdapterTransaction & DrizzleQueryHandleProvider = {
      [DRIZZLE_QUERY_HANDLE](): NativeDrizzleQueryHandle {
        return { database: configuredDatabase, query: tx, scope: 'transaction' };
      },

      createDataSource(entity: string): DataSource {
        return createDrizzleDataSourceInner(tx, entity, tables, operators);
      },

      async commit(): Promise<void> {
        hold.resolve();
        await outer;
      },

      async rollback(): Promise<void> {
        hold.reject(rollbackSentinel);
        try {
          await outer;
        } catch (err) {
          if (err !== rollbackSentinel) {
            throw err;
          }
        }
      },
    };
    return handle;
  }

  /** @inheritdoc */
  async rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this.isReady()) {
      throw new Error('DrizzleAdapter is not connected — call connect() first');
    }
    const execute = this._db!.execute;
    if (typeof execute !== 'function') {
      // SQLite Proxy and libsql-shaped instances expose `all()` instead, but
      // its raw-statement rows come back POSITIONAL (`[['a', 1]]`) because the
      // proxy protocol returns array rows and Drizzle has no field map for a
      // statement it did not build. `query<T>()` promises row objects, which
      // Prisma and D1 both return, so routing through `all()` would trade a
      // loud refusal for a silent shape divergence.
      throw new Error(
        "Configured Drizzle instance does not support raw execute(); use Drizzle's typed query builder for this driver.",
      );
    }
    // Both are non-null because `isReady()` above implies `connect()` ran, and
    // `connect()` refuses a namespace missing either — so a guard here would be
    // a branch no input can reach.
    const { sql: tag, sqlClass } = this._operators as Required<
      Pick<DrizzleOperators, 'sql' | 'sqlClass'>
    >;
    // `execute()` takes an SQLWrapper. Passing `{ sql, params }` — which this
    // adapter used to do — fails inside Drizzle with `query.getSQL is not a
    // function`, so `query()` could never work on any driver.
    const statement = new sqlClass(bindRawStatement(sql, params ?? [], tag));
    const result = await execute.call(this._db, statement);
    return (result as { rows?: T[] }).rows ?? result as T[];
  }

  /**
   * @inheritdoc
   *
   * Builds a non-transactional data source over the main instance.
   */
  createDataSource(entity: string): DataSource {
    if (!this._db) {
      throw new Error('DrizzleAdapter is not connected — call connect() first');
    }
    return createDrizzleDataSourceInner(
      this._db,
      entity,
      this.resolveTables(),
      this._operators!,
    );
  }

  /**
   * Create a DataSource for the named entity using the main instance.
   *
   * @deprecated Use {@linkcode DrizzleAdapter.createDataSource} instead — it is
   * the promoted {@linkcode IDatabaseAdapter} member, so the plugin reaches it
   * without casting to this concrete class. Will be removed in the next major
   * version.
   * @param entity - Entity name
   * @returns DataSource bound to the entity
   */
  createDataSourceForEntity(entity: string): DataSource {
    return this.createDataSource(entity);
  }

  /** Resolve the validated drizzleTables option. */
  private resolveTables(): Record<string, unknown> {
    const opts = this._options as DatabaseAdapterOptions & {
      drizzleTables?: Record<string, unknown>;
    };
    return opts.drizzleTables ?? {};
  }

  /**
   * Resolve the application-configured Drizzle database instance.
   *
   * @returns Drizzle database instance
   * @throws {Error} If no configured Drizzle instance was injected
   */
  private resolveDb(): {
    readonly database: DrizzleInstance;
    readonly configured: DrizzleDatabaseIdentity;
    readonly transaction: (work: (transaction: unknown) => Promise<void>) => Promise<void>;
  } {
    // Prefer injected instance.
    if (this._options?.drizzleInstance) {
      const witness = this.validateWitness(this._options.drizzleInstance);
      const configured = readDrizzleDatabase(witness);
      return {
        database: this.validateInstance(configured.database),
        configured: witness,
        transaction: configured.transaction,
      };
    }

    throw new Error(
      'DrizzleAdapter requires options.drizzleInstance: wrap a configured Promise-aware Drizzle ' +
        'driver with createDrizzleDatabase(), then inject that configuration into DatabasePlugin.',
    );
  }

  /** Require the source-owned wrapper so sync callback drivers cannot be selected accidentally. */
  private validateWitness(instance: unknown): DrizzleDatabaseIdentity {
    readDrizzleDatabase(instance);
    return instance as DrizzleDatabaseIdentity;
  }

  /** Structural validation for builders and transaction access. Raw execute is guarded at use. */
  private validateInstance(instance: unknown): DrizzleInstance {
    const ns = instance as Record<string, unknown>;
    if (
      typeof ns.select !== 'function' ||
      typeof ns.transaction !== 'function' ||
      typeof ns.insert !== 'function' ||
      typeof ns.update !== 'function' ||
      typeof ns.delete !== 'function'
    ) {
      throw new Error(
        'Injected drizzleInstance does not look like a Drizzle instance ' +
          '(missing select / insert / update / delete / transaction).',
      );
    }
    return instance as DrizzleInstance;
  }
}

// ---------------------------------------------------------------------------
// Drizzle data-source factory
// ---------------------------------------------------------------------------

/**
 * Creates a {@linkcode DataSource} backed by a Drizzle instance for the given
 * entity name.
 *
 * The entity must exist in the `drizzleTables` registry; otherwise this throws
 * naming the entity and the option.
 *
 * @param instance - The Drizzle instance (or transaction instance)
 * @param entity - Entity / table name
 * @param tables - Table registry from adapter options
 * @param operators - Drizzle operators loaded at connect
 * @returns A data source bound to the Drizzle table
 * @since 0.1.0
 */
export function createDrizzleDataSource(
  instance: DrizzleInstance,
  entity: string,
  tables: Record<string, unknown>,
  operators: DrizzleOperators,
): DataSource {
  return createDrizzleDataSourceInner(instance, entity, tables, operators);
}

function createDrizzleDataSourceInner(
  instance: DrizzleInstance,
  entity: string,
  tables: Record<string, unknown>,
  operators: DrizzleOperators,
): DataSource {
  const table = tables[entity];
  if (table == null || typeof table !== 'object') {
    throw new Error(
      `Unknown entity '${entity}' for Drizzle adapter — register it in options.drizzleTables.`,
    );
  }
  const drizzleTable = table as DrizzleTable;
  const idColumn = columnFor(drizzleTable, entity, 'id');

  return {
    async findById(id) {
      const rows = await instance.select().from(drizzleTable).where(operators.eq(idColumn, id));
      return rows[0] ?? null;
    },

    async findAll(query) {
      const fields = selectedColumns(drizzleTable, entity, query.select);
      let builder = instance.select(fields).from(drizzleTable);
      const predicate = predicateFor(drizzleTable, entity, query.where, operators, query.filter);
      if (predicate !== undefined) {
        builder = builder.where(predicate);
      }
      const order = orderFor(drizzleTable, entity, query.orderBy, operators);
      if (order.length > 0) {
        builder = builder.orderBy(...order);
      }
      if (query.limit > 0) {
        builder = builder.limit(query.limit);
      }
      if (query.offset > 0) {
        builder = builder.offset(query.offset);
      }
      return await builder;
    },

    async create(data) {
      const rows = await returningRows(
        instance.insert(drizzleTable).values(data),
        entity,
        'create',
      );
      return oneReturnedRow(entity, 'create', rows);
    },

    async update(id, data) {
      const rows = await returningRows(
        instance.update(drizzleTable).set(data).where!(operators.eq(idColumn, id)),
        entity,
        'update',
      );
      // `id` is EntityKey here; the error message only interpolates it as a
      // scalar, so cast it — composite keys are refused at the mapping layer
      // and never reach a Drizzle row-returning path.
      return oneReturnedRow(entity, 'update', rows, id as string | number);
    },

    async delete(id) {
      const rows = await returningRows(
        instance.delete(drizzleTable).where(operators.eq(idColumn, id)),
        entity,
        'delete',
      );
      return rows.length > 0;
    },

    async count(where, filter) {
      // `count(*)` is selected so the database returns one aggregate row. A
      // bare `select()` would stream every matching row back just to measure
      // its length, which is the in-memory evaluation this adapter avoids.
      let builder = instance.select({ [COUNT_ALIAS]: operators.count() }).from(drizzleTable);
      const predicate = predicateFor(drizzleTable, entity, where, operators, filter);
      if (predicate !== undefined) {
        builder = builder.where(predicate);
      }
      const rows = await builder;
      return Number(rows[0]?.[COUNT_ALIAS] ?? 0);
    },
  };
}

/** Result alias the `count(*)` aggregate is read back under. */
const COUNT_ALIAS = 'value';

function hasColumn(value: unknown, field: string): boolean {
  return value !== null && typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, field) &&
    (value as Record<string, unknown>)[field] !== undefined;
}

function columnFor(table: DrizzleTable, entity: string, field: string): unknown {
  if (!hasColumn(table, field)) {
    throw new Error(
      `Drizzle table '${entity}' has no '${field}' column required by the database repository.`,
    );
  }
  return table[field];
}

function predicateFor(
  table: DrizzleTable,
  entity: string,
  where: Record<string, unknown>,
  operators: DrizzleOperators,
  filter?: FilterExpression,
): unknown | undefined {
  const predicates = Object.entries(where).map(([field, value]) =>
    operators.eq(columnFor(table, entity, field), value)
  );
  if (filter !== undefined) {
    const filterPredicate = filterPredicateFor(table, entity, filter, operators);
    if (filterPredicate !== undefined) {
      predicates.push(filterPredicate);
    }
  }
  if (predicates.length === 0) return undefined;
  if (predicates.length === 1) return predicates[0];
  return operators.and(...predicates);
}

/** Translate the portable expression to Drizzle's native operator tree. */
function filterPredicateFor(
  table: DrizzleTable,
  entity: string,
  filter: FilterExpression,
  operators: DrizzleOperators,
): unknown | undefined {
  const filterOperators = requireFilterOperators(operators);
  if (isTautology(filter)) return undefined;
  if (isContradiction(filter)) {
    return filterOperators.inArray(columnFor(table, entity, 'id'), []);
  }
  if (filter.type !== 'comparison') {
    const predicates = filter.filters
      .map((item) => filterPredicateFor(table, entity, item, operators))
      .filter((item): item is unknown => item !== undefined);
    if (predicates.length === 0) {
      return filterOperators.inArray(columnFor(table, entity, 'id'), []);
    }
    if (predicates.length === 1) return predicates[0];
    return filter.type === 'and' ? operators.and(...predicates) : filterOperators.or(...predicates);
  }

  const column = columnFor(table, entity, filter.field);
  switch (filter.operator) {
    case 'eq':
      return operators.eq(column, filter.value);
    case 'contains':
      // `ESCAPE '\'` is standard SQL and is required, not decorative: SQLite
      // defines no default escape character, so without the clause the
      // backslashes below are matched literally and a search for a value
      // holding `%` or `_` returns nothing at all.
      return filterOperators.sql`${column} like ${`%${
        escapeLikePattern(filter.value)
      }%`} escape '\\'`;
    case 'gt':
      return filterOperators.gt(column, filter.value);
    case 'gte':
      return filterOperators.gte(column, filter.value);
    case 'lt':
      return filterOperators.lt(column, filter.value);
    case 'lte':
      return filterOperators.lte(column, filter.value);
    case 'in': {
      const nonNullValues = filter.value.filter((value) => value !== null);
      if (!filter.value.includes(null)) {
        return filterOperators.inArray(column, nonNullValues);
      }
      const nullPredicate = filterOperators.isNull(column);
      if (nonNullValues.length === 0) return nullPredicate;
      return filterOperators.or(nullPredicate, filterOperators.inArray(column, nonNullValues));
    }
  }
}

type FilterOperators = Required<
  Pick<
    DrizzleOperators,
    'or' | 'gt' | 'gte' | 'lt' | 'lte' | 'inArray' | 'isNull' | 'sql'
  >
>;

/** Ensure a directly-created source has the native operators its filter needs. */
function requireFilterOperators(operators: DrizzleOperators): FilterOperators {
  if (
    typeof operators.or !== 'function' ||
    typeof operators.gt !== 'function' ||
    typeof operators.gte !== 'function' ||
    typeof operators.lt !== 'function' ||
    typeof operators.lte !== 'function' ||
    typeof operators.inArray !== 'function' ||
    typeof operators.isNull !== 'function' ||
    typeof operators.sql !== 'function'
  ) {
    throw new Error('Drizzle filter operators are unavailable');
  }
  return operators as DrizzleOperators & FilterOperators;
}

/** Whether an expression is true by identity alone, without reading a row. */
function isTautology(filter: FilterExpression): boolean {
  if (filter.type === 'comparison') return false;
  return filter.type === 'and'
    ? filter.filters.every(isTautology)
    : filter.filters.some(isTautology);
}

/** Whether an expression is false by identity alone, without reading a row. */
function isContradiction(filter: FilterExpression): boolean {
  if (filter.type === 'comparison') return false;
  return filter.type === 'and'
    ? filter.filters.some(isContradiction)
    : filter.filters.every(isContradiction);
}

function orderFor(
  table: DrizzleTable,
  entity: string,
  orderBy: Record<string, 'asc' | 'desc'>,
  operators: DrizzleOperators,
): unknown[] {
  return Object.entries(orderBy).map(([field, direction]) => {
    const column = columnFor(table, entity, field);
    return direction === 'asc' ? operators.asc(column) : operators.desc(column);
  });
}

function selectedColumns(
  table: DrizzleTable,
  entity: string,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (fields.length === 0) return undefined;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    selected[field] = columnFor(table, entity, field);
  }
  return selected;
}

function oneReturnedRow(
  entity: string,
  operation: 'create' | 'update',
  rows: readonly Record<string, unknown>[],
  id?: string | number,
): Record<string, unknown> {
  const row = rows[0];
  if (row !== undefined) return row;
  if (operation === 'update') {
    throw new Error(`Entity '${entity}' with id '${id}' not found`);
  }
  throw new Error(
    `Drizzle ${operation} for entity '${entity}' returned no row; configure a driver that supports RETURNING.`,
  );
}

function returningRows(
  query: DrizzleWriteQuery,
  entity: string,
  operation: 'create' | 'update' | 'delete',
): PromiseLike<Record<string, unknown>[]> {
  if (typeof query.returning !== 'function') {
    throw new Error(
      `Drizzle ${operation} for entity '${entity}' requires a driver that supports RETURNING.`,
    );
  }
  return query.returning();
}
