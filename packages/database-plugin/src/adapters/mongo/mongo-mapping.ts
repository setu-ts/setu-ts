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
   * The primary-key field name. Defaults to `'id'`.
   *
   * This is the name a caller addresses with `findById`/`update`/`delete` —
   * it is the name the returned document carries, not the driver's `_id`.
   */
  readonly primaryKey?: string;

  /**
   * How the collection stores its `_id` values.
   *
   * - `'objectId'` forces the id to a driver `ObjectId` on read and write.
   * - `'raw'` forbids conversion, so a `string` id is passed to the driver
   *   verbatim.
   * - absent uses `ObjectId.isValid(id)`, which is exactly a 24-hex test.
   *
   * The genuinely ambiguous collection — one whose `_id` values are 24-hex
   * **strings** rather than `ObjectId`s — cannot be distinguished at runtime,
   * so the override exists rather than being guessed.
   */
  readonly idType?: 'objectId' | 'raw';
}

/**
 * The resolved, per-entity target the Mongo query builder consumes.
 *
 * This is the internal half of the two-layer mapping: the public
 * {@linkcode MongoEntityMapping} is the override bag, and this is the
 * concrete collection name, primary-key name, and id strategy the builders
 * read. It is deliberately NOT exported — the mapping surface is the public
 * type, and leaking the resolved target would make one adapter's collection
 * naming part of the package's published contract (the M56 defect class).
 *
 * @internal
 */
export interface MongoTarget {
  /** The collection name. */
  readonly collection: string;
  /** The primary-key field name (the name a caller addresses). */
  readonly primaryKey: string;
  /** How the collection stores its `_id` values. */
  readonly idType: 'objectId' | 'raw' | 'auto';
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
  return {
    collection: override?.collection ?? entity,
    primaryKey: override?.primaryKey ?? DEFAULT_PRIMARY_KEY,
    // The adapter resolves the strategy once at connect() into a value the
    // data source carries; 'auto' is the unresolved form of the optional type.
    idType: override?.idType ?? 'auto',
  };
}

/**
 * Maps a driver document onto the repository's row: the mapped primary-key
 * field carries the `_id` value as a string, and `_id` is removed so the row
 * never leaks the driver's field name.
 *
 * Returning an `ObjectId` instance would break `JSON.stringify` round-tripping
 * in handlers; returning the hex string keeps the row a plain `Record`.
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
    row[target.primaryKey] = toIdString(rawId);
    delete row[DRIVER_ID_FIELD];
  }
  return row;
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
  if (Object.prototype.hasOwnProperty.call(document, target.primaryKey)) {
    document[DRIVER_ID_FIELD] = toDriverId(
      document[target.primaryKey],
      target.idType,
      objectIdCtor,
    );
    delete document[target.primaryKey];
  }
  return document;
}

/**
 * Converts a driver id value to the string a caller addresses.
 *
 * An `ObjectId` serializes to its 24-hex string; anything else is used as-is,
 * so a `number` or `raw` string id is preserved.
 *
 * @param value - The driver id value
 * @returns The id as a string
 * @since 0.1.0
 */
export function toIdString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof (value as { toString?: unknown }).toString === 'function') {
    const str = (value as { toString(): string }).toString();
    if (typeof str === 'string') return str;
  }
  return String(value);
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
 * - `'auto'` uses `ObjectId.isValid` — exactly a 24-hex test — so a raw 24-hex
 *   string is converted and everything else is used as-is.
 *
 * @param value - The repository id value
 * @param idType - The target's id strategy
 * @param objectIdCtor - The driver `ObjectId` constructor; required when `idType` converts
 * @returns The id in driver form
 * @since 0.1.0
 */
export function toDriverId(
  value: unknown,
  idType: 'objectId' | 'raw' | 'auto',
  objectIdCtor?: IMongoObjectIdCtor,
): unknown {
  if (idType === 'raw') return value;
  if (idType === 'objectId') {
    if (objectIdCtor === undefined) {
      throw new Error('MongoAdapter needs the driver ObjectId to map objectId ids');
    }
    if (!objectIdCtor.isValid(value)) {
      throw new Error(
        `Cannot map id '${String(value)}' to ObjectId: it is not a valid 24-hex id`,
      );
    }
    return new objectIdCtor(String(value));
  }
  // idType === 'auto'
  if (objectIdCtor !== undefined && objectIdCtor.isValid(value)) {
    return new objectIdCtor(String(value));
  }
  return value;
}
