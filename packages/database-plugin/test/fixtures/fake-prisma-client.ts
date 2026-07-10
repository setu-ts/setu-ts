// deno-lint-ignore-file require-await -- async methods must match real Prisma client interface
/**
 * Fake Prisma client for unit testing the PrismaAdapter.
 *
 * Honors the real Prisma v7 client shape:
 * - `$connect` / `$disconnect` — connection lifecycle
 * - `$transaction(fn)` — callback-style transaction (passes tx client to fn)
 * - `$queryRawUnsafe(sql, ...params)` — raw SQL queries
 * - Model delegates (`user`, `post`, etc.) with in-memory store
 * - **NO** `$use` / `middlewares` — those do not exist on real Prisma v7
 *
 * Delegates throw `{ code: 'P2025' }`-shaped errors on `update`/`delete`
 * when the row is missing, matching real Prisma behavior.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// In-memory store per delegate
// ---------------------------------------------------------------------------

interface Store {
  records: Map<string, Record<string, unknown>>;
  idCounter: number;
}

// ---------------------------------------------------------------------------
// Recorded calls for test assertions
// ---------------------------------------------------------------------------

export interface RecordedCall {
  model: string;
  action: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// P2025 error — real Prisma throws this when a row is not found
// ---------------------------------------------------------------------------

function createNotFoundError(model: string, id: unknown): Error {
  const error = new Error(
    `Record ${model} with id ${id} does not exist.`,
  );
  (error as unknown as Record<string, unknown>).code = 'P2025';
  return error;
}

// ---------------------------------------------------------------------------
// Delegate factory — creates a model delegate backed by an in-memory store
// ---------------------------------------------------------------------------

function createDelegate(
  modelName: string,
  store: Store,
  recordedCalls: RecordedCall[],
): {
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
    skip?: number;
    select?: Record<string, unknown>;
  }): Promise<Record<string, unknown>[]>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  delete(args: { where: Record<string, unknown> }): Promise<Record<string, unknown>>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
} {
  return {
    async findUnique(args: { where: Record<string, unknown> }) {
      recordedCalls.push({ model: modelName, action: 'findUnique', args });
      const id = String(args.where.id ?? args.where[args.where.id ?? 'id']);
      const record = store.records.get(String(id ?? ''));
      return record ?? null;
    },

    async findMany(args) {
      recordedCalls.push({ model: modelName, action: 'findMany', args: args ?? {} });
      let rows = Array.from(store.records.values());

      // Simple where filter
      if (args?.where) {
        const where = args.where;
        rows = rows.filter((row) => {
          for (const [key, val] of Object.entries(where)) {
            if (row[key] !== val) return false;
          }
          return true;
        });
      }

      // Order by (simple asc)
      if (args?.orderBy) {
        for (const [key, dir] of Object.entries(args.orderBy)) {
          const ascending = dir === 'asc' || dir === 'Asc';
          rows.sort((a, b) => {
            const av = String(a[key] ?? '');
            const bv = String(b[key] ?? '');
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
            return 0;
          });
        }
      }

      // Skip
      if (args?.skip) {
        rows = rows.slice(args.skip);
      }

      // Take (limit)
      if (args?.take) {
        rows = rows.slice(0, args.take);
      }

      // Select (projection)
      if (args?.select) {
        const keys = Object.keys(args.select);
        rows = rows.map((row) => {
          const projected: Record<string, unknown> = {};
          for (const key of keys) {
            projected[key] = row[key];
          }
          return projected;
        });
      }

      return rows;
    },

    async create(args: { data: Record<string, unknown> }) {
      recordedCalls.push({ model: modelName, action: 'create', args });
      const data = { ...args.data };
      if (data.id === undefined) {
        store.idCounter += 1;
        data.id = String(store.idCounter);
      }
      const id = String(data.id);
      store.records.set(id, data);
      return { ...data };
    },

    async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      recordedCalls.push({ model: modelName, action: 'update', args });
      const id = String(args.where.id ?? args.where[args.where.id ?? 'id']);
      const existing = store.records.get(id);
      if (!existing) {
        throw createNotFoundError(modelName, id);
      }
      const updated = { ...existing, ...args.data };
      store.records.set(id, updated);
      return { ...updated };
    },

    async delete(args: { where: Record<string, unknown> }) {
      recordedCalls.push({ model: modelName, action: 'delete', args });
      const id = String(args.where.id ?? args.where[args.where.id ?? 'id']);
      const existing = store.records.get(id);
      if (!existing) {
        throw createNotFoundError(modelName, id);
      }
      const deleted = { ...existing };
      store.records.delete(id);
      return deleted;
    },

    async count(args) {
      recordedCalls.push({ model: modelName, action: 'count', args: args ?? {} });
      let rows = Array.from(store.records.values());
      if (args?.where) {
        const where = args.where;
        rows = rows.filter((row) => {
          for (const [key, val] of Object.entries(where)) {
            if (row[key] !== val) return false;
          }
          return true;
        });
      }
      return rows.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

/**
 * Create a fake Prisma client instance matching the real v7 shape.
 *
 * The client has an in-memory store per model delegate, recorded calls list,
 * and proper transaction scoping via `$transaction(fn)`.
 */
// Forward-declared type to avoid self-referential implicit 'any' on `const client = { ... }`
type FakePrismaClient = ReturnType<typeof createFakePrismaClient>;

export function createFakePrismaClient(): {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $transaction: <T>(
    fn: (client: ReturnType<typeof createFakePrismaClient>) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
  $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
  connected: boolean;
  disconnected: boolean;
  // Recorded calls for test assertions
  recordedCalls: RecordedCall[];
  // Model delegates — accessed by lowercase name (e.g. `client.user`)
  user: ReturnType<typeof createDelegate>;
  post: ReturnType<typeof createDelegate>;
  comment: ReturnType<typeof createDelegate>;
  // Underlying stores for direct inspection in tests
  stores: Record<string, Store>;
} {
  let connected = false;
  let disconnected = false;
  const recordedCalls: RecordedCall[] = [];
  const stores: Record<string, Store> = {
    user: { records: new Map(), idCounter: 0 },
    post: { records: new Map(), idCounter: 0 },
    comment: { records: new Map(), idCounter: 0 },
  };

  const client = {
    get connected() {
      return connected;
    },
    get disconnected() {
      return disconnected;
    },
    get recordedCalls() {
      return recordedCalls;
    },
    get stores() {
      return stores;
    },
    async $connect() {
      connected = true;
      disconnected = false;
    },
    async $disconnect() {
      disconnected = true;
      connected = false;
    },
    async $transaction<T>(
      fn: (tx: FakePrismaClient) => Promise<T>,
      _options?: { maxWait?: number; timeout?: number },
    ): Promise<T> {
      // Pass the same client as the tx handle (real Prisma does this)
      return fn(client);
    },
    async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      recordedCalls.push({
        model: '_queryRawUnsafe',
        action: 'execute',
        args: { sql, params },
      });
      return [] as T[];
    },
    user: createDelegate('User', stores.user, recordedCalls),
    post: createDelegate('Post', stores.post, recordedCalls),
    comment: createDelegate('Comment', stores.comment, recordedCalls),
  };

  return client;
}
