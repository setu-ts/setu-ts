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

/**
 * Check whether a record matches a Prisma-style `where` clause.
 * Supports both scalar `{ id: value }` and compound-key `{ <field>: { col1: val1 } }` shapes.
 */
function matchWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const compound = val as Record<string, unknown>;
      return Object.entries(compound).every(([k, v]) => row[k] === v);
    }
    if (row[key] !== val) return false;
  }
  return true;
}

/**
 * Operators the translated `where` can carry inside a field object. An object
 * under a field that carries none of these keys is a compound-key match
 * (`{ tenantId_userId: { tenantId: 't1', userId: 7 } }`) instead.
 */
const OPERATOR_KEYS: ReadonlySet<string> = new Set([
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'path',
]);

/**
 * Evaluate a Prisma-style `where` object against a row — the subset of the
 * operator grammar the adapter emits: flat equality, `AND`/`OR` composition,
 * field operator objects (`equals`/`gt`/`gte`/`lt`/`lte`/`contains`/`in`,
 * optionally under a JSON `path`), and compound-key objects whose every entry
 * must equal the row's fields. A real driver evaluates this grammar on the
 * backend; the fake evaluates it in memory so cursor walks and filter tests
 * exercise the emitted predicate rather than accepting it unexamined.
 *
 * @param row - The candidate row
 * @param where - The `where` input a real Prisma client would receive
 * @returns `true` when the row matches every clause
 */
function matchesPrismaWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (key === 'AND') {
      const clauses = val as Record<string, unknown>[];
      if (!clauses.every((clause) => matchesPrismaWhere(row, clause))) return false;
      continue;
    }
    if (key === 'OR') {
      const clauses = val as Record<string, unknown>[];
      if (!clauses.some((clause) => matchesPrismaWhere(row, clause))) return false;
      continue;
    }
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const cond = val as Record<string, unknown>;
      const keys = Object.keys(cond);
      if (keys.some((k) => OPERATOR_KEYS.has(k))) {
        if (!matchesFieldCondition(row, key, cond)) return false;
        continue;
      }
      // Compound-key object: every named column must equal the row's field.
      if (!keys.every((col) => row[col] === cond[col])) return false;
      continue;
    }
    if (row[key] !== val) return false;
  }
  return true;
}

/**
 * Evaluate one field condition object (`{ gt: v }`, `{ path: [...], in: [...] }`, …).
 *
 * @param row - The candidate row
 * @param field - The root field the condition hangs on
 * @param cond - The operator object under the field
 * @returns `true` when every operator in the condition matches
 */
function matchesFieldCondition(
  row: Record<string, unknown>,
  field: string,
  cond: Record<string, unknown>,
): boolean {
  let target: unknown = row[field];
  const path = cond['path'];
  if (Array.isArray(path)) {
    for (const segment of path) {
      if (target === null || typeof target !== 'object') return false;
      target = (target as Record<string, unknown>)[segment as string];
    }
  }
  for (const [op, value] of Object.entries(cond)) {
    if (op === 'path') continue;
    if (!compareOperator(target, op, value)) return false;
  }
  return true;
}

/**
 * Order two scalar values the way the fake's comparisons need: numeric when
 * both are numbers, lexicographic otherwise.
 *
 * @param a - Left value
 * @param b - Right value
 * @returns A negative number, zero, or a positive number
 */
function compareScalar(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a ?? '');
  const bs = String(b ?? '');
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Apply one comparison/membership operator to a resolved value.
 *
 * @param actual - The row's value (after any `path` navigation)
 * @param op - The operator name
 * @param expected - The operator's operand
 * @returns `true` when the operator matches
 */
function compareOperator(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'equals':
      return actual === expected;
    case 'gt':
      return compareScalar(actual, expected) > 0;
    case 'gte':
      return compareScalar(actual, expected) >= 0;
    case 'lt':
      return compareScalar(actual, expected) < 0;
    case 'lte':
      return compareScalar(actual, expected) <= 0;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' &&
        actual.includes(expected);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    default:
      // An operator shape the fake does not model never matches — the honest
      // wrong answer in a test double, rather than a silent universal match.
      return false;
  }
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
      // Handle compound-key where: { <compoundField>: { col1: val1, col2: val2 } }
      for (const [_key, val] of Object.entries(args.where)) {
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
          const compound = val as Record<string, unknown>;
          const found = Array.from(store.records.values()).find((row) =>
            Object.entries(compound).every(([k, v]) => row[k] === v)
          );
          return found ?? null;
        }
      }
      const id = String(args.where.id ?? args.where[args.where.id ?? 'id']);
      const record = store.records.get(String(id ?? ''));
      return record ?? null;
    },

    async findMany(args) {
      recordedCalls.push({ model: modelName, action: 'findMany', args: args ?? {} });
      let rows = Array.from(store.records.values());

      // Where: evaluate the operator grammar a real driver would (AND/OR,
      // operator objects, compound keys), not only flat equality — a fake that
      // matched nothing for a predicate it never parsed would let a cursor
      // walk "pass" while every page came back empty.
      if (args?.where) {
        const where = args.where;
        rows = rows.filter((row) => matchesPrismaWhere(row, where));
      }

      // Order by: apply the keys in REVERSE declaration order so the FIRST
      // declared key is primary, matching Prisma's lexicographic orderBy
      // semantics (the stable sort keeps the earlier key's order inside ties).
      if (args?.orderBy) {
        const entries = Object.entries(args.orderBy).reverse();
        for (const [key, dir] of entries) {
          const ascending = dir === 'asc' || dir === 'Asc';
          rows.sort((a, b) => {
            const cmp = compareScalar(a[key], b[key]);
            if (cmp === 0) return 0;
            return ascending ? cmp : -cmp;
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
      // Find the key of the matching record in the store
      let key: string | undefined;
      for (const [k, v] of store.records) {
        if (matchWhere(v, args.where)) {
          key = k;
          break;
        }
      }
      if (key === undefined) {
        throw createNotFoundError(modelName, 'composite');
      }
      const existing = store.records.get(key)!;
      const updated = { ...existing, ...args.data };
      store.records.set(key, updated);
      return { ...updated };
    },

    async delete(args: { where: Record<string, unknown> }) {
      recordedCalls.push({ model: modelName, action: 'delete', args });
      let key: string | undefined;
      for (const [k, v] of store.records) {
        if (matchWhere(v, args.where)) {
          key = k;
          break;
        }
      }
      if (key === undefined) {
        throw createNotFoundError(modelName, 'composite');
      }
      const deleted = store.records.get(key)!;
      store.records.delete(key);
      return deleted;
    },

    async count(args) {
      recordedCalls.push({ model: modelName, action: 'count', args: args ?? {} });
      let rows = Array.from(store.records.values());
      if (args?.where) {
        const where = args.where;
        rows = rows.filter((row) => matchesPrismaWhere(row, where));
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

export function createFakePrismaClient(
  options: { activeProvider?: string } = {},
): {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $transaction: <T>(
    fn: (client: ReturnType<typeof createFakePrismaClient>) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
  $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
  connected: boolean;
  disconnected: boolean;
  // The active connector, mirroring the real client's underscore-private
  // `_activeProvider` field that the adapter's structural detection reads.
  // Defaults to `'postgresql'` (an escaping connector) so a `contains` filter
  // translates rather than refuses. To model a client whose provider cannot be
  // detected, build a bare object literal WITHOUT this field: `activeProvider`
  // cannot be passed as `undefined` (that is a compile error under
  // `exactOptionalPropertyTypes`) and would fall back to the default anyway.
  _activeProvider: string;
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
  const activeProvider = options.activeProvider ?? 'postgresql';
  const stores: Record<string, Store> = {
    user: { records: new Map(), idCounter: 0 },
    post: { records: new Map(), idCounter: 0 },
    comment: { records: new Map(), idCounter: 0 },
  };

  const client = {
    _activeProvider: activeProvider,
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
