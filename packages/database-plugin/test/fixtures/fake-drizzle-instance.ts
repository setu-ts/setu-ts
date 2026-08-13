// deno-lint-ignore-file require-await -- async methods must match real Drizzle instance interface
/**
 * Fake Drizzle database instance for unit testing the DrizzleAdapter.
 *
 * Honors the real Drizzle surface:
 * - `transaction(fn)` — callback-style transaction (passes tx instance to fn)
 * - Chainable query builders: `insert().values().execute()`, `update().set().where()`,
 *   `delete().where()`, `select().from()`
 * - `execute(values)` — raw SQL queries
 * - In-memory store per entity table
 * - Recorded calls list for test assertions
 *
 * @module
 */

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface Store {
  records: Map<string, Record<string, unknown>>;
  idCounter: number;
}

/** A contract-faithful table with concrete column objects for adapter tests. */
export function createFakeDrizzleTable(name: string): Record<string, unknown> {
  const column = (columnName: string): Record<string, string> => ({
    name: columnName,
    table: name,
  });
  return {
    __setuTable: name,
    id: column('id'),
    name: column('name'),
    email: column('email'),
    role: column('role'),
    deletedAt: column('deletedAt'),
    title: column('title'),
  };
}

// ---------------------------------------------------------------------------
// Recorded calls for test assertions
// ---------------------------------------------------------------------------

export interface RecordedCall {
  action: string;
  entity?: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper types for self-reference
// ---------------------------------------------------------------------------

type FakeDrizzleInstance = ReturnType<typeof createFakeDrizzleInstance>;

interface FakeSelectQuery extends PromiseLike<Record<string, unknown>[]> {
  where(expr: unknown): FakeSelectQuery;
  orderBy(...expressions: unknown[]): FakeSelectQuery;
  limit(value: number): FakeSelectQuery;
  offset(value: number): FakeSelectQuery;
}

// ---------------------------------------------------------------------------
// Fake Drizzle instance factory
// ---------------------------------------------------------------------------

/**
 * Create a fake Drizzle database instance matching the real surface.
 *
 * The instance has in-memory stores per table, recorded calls list,
 * and proper transaction scoping via `transaction(fn)`.
 */
export function createFakeDrizzleInstance(): {
  select: () => {
    from: (table: Record<string, unknown>) => FakeSelectQuery;
  };
  insert: (table: string | Record<string, unknown>) => {
    values: (
      data: Record<string, unknown> | Record<string, unknown>[],
    ) => {
      execute: () => Promise<Record<string, unknown>[]>;
      returning: () => Promise<Record<string, unknown>[]>;
    };
  };
  update: (table: string | Record<string, unknown>) => {
    set: (data: Record<string, unknown>) => {
      returning: () => Promise<Record<string, unknown>[]>;
      where: (expr: unknown) => { returning: () => Promise<Record<string, unknown>[]> };
    };
  };
  delete: (table: string | Record<string, unknown>) => {
    where: (expr: unknown) => { returning: () => Promise<Record<string, unknown>[]> };
  };
  $count: (table: Record<string, unknown>, expr?: unknown) => Promise<number>;
  execute: (values: unknown) => Promise<{ rows: unknown[] }>;
  query: Record<string, unknown>;
  transaction: <T>(cb: (tx: FakeDrizzleInstance) => Promise<T>) => Promise<T>;
  recordedCalls: RecordedCall[];
  stores: Record<string, Store>;
  connected: boolean;
  ended: boolean;
} {
  const connected = false;
  const ended = false;
  const recordedCalls: RecordedCall[] = [];
  const stores: Record<string, Store> = {
    user: { records: new Map(), idCounter: 0 },
    post: { records: new Map(), idCounter: 0 },
    comment: { records: new Map(), idCounter: 0 },
  };

  // Helper: extract table name from table reference (string or object)
  function extractTableName(table: unknown): string {
    if (typeof table === 'string') return table;
    if (table !== null && typeof table === 'object' && '__setuTable' in table) {
      return String((table as Record<string, unknown>).__setuTable);
    }
    // Try to find the matching store key by reference or name
    for (const key of Object.keys(stores)) {
      return key;
    }
    return 'unknown';
  }

  // Helper: ensure store exists for table name
  function getStore(table: string): Store {
    if (!stores[table]) {
      stores[table] = { records: new Map(), idCounter: 0 };
    }
    return stores[table];
  }

  // Helper: extract id from a simple eq expression { col, operator, value }
  function extractWhereId(expr: unknown): string | null {
    if (expr && typeof expr === 'object' && !Array.isArray(expr)) {
      const obj = expr as Record<string, unknown>;
      if ('id' in obj) {
        return String(obj.id);
      }
      // Honor the adapter's default `eq(col, val)` shape: { op: 'eq', col, val }.
      if (obj.op === 'eq' && 'val' in obj) {
        return String(obj.val);
      }
      if ('_operator' in obj && 'arguments' in obj) {
        const args = (obj as Record<string, unknown>).arguments as unknown[];
        for (const arg of args) {
          const id = extractWhereId(arg);
          if (id) return id;
        }
      }
      const chunks = obj.queryChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (typeof chunk === 'string' || typeof chunk === 'number') {
            return String(chunk);
          }
          const nested = extractWhereId(chunk);
          if (nested) return nested;
          if (chunk !== null && typeof chunk === 'object') {
            const value = (chunk as Record<string, unknown>).value;
            if (value !== undefined && typeof value !== 'object') return String(value);
          }
        }
      }
    }
    return null;
  }

  function conditionsFor(expr: unknown): ReadonlyArray<readonly [string, unknown]> {
    if (expr !== null && typeof expr === 'object') {
      const object = expr as Record<string, unknown>;
      if (object.op === 'eq' && object.col !== undefined) {
        const column = object.col as Record<string, unknown>;
        return [[String(column.name ?? 'id'), object.val]];
      }
      if (object.op === 'and' && Array.isArray(object.exprs)) {
        return object.exprs.flatMap((part) => conditionsFor(part));
      }
      const chunks = object.queryChunks;
      if (Array.isArray(chunks)) {
        const conditions: Array<readonly [string, unknown]> = [];
        let column: string | null = null;
        for (const chunk of chunks) {
          if ((typeof chunk === 'string' || typeof chunk === 'number') && column !== null) {
            conditions.push([column, chunk]);
            column = null;
          }
          if (chunk !== null && typeof chunk === 'object') {
            const value = chunk as Record<string, unknown>;
            if (typeof value.name === 'string') column = value.name;
            if (value.value !== undefined && !Array.isArray(value.value) && column !== null) {
              conditions.push([column, value.value]);
              column = null;
            }
            conditions.push(...conditionsFor(chunk));
          }
        }
        return conditions;
      }
    }
    return [];
  }

  /**
   * Identify an aggregate selection the way a real driver does.
   *
   * Drizzle hands `select()` either a column (a `PgColumn` carrying a `name`)
   * or an `SQL` expression (carrying `queryChunks`) such as `count(*)`. A real
   * database answers the latter with one aggregate row rather than a projected
   * row per match, so the fake must too — otherwise it would report a row shape
   * the driver never produces.
   */
  function aggregateAlias(fields: Record<string, unknown> | undefined): string | null {
    if (fields === undefined) return null;
    for (const [alias, expression] of Object.entries(fields)) {
      if (expression === null || typeof expression !== 'object') continue;
      const object = expression as Record<string, unknown>;
      // Real drizzle-orm `count()` is an `SQL` carrying `queryChunks`; unit
      // tests supply the `{ op: 'count' }` marker, the same dual shape this
      // fixture already accepts for `eq`.
      if ('queryChunks' in object || object.op === 'count') {
        return alias;
      }
    }
    return null;
  }

  function selectQuery(
    table: Record<string, unknown>,
    fields: Record<string, unknown> | undefined,
  ): FakeSelectQuery {
    let predicate: unknown = undefined;
    let order: readonly unknown[] = [];
    let limit: number | undefined;
    let offset: number | undefined;
    const query: FakeSelectQuery = {
      where(expression: unknown): FakeSelectQuery {
        predicate = expression;
        recordedCalls.push({ action: 'where', args: { expression } });
        return query;
      },
      orderBy(...expressions: unknown[]): FakeSelectQuery {
        order = expressions;
        return query;
      },
      limit(value: number): FakeSelectQuery {
        limit = value;
        return query;
      },
      offset(value: number): FakeSelectQuery {
        offset = value;
        return query;
      },
      then<TResult1 = Record<string, unknown>[], TResult2 = never>(
        onfulfilled?:
          | ((value: Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        let rows = Array.from(getStore(extractTableName(table)).records.values());
        const conditions = conditionsFor(predicate);
        for (const [field, value] of conditions) {
          rows = rows.filter((row) => row[field] === value);
        }
        const alias = aggregateAlias(fields);
        if (alias !== null) {
          // WHERE has been applied; the aggregate collapses the match set to
          // one row. Ordering and pagination do not apply to a bare count.
          return Promise.resolve([{ [alias]: rows.length }]).then(onfulfilled, onrejected);
        }
        const firstOrder = order[0] as Record<string, unknown> | undefined;
        const field = firstOrder?.col !== undefined
          ? String((firstOrder.col as Record<string, unknown>).name)
          : undefined;
        if (field !== undefined) {
          rows.sort((left, right) => String(left[field]).localeCompare(String(right[field])));
          if (firstOrder?.op === 'desc') rows.reverse();
        }
        rows = rows.slice(offset ?? 0, limit === undefined ? undefined : (offset ?? 0) + limit);
        if (fields !== undefined) {
          rows = rows.map((row) =>
            Object.fromEntries(
              Object.keys(fields).map((fieldName) => [fieldName, row[fieldName]]),
            )
          );
        }
        return Promise.resolve(rows).then(onfulfilled, onrejected);
      },
    };
    return query;
  }

  // Build instance — uses `self` for self-reference in transaction()
  const self = {} as FakeDrizzleInstance;

  Object.assign(self, {
    get connected(): boolean {
      return connected;
    },
    get ended(): boolean {
      return ended;
    },
    get recordedCalls(): RecordedCall[] {
      return recordedCalls;
    },
    get stores(): Record<string, Store> {
      return stores;
    },
    select(fields?: Record<string, unknown>) {
      return {
        from(table: Record<string, unknown>): FakeSelectQuery {
          const tableName = extractTableName(table);
          recordedCalls.push({ action: 'select', entity: tableName, args: { table, fields } });
          return selectQuery(table, fields);
        },
      };
    },
    insert(table: unknown) {
      const tableName = extractTableName(table);
      recordedCalls.push({ action: 'insert', entity: tableName, args: {} });
      return {
        values(
          data: Record<string, unknown> | Record<string, unknown>[],
        ) {
          const items = Array.isArray(data) ? data : [data];
          recordedCalls.push({ action: 'insert', entity: tableName, args: { data: items } });
          return {
            execute: async (): Promise<Record<string, unknown>[]> => {
              const store = getStore(tableName);
              const results: Record<string, unknown>[] = [];
              for (const item of items) {
                const row = { ...item };
                if (row.id === undefined) {
                  store.idCounter += 1;
                  row.id = String(store.idCounter);
                }
                store.records.set(String(row.id), row);
                results.push({ ...row });
              }
              return results;
            },
            async returning(): Promise<Record<string, unknown>[]> {
              return this.execute();
            },
          };
        },
      };
    },
    update(table: unknown) {
      const tableName = extractTableName(table);
      recordedCalls.push({ action: 'update', entity: tableName, args: {} });
      return {
        set(data: Record<string, unknown>) {
          recordedCalls.push({ action: 'update', entity: tableName, args: { data } });
          return {
            async returning(): Promise<Record<string, unknown>[]> {
              return [];
            },
            where(expr: unknown): { returning: () => Promise<Record<string, unknown>[]> } {
              return {
                async returning(): Promise<Record<string, unknown>[]> {
                  const id = extractWhereId(expr);
                  const store = getStore(tableName);
                  if (id) {
                    const existing = store.records.get(id);
                    if (existing) {
                      const updated = { ...existing, ...data };
                      store.records.set(id, updated);
                      return [{ ...updated }];
                    }
                  }
                  return [];
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      const tableName = extractTableName(table);
      recordedCalls.push({ action: 'delete', entity: tableName, args: {} });
      return {
        where(expr: unknown): { returning: () => Promise<Record<string, unknown>[]> } {
          return {
            async returning(): Promise<Record<string, unknown>[]> {
              const id = extractWhereId(expr);
              if (!id) return [];
              const store = getStore(tableName);
              const existing = store.records.get(id);
              if (!existing) return [];
              store.records.delete(id);
              return [{ ...existing }];
            },
          };
        },
      };
    },
    async $count(table: Record<string, unknown>, expr?: unknown): Promise<number> {
      let rows = Array.from(getStore(extractTableName(table)).records.values());
      for (const [field, value] of conditionsFor(expr)) {
        rows = rows.filter((row) => row[field] === value);
      }
      return rows.length;
    },
    async execute(values: unknown): Promise<{ rows: unknown[] }> {
      recordedCalls.push({ action: 'execute', args: { values } });
      return { rows: [] };
    },
    query: {},
    async transaction<T>(cb: (tx: FakeDrizzleInstance) => Promise<T>): Promise<T> {
      return cb(self);
    },
  });

  return self;
}
