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
    from: (table: string) => Promise<Record<string, unknown>[]>;
    where: (expr: unknown) => Promise<Record<string, unknown>[]>;
  };
  insert: (table: string) => {
    values: (
      data: Record<string, unknown> | Record<string, unknown>[],
    ) => {
      execute: () => Promise<Record<string, unknown>[]>;
    };
  };
  update: (table: string) => {
    set: (data: Record<string, unknown>) => {
      where: (expr: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
  delete: (table: string) => {
    where: (expr: unknown) => Promise<void>;
  };
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
    }
    return null;
  }

  // Helper — extract table name from expression for select().where()
  function extractTableFromExpr(expr: unknown): string | null {
    if (expr && typeof expr === 'object' && !Array.isArray(expr)) {
      const obj = expr as Record<string, unknown>;
      if ('_table' in obj) {
        return String(obj._table);
      }
    }
    return null;
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
    select() {
      return {
        async from(table: unknown): Promise<Record<string, unknown>[]> {
          const tableName = extractTableName(table);
          recordedCalls.push({ action: 'select', entity: tableName, args: { table } });
          return Array.from(getStore(tableName).records.values());
        },
        async where(expr: unknown): Promise<Record<string, unknown>[]> {
          const table = extractTableFromExpr(expr) ?? 'unknown';
          recordedCalls.push({ action: 'select', entity: table, args: { expr } });
          const allRecords = Array.from(getStore(table).records.values());
          const id = extractWhereId(expr);
          if (id) {
            return [getStore(table).records.get(id) ?? null].filter(
              (r): r is Record<string, unknown> => r !== null,
            );
          }
          return allRecords;
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
            async execute(): Promise<Record<string, unknown>[]> {
              const store = getStore(tableName);
              const results: Record<string, unknown>[] = [];
              for (const item of items) {
                const row = { ...item };
                if (row.id === undefined) {
                  store.idCounter += 1;
                  row.id = String(store.idCounter);
                }
                const id = String(row.id);
                store.records.set(id, row);
                results.push({ ...row });
              }
              return results;
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
            async where(expr: unknown): Promise<Record<string, unknown>[]> {
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
    delete(table: unknown) {
      const tableName = extractTableName(table);
      recordedCalls.push({ action: 'delete', entity: tableName, args: {} });
      return {
        async where(expr: unknown): Promise<void> {
          const id = extractWhereId(expr);
          if (id) {
            getStore(tableName).records.delete(id);
          }
        },
      };
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
