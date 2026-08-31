/**
 * In-memory fakes for the native `mongodb` driver's structural types.
 *
 * The Mongo adapter operates against the driver's *shapes* (`mongo-client-types.ts`),
 * never its classes, so a faithful double that honours the documented return
 * shapes (`insertOne` → `{ acknowledged, insertedId }`, `findOneAndUpdate` → the
 * document directly, `deleteOne` → `{ deletedCount }`) is assignable to
 * `IMongoClient`/`IMongoCollection`. This double actually stores documents and
 * evaluates the native operators the query builder emits (`$regex`, `$and`/`$or`,
 * `$eq`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`, plus `sort`/`skip`/`limit`/`projection`),
 * so the six `IDataSource` methods are exercised end to end rather than against a
 * canned response — the recurring contract-violating-double this fixture exists to
 * prevent (milestone §1.1).
 *
 * @internal
 */
import type {
  IMongoClient,
  IMongoCollection,
  IMongoCollectionFindOneAndUpdateOptions,
  IMongoCursor,
  IMongoDatabase,
  IMongoObjectId,
  IMongoObjectIdCtor,
  IMongoSession,
  MongoOptions,
} from '../../src/adapters/mongo/mongo-client-types.ts';

/** A fake `ObjectId` — a 24-hex string with a `toString()`, matching the driver. */
export class FakeObjectId implements IMongoObjectId {
  readonly #value: string;

  constructor(value?: string) {
    this.#value = value ?? Math.random().toString(16).slice(2, 26).padEnd(24, '0');
  }

  toString(): string {
    return this.#value;
  }
}

const HEX24 = /^[0-9a-f]{24}$/;

/**
 * A fake `ObjectId` constructor implementing the `isValid` (24-hex) and `new`
 * members the mapping's `'auto'` branch needs, so the fake drives the same
 * conversion path the real driver does. Written as a callable with an attached
 * `isValid` so it carries the `new` signature the `IMongoObjectIdCtor` shape
 * requires (a plain object literal cannot declare `new`).
 */
export const fakeObjectIdCtor = Object.assign(
  function fakeObjectIdCtorCtor(value?: string): IMongoObjectId {
    // The real constructor throws for anything that is not a 24-hex string, a
    // 12-byte Uint8Array, or an integer — including the numeric values its own
    // `isValid` accepts. Reproducing the throw is what lets this double fail
    // when the adapter converts something it should have passed through.
    if (value !== undefined && !HEX24.test(String(value))) {
      throw new Error(
        'input must be a 24 character hex string, 12 byte Uint8Array, or an integer',
      );
    }
    return new FakeObjectId(value);
  },
  {
    // Mirrors the REAL driver rather than what the adapter wants: measured on
    // `mongodb@6.21.0`, `ObjectId.isValid` answers `true` for ANY number
    // (`isValid(5)`, `isValid(0)`, `isValid(1234567890)`) while
    // `new ObjectId('5')` throws. A double that answered `false` for a number
    // hid exactly that divergence, so a numeric primary key threw a raw
    // `BSONError` on every entry point while this suite stayed green.
    isValid(value: unknown): boolean {
      if (typeof value === 'number') return true;
      return typeof value === 'string' && HEX24.test(value);
    },
  },
) as unknown as IMongoObjectIdCtor;

/** Evaluates a single field against a condition, honouring the native operators. */
function matchCondition(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    const ops = cond as Record<string, unknown>;
    if (!Object.keys(ops).some((key) => key.startsWith('$'))) {
      return sameMongoValue(actual, cond);
    }
    for (const [op, expected] of Object.entries(ops)) {
      // `$options` accompanies `$regex` (case sensitivity follows the
      // collection's collation); it is not itself a match operator.
      if (op === '$options') continue;
      switch (op) {
        case '$eq':
          if (!sameMongoValue(actual, expected)) return false;
          break;
        case '$gt':
          if (Number(actual) <= Number(expected)) return false;
          break;
        case '$gte':
          if (Number(actual) < Number(expected)) return false;
          break;
        case '$lt':
          if (Number(actual) >= Number(expected)) return false;
          break;
        case '$lte':
          if (Number(actual) > Number(expected)) return false;
          break;
        case '$in': {
          const arr = expected as unknown[];
          if (!arr.some((v) => sameMongoValue(v, actual))) return false;
          break;
        }
        case '$regex': {
          const opts = (ops.$options as string) ?? '';
          const re = new RegExp(String(expected), opts);
          if (!re.test(String(actual))) return false;
          break;
        }
        default:
          throw new Error(`fake-mongo: unhandled operator '${op}'`);
      }
    }
    return true;
  }
  return sameMongoValue(actual, cond);
}

/** Compares scalar values with the driver's ObjectId value semantics. */
function sameMongoValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    return String(left) === String(right);
  }
  return false;
}

/** Evaluates a whole match filter against a document. */
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as unknown[]).every((f) => matchFilter(doc, f as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === '$or') {
      if (!(cond as unknown[]).some((f) => matchFilter(doc, f as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (!matchCondition(doc[key], cond)) return false;
  }
  return true;
}

function project(
  row: Record<string, unknown>,
  projection: Record<string, 0 | 1>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, keep] of Object.entries(projection)) {
    if (keep === 1) out[field] = row[field];
  }
  return out;
}

/**
 * An in-memory `IMongoCollection` that stores documents and evaluates the native
 * operators the query builder emits, so the six `IDataSource` methods run
 * against real data rather than a canned response.
 */
export class FakeMongoCollection implements IMongoCollection {
  readonly #docs: Record<string, unknown>[] = [];
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async insertOne(
    document: Record<string, unknown>,
    _options?: MongoOptions,
  ): Promise<{ acknowledged: boolean; insertedId: IMongoObjectId | string | number }> {
    this.calls.push({ method: 'insertOne', args: [document, _options] });
    let id: IMongoObjectId | string | number = document._id as IMongoObjectId | string | number;
    if (id === undefined || id === null) {
      id = new FakeObjectId();
    }
    // Preserve the driver's value. A real collection stores an ObjectId as an
    // ObjectId, not as its string rendering; `sameMongoValue` mirrors the
    // driver's value comparison for this structural fake.
    const stored: Record<string, unknown> = { ...document, _id: id };
    const idx = this.#docs.findIndex((d) => String(d._id) === String(id));
    if (idx >= 0) {
      this.#docs[idx] = stored;
    } else {
      this.#docs.push(stored);
    }
    return { acknowledged: true, insertedId: id };
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async findOne(
    filter: Record<string, unknown>,
    _options?: MongoOptions & {
      projection?: Record<string, 0 | 1>;
      sort?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown> | null> {
    this.calls.push({ method: 'findOne', args: [filter, _options] });
    const found = this.#docs.find((d) => matchFilter(d, filter));
    return found ? { ...found } : null;
  }

  find(
    filter: Record<string, unknown>,
    options?: MongoOptions & {
      sort?: Record<string, unknown>;
      skip?: number;
      limit?: number;
      projection?: Record<string, 0 | 1>;
    },
  ): IMongoCursor {
    this.calls.push({ method: 'find', args: [filter, options] });
    let rows = this.#docs.filter((d) => matchFilter(d, filter));
    if (options?.sort !== undefined) {
      // EVERY sort key, in declared order, with a type-aware comparison. The
      // previous build read `Object.entries(sort)[0]` alone and compared with
      // `Number(av) > Number(bv)`, so a multi-key sort silently ignored its
      // tiebreakers and a STRING key coerced to `NaN` on both sides — where
      // the comparator answers `-1` unconditionally and reverses the array.
      // The real driver (mongod 8) honours every key and accepts `1`/`-1` as
      // well as `'asc'`/`'desc'`, so a double doing less than that hides a
      // sort defect instead of exposing it.
      const keys = Object.entries(options.sort);
      rows = [...rows].sort((a, b) => {
        for (const [field, dir] of keys) {
          const descending = dir === 'desc' || dir === 'descending' || dir === -1;
          const cmp = compareForSort(a[field], b[field]);
          if (cmp !== 0) return descending ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (options?.skip !== undefined) rows = rows.slice(options.skip);
    // The real driver treats `limit: 0` as UNLIMITED, not as "no rows"
    // (measured against mongod 8). Slicing to zero here would make the double
    // disagree with the server the adapter actually runs against, which is how
    // a fake hides a defect rather than exposing one — and it would also
    // disagree with the framework's own `applyPagination`, where `limit > 0`
    // gates the slice.
    if (options?.limit !== undefined && options.limit > 0) rows = rows.slice(0, options.limit);
    const projection = options?.projection;
    const result = projection !== undefined
      ? rows.map((r) => project(r, projection))
      : rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) out[k] = v;
        return out;
      });
    return { toArray: (): Promise<Record<string, unknown>[]> => Promise.resolve(result) };
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: IMongoCollectionFindOneAndUpdateOptions,
  ): Promise<Record<string, unknown> | null> {
    this.calls.push({ method: 'findOneAndUpdate', args: [filter, update, options] });
    const idx = this.#docs.findIndex((d) => matchFilter(d, filter));
    if (idx < 0) return null;
    // Snapshot BEFORE mutating: the real driver's `returnDocument: 'before'`
    // answers with the pre-update document. Reading the slot after the write
    // returned the post-update one, so the double contradicted the very
    // contract this file exists to hold it to.
    const before = { ...this.#docs[idx] };
    const updated = applySet(this.#docs[idx], update);
    this.#docs[idx] = updated;
    return options.returnDocument === 'before' ? before : { ...updated };
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async deleteOne(
    filter: Record<string, unknown>,
    _options?: MongoOptions,
  ): Promise<{ deletedCount: number }> {
    this.calls.push({ method: 'deleteOne', args: [filter, _options] });
    const idx = this.#docs.findIndex((d) => matchFilter(d, filter));
    if (idx < 0) return { deletedCount: 0 };
    this.#docs.splice(idx, 1);
    return { deletedCount: 1 };
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async countDocuments(
    filter: Record<string, unknown>,
    _options?: MongoOptions,
  ): Promise<number> {
    this.calls.push({ method: 'countDocuments', args: [filter, _options] });
    return this.#docs.filter((d) => matchFilter(d, filter)).length;
  }
}

/** Applies a `$set` update to a document, returning the updated copy. */
function applySet(
  doc: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...doc };
  const set = (update as Record<string, Record<string, unknown>>).$set;
  if (set !== undefined) {
    Object.assign(result, set);
  }
  return result;
}

/**
 * An in-memory `IMongoDatabase` that hands out a single shared
 * {@linkcode FakeMongoCollection} per name, so a test can drive the whole
 * `createDataSource` path through a real `db().collection()` chain.
 */
export class FakeMongoDatabase implements IMongoDatabase {
  readonly #collections = new Map<string, FakeMongoCollection>();

  collection(name: string): FakeMongoCollection {
    // The real driver returns the same collection instance per name, so the
    // fake caches it — otherwise each IDataSource method would call
    // `collection()` and operate on an empty collection.
    let col = this.#collections.get(name);
    if (col === undefined) {
      col = new FakeMongoCollection();
      this.#collections.set(name, col);
    }
    return col;
  }
}

/** An in-memory `IMongoClient` that never performs network I/O. */
/**
 * Compare two field values the way mongod orders them for a `sort`.
 *
 * Numbers compare numerically, strings lexicographically, and dates by
 * instant; `null`/`undefined` sort before any present value. A `Number()`
 * coercion cannot stand in for this — it answers `NaN` for every string, which
 * makes a comparator return the same sign for every pair.
 *
 * @param a - The left value
 * @param b - The right value
 * @returns A negative number, zero, or a positive number
 */
function compareForSort(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? -1 : 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  const as = String(av);
  const bs = String(bv);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export class FakeMongoClient implements IMongoClient {
  #connected = false;
  readonly databases = new Map<string, FakeMongoDatabase>();

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async connect(): Promise<void> {
    this.#connected = true;
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async close(): Promise<void> {
    this.#connected = false;
  }

  isReady(): boolean {
    return this.#connected;
  }

  db(name: string): FakeMongoDatabase {
    let db = this.databases.get(name);
    if (db === undefined) {
      db = new FakeMongoDatabase();
      this.databases.set(name, db);
    }
    return db;
  }

  startSession(): FakeSession {
    return new FakeSession();
  }
}

/** A session that records the transaction lifecycle the adapter drives. */
export class FakeSession implements IMongoSession {
  readonly calls: string[] = [];
  #started = false;
  readonly #throwOnStart: boolean;

  constructor(throwOnStart = false) {
    this.#throwOnStart = throwOnStart;
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async startTransaction(_options?: Record<string, unknown>): Promise<void> {
    if (this.#throwOnStart) {
      throw new Error('not allowed on a standalone mongod');
    }
    this.calls.push('startTransaction');
    this.#started = true;
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async commitTransaction(): Promise<void> {
    this.calls.push('commitTransaction');
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async abortTransaction(): Promise<void> {
    this.calls.push('abortTransaction');
  }

  // deno-lint-ignore require-await -- in-memory double, resolves synchronously
  async endSession(): Promise<void> {
    this.calls.push('endSession');
  }

  get started(): boolean {
    return this.#started;
  }
}

/**
 * A client whose `startSession` returns a {@linkcode FakeSession} that throws on
 * `startTransaction`, so the adapter's non-replica-set refusal path is driven
 * through the injected-client seam with a real session object.
 */
export class FakeSessionClient extends FakeMongoClient {
  readonly #session: FakeSession;

  constructor(session: FakeSession) {
    super();
    this.#session = session;
  }

  override startSession(): FakeSession {
    return this.#session;
  }
}
