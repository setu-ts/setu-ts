/**
 * Per-entity mapping for the Mongo adapter — how an entity name collapses onto
 * a physical collection and how a document's `_id` maps onto the repository's
 * primary key.
 *
 * This is the Mongo half of the two-layer shape `cloudflare-plugin`'s
 * `D1EntityMapping` → `D1Target` established (M52c): a public, per-entity
 * override with a zero-config default, collapsed into an internal, unexported
 * target the query builders consume. The public type is the surface; the
 * internal target is what the code actually reads.
 *
 * @module
 */
import type { IMongoObjectId, IMongoObjectIdCtor } from './mongo-client-types.ts';

/**
 * How one entity name maps onto a physical Mongo collection.
 *
 * @since 0.1.0
 */
export interface MongoEntityMapping {
  /**
   * The collection name. Defaults to the entity name itself, so
   * `getRepository('users')` needs no mapping at all.
   */
  readonly collection?: string;

  /**
   * The primary-key field name(s). Defaults to `'id'`.
   *
   * A scalar names a single-column key (the driver's `_id` maps to that one
   * field). An array names a composite key: each named column is a top-level
   * field on the collection (`idType` absent) or, when `idType: 'compound'`,
   * the keys of the subdocument stored under the driver's `_id` in the
   * mapping's declared order (P4/P5).
   */
  readonly primaryKey?: string | readonly string[];

  /**
   * How the collection stores its `_id` values.
   *
   * - `'objectId'` forces the id to a driver `ObjectId` on read and write.
   * - `'raw'` forbids conversion, so a `string` id is passed to the driver
   *   verbatim.
   * - `'compound'` stores a composite key as a subdocument `_id`, built in the
   *   mapping's declared column order (P5 — canonical order, not caller order).
   *   Absent converts a **string** id that `ObjectId.isValid` accepts — a
   *   24-hex string. A non-string id (a `number` key) is passed through
   *   verbatim, because the driver's `isValid` answers `true` for any number
   *   while its constructor rejects one.
   *
   * The genuinely ambiguous collection — one whose `_id` values are 24-hex
   * **strings** rather than `ObjectId`s — cannot be distinguished at runtime,
   * so the override exists rather than being guessed.
   */
  readonly idType?: 'objectId' | 'raw' | 'compound';
}

/**
 * The resolved, per-entity target the Mongo query builder consumes.
 *
 * This is the internal half of the two-layer mapping: the public
 * {@linkcode MongoEntityMapping} is the override bag, and this is the
 * concrete collection name, primary-key columns, and id strategy the builders
 * read. It is deliberately NOT exported — the mapping surface is the public
 * type, and leaking the resolved target would make one adapter's collection
 * naming part of the package's published contract (the M56 defect class).
 *
 * @internal
 */
export interface MongoTarget {
  /** The collection name. */
  readonly collection: string;
  /**
   * The primary-key column names a caller addresses. Normalised to an array:
   * a scalar mapping yields `['id']`, a composite mapping passes through.
   */
  readonly primaryKey: readonly string[];
  /** How the collection stores its `_id` values. */
  readonly idType: 'objectId' | 'raw' | 'compound' | 'auto';
}

/** The `_id` field the native driver stores every document under. */
const DRIVER_ID_FIELD = '_id';

/** The primary-key name assumed for an entity with no explicit mapping. */
const DEFAULT_PRIMARY_KEY = 'id';

/**
 * A structural subset of the driver `ObjectId` — enough for the conversion
 * rules the mapping owns.
 *
 * The real class is imported lazily; the mapping only needs `isValid` and the
 * instance's `toString`, both of which this records.
 *
 * @since 0.1.0
 */
export type { IMongoObjectId };

/**
 * Resolves an entity name to its collection name, primary-key name, and id
 * strategy.
 *
 * An entity with no mapping entry uses its own name as the collection and
 * `'id'` as the key, which is why the zero-config path works for a schema
 * whose collection names already match.
 *
 * @param entity - The entity name passed to `getRepository()`
 * @param mapping - The per-entity overrides, or none
 * @returns The resolved target
 * @since 0.1.0
 */
export function resolveMongoTarget(
  entity: string,
  mapping: Readonly<Record<string, MongoEntityMapping>> | undefined,
): MongoTarget {
  const override = mapping?.[entity];
  const rawKey = override?.primaryKey ?? DEFAULT_PRIMARY_KEY;
  return {
    collection: override?.collection ?? entity,
    // Normalise to an array: a scalar overrides yield a one-element list; a
    // composite overrides pass through unchanged. Callers on MongoTarget.read
    // primaryKey never see a bare string — every builder treats it as an array.
    primaryKey: Array.isArray(rawKey) ? rawKey : [rawKey],
    // The adapter resolves the strategy once at connect() into a value the
    // data source carries; 'auto' is the unresolved form of the optional type.
    idType: override?.idType ?? 'auto',
  };
}

/**
 * Maps a driver document onto the repository's row: the mapped primary-key
 * field carries the `_id` value, and `_id` is removed so the row never leaks
 * the driver's field name.
 *
 * The value is passed through {@linkcode fromDriverId}: a JSON scalar keeps its
 * own type so the key round-trips through `findById`, while an `ObjectId` is
 * rendered as its 24-hex string, because returning the instance would break
 * `JSON.stringify` round-tripping in handlers.
 *
 * @param document - The raw driver document
 * @param target - The resolved entity target
 * @returns A shallow copy with `_id` renamed to the mapped primary key
 * @since 0.1.0
 */
export function fromDriverDocument(
  document: Record<string, unknown>,
  target: MongoTarget,
): Record<string, unknown> {
  const row: Record<string, unknown> = { ...document };
  const rawId = row[DRIVER_ID_FIELD];
  if (rawId !== undefined) {
    if (
      target.idType === 'compound' && Array.isArray(target.primaryKey) &&
      target.primaryKey.length > 1
    ) {
      // A compound-_id subdocument stores one field per column. Read them out
      // in the mapping's declared order so the row carries the keys the caller
      // sees regardless of the document's internal field order. The _id field
      // itself is dropped from the row since the columns now carry the values.
      const compound = rawId as Record<string, unknown> | null;
      if (compound !== null && typeof compound === 'object') {
        for (const col of target.primaryKey) {
          row[col] = compound[col];
        }
      }
      delete row[DRIVER_ID_FIELD];
    } else if (Array.isArray(target.primaryKey) && target.primaryKey.length > 1) {
      // Flat composite — each named column is a top-level field on the
      // collection, NOT under `_id`. The raw _id (if any) is dropped.
      delete row[DRIVER_ID_FIELD];
    } else {
      // Scalar path — a single field carries the _id value. When the target's
      // declared primary-key column IS the driver's own `_id` field, keep it
      // instead of overwriting it with a renamed copy and then deleting the
      // original.
      const key = target.primaryKey[0];
      if (key !== DRIVER_ID_FIELD) {
        row[key] = fromDriverId(rawId);
        delete row[DRIVER_ID_FIELD];
      }
    }
  }
  return row;
}

/**
 * Converts a driver `_id` into the value the repository row carries.
 *
 * A JSON scalar (`string`, `number`, `boolean`, `null`) is preserved with its
 * own type, so a collection keyed by application-assigned numbers round-trips:
 * `create()` returns the key it was given and `findById(row.id)` finds the row
 * again — the behaviour every other adapter has (the Memory reference returns
 * `{ id: 7 }`, not `{ id: '7' }`). Stringifying a scalar made that call miss
 * silently, because `'7'` is a legitimately different key from `7` and no
 * runtime test can tell which the collection meant.
 *
 * Anything else — an `ObjectId` above all — is rendered with
 * {@linkcode toIdString}, because returning the instance would break
 * `JSON.stringify` round-tripping in a handler and the 24-hex string is the
 * form callers address. `toDriverId` converts that string back, so the
 * `ObjectId` case round-trips too. An exotic non-scalar key (a `Date`, a
 * `Binary`) is rendered but does NOT round-trip through `findById`; use
 * `idType: 'raw'` and address such a collection through the injected client.
 *
 * @param value - The raw driver `_id`
 * @returns The repository-visible primary-key value
 * @since 0.1.0
 */
export function fromDriverId(value: unknown): unknown {
  const kind = typeof value;
  if (value === null || kind === 'string' || kind === 'number' || kind === 'boolean') {
    return value;
  }
  return toIdString(value);
}

/**
 * Maps a repository row onto what the driver stores: the mapped primary-key
 * field is translated to `_id`.
 *
 * A supplied primary-key value is converted to an `ObjectId` when the target
 * uses `'objectId'` ids, so a `string` id does not miss an `ObjectId` `_id`
 * (§1.1 of the milestone) — it must be a conversion, not a defensive option.
 *
 * @param row - The row a caller supplied
 * @param target - The resolved entity target
 * @param objectIdCtor - The driver `ObjectId` constructor (for the `'objectId'` branch)
 * @returns A shallow copy with the primary-key field renamed to `_id`
 * @since 0.1.0
 */
export function toDriverDocument(
  row: Record<string, unknown>,
  target: MongoTarget,
  objectIdCtor?: IMongoObjectIdCtor,
): Record<string, unknown> {
  const document: Record<string, unknown> = { ...row };
  if (
    target.idType === 'compound' && Array.isArray(target.primaryKey) && target.primaryKey.length > 1
  ) {
    // A compound-_id collection stores the composite key as a subdocument
    // _id in the mapping's declared column order (P5). Every named column is
    // extracted from the row and assembled into the subdocument; the driver
    // does not accept the raw fields alongside `_id` for a compound _id.
    // EVERY key column must be present, not merely one of them. A compound
    // `_id` subdocument is matched by exact equality (P4), so a PARTIAL
    // subdocument writes a document that no `findById` can ever retrieve —
    // the read path already requires every column. Partial keys therefore
    // fall through to the flat path rather than writing an unreachable row.
    const compound: Record<string, unknown> = {};
    for (const col of target.primaryKey) {
      if (Object.prototype.hasOwnProperty.call(row, col)) {
        compound[col] = row[col];
      }
    }
    if (Object.keys(compound).length === target.primaryKey.length) {
      for (const col of target.primaryKey) {
        delete document[col];
      }
      document[DRIVER_ID_FIELD] = compound;
    }
    return document;
  }
  if (Array.isArray(target.primaryKey) && target.primaryKey.length > 1) {
    // Flat composite — each named column stays as a top-level field on the
    // collection. No `_id` rename, no special handling. The row passes
    // through unchanged (the caller's data becomes the document directly).
    return document;
  }
  // Scalar path: map the named column onto `_id`.
  const key = target.primaryKey[0];
  if (key !== undefined && Object.prototype.hasOwnProperty.call(document, key)) {
    const converted = toDriverId(document[key], target.idType, objectIdCtor);
    // When the target's declared key IS the driver's own field, the rename
    // would be a no-op write followed by a delete — which drops the id. Keep
    // the field in place instead.
    if (key !== DRIVER_ID_FIELD) {
      delete document[key];
    }
    document[DRIVER_ID_FIELD] = converted;
  }
  return document;
}

/**
 * Converts a driver id value to the string a caller addresses.
 *
 * An `ObjectId` serializes to its 24-hex string. Callers reach this through
 * {@linkcode fromDriverId}, which returns every JSON scalar — `null` included —
 * before this is called, so a nullish value never arrives here.
 *
 * @param value - The driver id value; never `null` or `undefined`
 * @returns The id as a string
 * @since 0.1.0
 */
export function toIdString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof (value as { toString?: unknown }).toString === 'function') {
    const str = (value as { toString(): string }).toString();
    if (typeof str === 'string') return str;
  }
  // Last resort for a value with no callable `toString` — a null-prototype
  // object. `String(value)` THROWS `TypeError: Cannot convert object to
  // primitive value` there, and a renderer that throws while rendering is the
  // defect class this fallback exists to avoid.
  return Object.prototype.toString.call(value);
}

/**
 * Converts a repository id value to the form the driver stores, honoring the
 * target's `idType`.
 *
 * - `'raw'` passes the value through verbatim, so a 24-hex string id is
 *   stored as a string rather than an `ObjectId`.
 * - `'objectId'` converts a valid 24-hex string to an `ObjectId`; a value that
 *   `ObjectId.isValid` rejects is a configuration fault, so it throws naming
 *   the offending value.
 * - `'auto'` converts a **string** the driver's `ObjectId.isValid` accepts (a
 *   24-hex string) and passes everything else through, including a numeric
 *   primary key — see {@linkcode isObjectIdHex} for why the string test is
 *   required rather than defensive.
 *
 * @param value - The repository id value
 * @param idType - The target's id strategy
 * @param objectIdCtor - The driver `ObjectId` constructor; required when `idType` converts
 * @returns The id in driver form
 * @since 0.1.0
 */
export function toDriverId(
  value: unknown,
  idType: 'objectId' | 'raw' | 'compound' | 'auto',
  objectIdCtor?: IMongoObjectIdCtor,
): unknown {
  if (idType === 'raw') return value;
  if (idType === 'objectId') {
    if (objectIdCtor === undefined) {
      throw new Error('MongoAdapter needs the driver ObjectId to map objectId ids');
    }
    if (!isObjectIdHex(value, objectIdCtor)) {
      throw new Error(
        `Cannot map id '${String(value)}' to ObjectId: it is not a valid 24-hex id`,
      );
    }
    return new objectIdCtor(value);
  }
  // idType === 'auto'
  if (objectIdCtor !== undefined && isObjectIdHex(value, objectIdCtor)) {
    return new objectIdCtor(value);
  }
  return value;
}

/**
 * Tests whether a repository id is a 24-hex string the driver can construct an
 * `ObjectId` from.
 *
 * The `typeof value === 'string'` half is load-bearing rather than defensive:
 * the real driver's `ObjectId.isValid` returns `true` for **any number**
 * (measured on `mongodb@6.21.0` — `isValid(5)`, `isValid(0)` and
 * `isValid(1234567890)` are all `true`), while `new ObjectId('5')` throws
 * `BSONError: input must be a 24 character hex string, 12 byte Uint8Array, or
 * an integer`. `IDataSource.findById`/`update`/`delete` accept an `EntityKey`,
 * whose scalar arms are `string` and `number`, so a collection keyed by
 * application-assigned numbers reached that throw on every entry point under
 * the default `'auto'` mapping.
 *
 * @param value - The repository id value
 * @param objectIdCtor - The driver `ObjectId` constructor
 * @returns `true` when the value is a string the constructor accepts
 */
function isObjectIdHex(value: unknown, objectIdCtor: IMongoObjectIdCtor): value is string {
  return typeof value === 'string' && objectIdCtor.isValid(value);
}
