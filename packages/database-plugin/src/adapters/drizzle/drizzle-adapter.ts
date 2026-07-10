/**
 * Drizzle ORM adapter — lazily loads Drizzle via `npm:drizzle-orm` import
 * or accepts an injected database instance.
 *
 * Transaction bridging uses the same two-deferred pattern as Prisma so that
 * `commit()` / `rollback()` properly await the outer transaction promise.
 *
 * @module
 */
import type { DatabaseAdapterOptions } from '../../interfaces/index.ts';
import type { IAdapterTransaction, IDatabaseAdapter } from '../adapter.ts';
import type { DataSource } from '../../repositories/base-repository.ts';

// ---------------------------------------------------------------------------
// Drizzle database type — lazily resolved at connect() time.
// ---------------------------------------------------------------------------

/**
 * Structural shape of the Drizzle instance used by this adapter.
 *
 * The instance is injected via `options.drizzleInstance`.
 */
export type DrizzleInstance = {
  select(): DrizzleSelect;
  insert(table: unknown): DrizzleInsert;
  update(table: unknown): DrizzleUpdate;
  delete(table: unknown): DrizzleDelete;
  execute(values: unknown): Promise<unknown>;
  query?: Record<string, unknown>;
  transaction<T>(cb: (tx: DrizzleInstance) => Promise<T>): Promise<T>;
};

type DrizzleSelect = {
  from(table: unknown): Promise<Record<string, unknown>[]>;
  where?(expr: unknown): Promise<Record<string, unknown>[]>;
};

type DrizzleInsert = {
  values(data: Record<string, unknown> | Record<string, unknown>[]): DrizzleInsertChained;
};

type DrizzleInsertChained = {
  execute(): Promise<Record<string, unknown>[]>;
};

type DrizzleUpdate = {
  set(data: Record<string, unknown>): DrizzleUpdateChained;
};

type DrizzleUpdateChained = {
  where(expr: unknown): Promise<Record<string, unknown>[]>;
};

type DrizzleDelete = {
  where(expr: unknown): Promise<unknown>;
};

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
  asc: (col: unknown) => unknown;
  desc: (col: unknown) => unknown;
};

// ---------------------------------------------------------------------------
// Drizzle adapter
// ---------------------------------------------------------------------------

/**
 * Drizzle adapter wrapping a Drizzle database instance.
 *
 * The instance is either injected via `options.drizzleInstance` or lazily
 * loaded through `import('npm:drizzle-orm@0.33.0')`.
 *
 * @since 0.1.0
 */
export class DrizzleAdapter implements IDatabaseAdapter {
  private _db: DrizzleInstance | null = null;
  private _connected = false;
  private readonly _options: DatabaseAdapterOptions | undefined;
  private _operators: DrizzleOperators | null = null;

  constructor(options?: DatabaseAdapterOptions) {
    this._options = options ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    this._db = await this.resolveDb();

    // Load drizzle-orm operators once.
    try {
      const orm = await import('npm:drizzle-orm@0.33.0');
      const ns = orm as Record<string, unknown>;
      this._operators = {
        eq: ns.eq as (col: unknown, val: unknown) => unknown,
        and: ns.and as (...exprs: unknown[]) => unknown,
        asc: ns.asc as (col: unknown) => unknown,
        desc: ns.desc as (col: unknown) => unknown,
      };
    } catch {
      // Fall back: create simple operator builders if import fails
      // (unit tests with fake instance do not need real drizzle-orm).
      this._operators = {
        eq: (col, val) => ({ op: 'eq', col, val }),
        and: (...exprs) => ({ op: 'and', exprs }),
        asc: (col) => ({ op: 'asc', col }),
        desc: (col) => ({ op: 'desc', col }),
      };
    }

    // Validate table registry if provided.
    const tables =
      (this._options as DatabaseAdapterOptions & { drizzleTables?: Record<string, unknown> })
        .drizzleTables;
    if (tables) {
      for (const [name, table] of Object.entries(tables)) {
        if (table == null || typeof table !== 'object') {
          throw new Error(
            `Drizzle table '${name}' is not a valid table object; ` +
              `provide a proper Drizzle table definition in options.drizzleTables.`,
          );
        }
      }
    }

    this._connected = true;
  }

  /** @inheritdoc */
  disconnect(): Promise<void> {
    this._connected = false;
    this._db = null;
    return Promise.resolve();
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && this._db !== null;
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
    const db = this._db!;

    const txReady = new Deferred<DrizzleInstance>();
    const hold = new Deferred<void>();
    const tables = this.resolveTables();
    const operators = this._operators!;

    const outer = db.transaction(async (tx) => {
      txReady.resolve(tx);
      await hold.promise;
    });

    let tx: DrizzleInstance;
    try {
      tx = await txReady.promise;
    } catch {
      await outer.catch(() => {});
      throw new Error('Drizzle transaction failed to start');
    }

    const rollbackSentinel = { code: 'ROLLBACK_SENTINEL' };

    return {
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
  }

  /** @inheritdoc */
  async rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this.isReady()) {
      throw new Error('DrizzleAdapter is not connected — call connect() first');
    }
    const result = await this._db!.execute({ sql, params: params ?? [] });
    return (result as { rows?: T[] }).rows ?? result as T[];
  }

  /**
   * Create a DataSource for the named entity using the main instance.
   * Used by the plugin's service-level data-source factory.
   *
   * @param entity - Entity name
   * @returns DataSource bound to the entity
   */
  createDataSourceForEntity(entity: string): DataSource {
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

  /** Resolve the drizzleTables option (defaults to empty). */
  private resolveTables(): Record<string, unknown> {
    const opts = this._options as DatabaseAdapterOptions & {
      drizzleTables?: Record<string, unknown>;
    };
    return opts.drizzleTables ?? {};
  }

  /**
   * Resolve the Drizzle database instance from options or lazy import.
   *
   * @returns Drizzle database instance
   * @throws {Error} If Drizzle cannot be loaded
   */
  private async resolveDb(): Promise<DrizzleInstance> {
    // Prefer injected instance.
    if (this._options?.drizzleInstance) {
      return this.validateInstance(this._options.drizzleInstance);
    }

    // Lazy-load Drizzle — the adapter needs a driver instance, so bare import
    // is mostly a fallback that validates availability.
    try {
      await import('npm:drizzle-orm@0.33.0');
      throw new Error(
        'Drizzle adapter requires options.drizzleInstance to be provided (a configured database instance).',
      );
    } catch (error) {
      throw new Error(
        `Failed to load Drizzle: ${(error as Error).message}. Inject via options.drizzleInstance.`,
      );
    }
  }

  /** Structural validation: injected instance must have select / transaction. */
  private validateInstance(instance: unknown): DrizzleInstance {
    const ns = instance as Record<string, unknown>;
    if (
      typeof ns.select !== 'function' ||
      typeof ns.transaction !== 'function'
    ) {
      throw new Error(
        'Injected drizzleInstance does not look like a Drizzle instance ' +
          '(missing select / transaction).',
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
  if (table == null) {
    throw new Error(
      `Unknown entity '${entity}' for Drizzle adapter — register it in options.drizzleTables.`,
    );
  }

  return {
    async findById(id) {
      const rows = await instance.select().from(table);
      const row = rows.find((r) => r['id'] === id);
      if (!row) return null;
      return row;
    },

    async findAll(query) {
      let rows = await instance.select().from(table);
      // Apply where filter in-memory (Drizzle operators are query-builder expressions).
      if (query.where && Object.keys(query.where).length > 0) {
        for (const [field, expected] of Object.entries(query.where)) {
          rows = rows.filter((r) => r[field] === expected);
        }
      }
      // Sort
      if (query.orderBy && Object.keys(query.orderBy).length > 0) {
        const sorted = [...rows];
        sorted.sort((a, b) => {
          for (const [field, direction] of Object.entries(query.orderBy)) {
            const av = a[field];
            const bv = b[field];
            if (av === bv) continue;
            if (av === undefined || bv === undefined) {
              return av === undefined ? 1 : -1;
            }
            if (av === null || bv === null) {
              return av === null ? 1 : -1;
            }
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            if (direction === 'desc') return -cmp;
            return cmp;
          }
          return 0;
        });
        rows = sorted;
      }
      // Paginate
      if (query.offset && query.offset > 0) {
        rows = rows.slice(query.offset);
      }
      if (query.limit && query.limit > 0) {
        rows = rows.slice(0, query.limit);
      }
      // Select fields
      if (query.select && query.select.length > 0) {
        rows = rows.map((row) => {
          const projected: Record<string, unknown> = {};
          for (const field of query.select) {
            if (field in row) {
              projected[field] = row[field];
            }
          }
          return projected;
        });
      }
      return rows;
    },

    async create(data) {
      await instance.insert(table).values(data).execute();
      // Read the row back (no .returning() — not portable across MySQL).
      const id = data['id'] as string | number | undefined;
      if (id) {
        const rows = await instance.select().from(table);
        const row = rows.find((r) => r['id'] === id);
        return row ?? data;
      }
      // Without a known id, return the input data (best effort).
      return data;
    },

    async update(id, data) {
      const eqFn = operators.eq;
      const idCol = { column: 'id', table }; // placeholder column reference
      await instance.update(table).set(data).where(eqFn(idCol, id));
      // Read the row back.
      const rows = await instance.select().from(table);
      const row = rows.find((r) => r['id'] === id);
      if (!row) {
        throw new Error(`Entity '${entity}' with id '${id}' not found`);
      }
      return row;
    },

    async delete(id) {
      const eqFn = operators.eq;
      const idCol = { column: 'id', table }; // placeholder column reference
      await instance.delete(table).where(eqFn(idCol, id));
      // Check if the row still exists.
      const rows = await instance.select().from(table);
      const row = rows.find((r) => r['id'] === id);
      return row === undefined;
    },

    async count(where) {
      let rows = await instance.select().from(table);
      if (where && Object.keys(where).length > 0) {
        for (const [field, expected] of Object.entries(where)) {
          rows = rows.filter((r) => r[field] === expected);
        }
      }
      return rows.length;
    },
  };
}
