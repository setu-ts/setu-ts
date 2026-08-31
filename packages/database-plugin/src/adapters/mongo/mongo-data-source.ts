/**
 * Data-source factory and transaction handle for the Mongo adapter.
 *
 * This owns the six `IDataSource` methods over one collection, translating
 * each onto the driver's native calls with the shapes measured against the
 * real driver (§1.1 of the milestone): `insertOne` → `{ acknowledged,
 * insertedId }`, `findOneAndUpdate` → the document directly, `deleteOne` →
 * `{ deletedCount }`. The driver's structural types live in
 * `mongo-client-types.ts`; the inject-or-lazy client seam lives in
 * `mongo-client.ts`.
 *
 * @module
 */
import type {
  CursorPayload,
  EntityKey,
  FilterExpression,
  IAdapterTransaction,
  IDataSource,
  NormalizedQuery,
  OrderDirection,
} from '@setu-ts/common';
import { decodeCursor, keysetPredicate } from '@setu-ts/common';
import {
  fromDriverDocument,
  resolveMongoTarget,
  toDriverDocument,
  toDriverId,
} from './mongo-mapping.ts';
import type { MongoTarget } from './mongo-mapping.ts';
import { translateCountFilter, translateQuery } from './mongo-query.ts';
import type {
  IMongoClient,
  IMongoCollection,
  IMongoDatabase,
  IMongoObjectId,
  IMongoObjectIdCtor,
  IMongoSession,
} from './mongo-client-types.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';
import { mintNextCursor, sortFingerprint } from '../../query/cursor-page.ts';
import {
  normalizePageQuery,
  PageNormalizationError,
  projectFields,
} from '../../query/query-builder.ts';

// Re-export the driver structural types the data source carries.
export type {
  IMongoClient,
  IMongoCollection,
  IMongoDatabase,
  IMongoObjectId,
  IMongoObjectIdCtor,
  IMongoSession,
};

/**
 * The per-operation options the data source passes to the driver — the session
 * a transaction-scoped data source binds to.
 *
 * @since 0.1.0
 */
interface MongoCollectionOptions {
  /** The session a transaction-scoped data source runs under, or none. */
  readonly session?: IMongoSession;
}

/**
 * The entity-mapping bag a transaction-scoped data source resolves from.
 *
 * @since 0.1.0
 */
type MongoEntityMapping = import('./mongo-mapping.ts').MongoEntityMapping;

/**
 * Builds an `IDataSource` over an entity's collection, resolving the entity
 * target from a mapping and driving the collection through the client's
 * `db().collection()`.
 *
 * The six methods map onto the driver's native calls (`find`, `findOne`,
 * `insertOne`, `findOneAndUpdate`, `deleteOne`, `countDocuments`). When a
 * `session` is supplied every operation carries it, so a transaction-scoped
 * data source participates in the session's transaction on the real driver.
 *
 * @param client - The client backing the entity's database
 * @param databaseName - The database the collection lives in
 * @param entity - The entity name (for target resolution)
 * @param mapping - The per-entity overrides, or none
 * @param objectIdCtor - The driver `ObjectId` constructor
 * @param session - The session a transaction-scoped data source runs under
 * @returns A data source bound to the entity's collection
 * @since 0.1.0
 */
export function createMongoDataSource(
  client: IMongoClient,
  databaseName: string,
  entity: string,
  mapping: Readonly<Record<string, MongoEntityMapping>> | undefined,
  objectIdCtor?: IMongoObjectIdCtor,
  session?: IMongoSession,
): IDataSource {
  const target = resolveMongoTarget(entity, mapping);
  const collection = client.db(databaseName).collection(target.collection);

  const options = (): MongoCollectionOptions => (session === undefined ? {} : { session });

  /**
   * Resolves an {@linkcode EntityKey} into the driver-addressable form.
   *
   * For scalar keys the path is unchanged (the `_id` rename). For composite
   * keys two arms exist:
   *
   * - `idType: 'compound'` — the first column names the subdocument stored
   *   under `_id`; its value is the subdocument itself built in the
   *   mapping's declared order.
   * - absent (flat composite) — the call rejects via a rejected promise
   *   naming the missing compound key arm. A flat composite key addresses
   *   top-level fields, not `_id`.
   */
  const buildIdFilter = (
    id: EntityKey,
    operation: 'findById' | 'update' | 'delete',
  ): Promise<Record<string, unknown>> => {
    const columns = target.primaryKey;
    if (columns.length === 1) {
      // Scalar path — still honours `idType: 'objectId'` conversion.
      return Promise.resolve({ _id: toDriverId(id, target.idType, objectIdCtor) });
    }
    // Composite path.
    if (target.idType === 'compound') {
      if (typeof id === 'string' || typeof id === 'number') {
        return Promise.reject(
          new Error(
            `MongoAdapter: ${operation} needs a composite record for compound key, got scalar '${
              String(id)
            }'.`,
          ),
        );
      }
      // Build the subdocument in the mapping's declared order (P5), never the
      // caller's object order. The real driver treats subdocument equality as
      // "ordered" (field order matters), so passing the caller's order through
      // would miss rows that exist under a different literal order.
      const subdoc: Record<string, unknown> = {};
      for (const col of columns) {
        const value = id[col];
        if (value === undefined) {
          return Promise.reject(
            new Error(
              `MongoAdapter: ${operation} composite key is missing required column '${col}'.`,
            ),
          );
        }
        subdoc[col] = value;
      }
      return Promise.resolve({ _id: subdoc });
    }
    // Flat composite — each named column is a top-level field on the
    // collection. The filter is order-independent.
    if (typeof id === 'string' || typeof id === 'number') {
      return Promise.reject(
        new Error(
          `MongoAdapter: ${operation} needs a composite record for multi-column key ${
            columns.join(', ')
          }, got scalar '${String(id)}'.`,
        ),
      );
    }
    const filter: Record<string, unknown> = {};
    for (const col of columns) {
      const value = id[col];
      if (value === undefined) {
        return Promise.reject(
          new Error(
            `MongoAdapter: ${operation} composite key is missing required column '${col}'.`,
          ),
        );
      }
      filter[col] = toDriverId(value, target.idType, objectIdCtor);
    }
    return Promise.resolve(filter);
  };

  return {
    findAll: async (query: NormalizedQuery): Promise<Record<string, unknown>[]> => {
      const { filter: translatedFilter, options: findOptions } = translateQuery(
        mapQueryToDriver(query, target),
      );
      const filter = mapMongoIdValues(translatedFilter, target, objectIdCtor);
      const projection = findOptions.projection === undefined
        ? undefined
        : mapProjection(findOptions.projection, target.primaryKey);
      const rows = await collection.find(
        filter,
        projection === undefined
          ? { ...findOptions, ...options() }
          : { ...findOptions, projection, ...options() },
      ).toArray();
      return rows.map((row) => fromDriverDocument(row, target));
    },

    findById: async (id: EntityKey): Promise<Record<string, unknown> | null> => {
      const filter = await buildIdFilter(id, 'findById');
      const document = await collection.findOne(filter, options());
      return document ? fromDriverDocument(document, target) : null;
    },

    create: async (data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      const document = toDriverDocument(data, target, objectIdCtor);
      const result = await collection.insertOne(document, options());
      // Compose the returned document from what we inserted plus the generated
      // `_id`, rather than re-reading: the driver always returns
      // `{ acknowledged, insertedId }`, so the mapped read path remains the
      // single place that translates `_id` to the repository primary key.
      return fromDriverDocument({ ...document, _id: result.insertedId }, target);
    },

    update: async (
      id: EntityKey,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      // The primary key never travels in an update payload: `id` already
      // addresses the row, and MongoDB refuses a `$set` that would change
      // `_id` ("Performing an update on the path '_id' would modify the
      // immutable field '_id'"), so a caller passing the whole row back with a
      // different key met a raw driver error through a portable contract.
      // `update` does not move a row to a new primary key on any adapter.
      //
      // It is dropped BEFORE conversion, not after: `toDriverDocument` runs
      // `toDriverId`, which throws for a value an `idType: 'objectId'` target
      // cannot convert — so stripping afterwards left a value that has no
      // effect on the update still able to fail it.
      //
      // Both spellings go: the mapped primary key, and a literal `_id` a caller
      // may have carried over from a raw document. `toDriverDocument` used to
      // collapse the two by renaming, so dropping only the mapped name would
      // let a stray `_id` reach `$set` and be refused by the server.
      const patch = { ...data };
      for (const col of target.primaryKey) {
        delete patch[col];
      }
      delete patch['_id'];

      const missing = (): Error =>
        new Error(
          `MongoAdapter: no ${target.collection} row with ${target.primaryKey.join(', ')} '${
            JSON.stringify(id)
          }'`,
        );

      // Stripping the key can leave nothing to set. Read the row instead of
      // sending `$set: {}` — it is a write that changes nothing, and server
      // support for it is not universal: measured, 3.6.23 rejects it outright
      // while 4.0.28, 4.4.30 and 8.x accept it and answer with the document.
      // The driver pins no server floor, so the branch removes the question
      // rather than declaring a minimum version this package cannot enforce.
      const filter = await buildIdFilter(id, 'update');
      if (Object.keys(patch).length === 0) {
        const existing = await collection.findOne(filter, options());
        if (existing === null || existing === undefined) throw missing();
        return fromDriverDocument(existing, target);
      }

      const result = await collection.findOneAndUpdate(
        filter,
        { $set: patch },
        { returnDocument: 'after', ...options() },
      );
      if (result === null || result === undefined) throw missing();
      return fromDriverDocument(result, target);
    },

    delete: async (id: EntityKey): Promise<boolean> => {
      const filter = await buildIdFilter(id, 'delete');
      const result = await collection.deleteOne(filter, options());
      return (result.deletedCount ?? 0) > 0;
    },

    count: async (
      where: Record<string, unknown>,
      filter?: FilterExpression,
    ): Promise<number> => {
      const mapped = mapQueryToDriver(
        {
          where,
          orderBy: {},
          limit: -1,
          offset: 0,
          select: [],
          ...(filter === undefined ? {} : { filter }),
        },
        target,
      );
      return await collection.countDocuments(
        mapMongoIdValues(translateCountFilter(mapped.where, mapped.filter), target, objectIdCtor),
        options(),
      );
    },

    /**
     * §3.8 keyset pagination. One implementation, shared with the transaction
     * data source: normalize (refusing an offset/cursor pair, §3.10), decode
     * the incoming cursor (malformed → refuse by name), verify the sort
     * fingerprint (cross-sort → refuse by name), build the portable keyset
     * predicate with the shared builder and conjoin it with the caller's
     * `where`/`filter`, then `find` with `limit + 1` (the one-extra-row
     * probe). The LAST returned row mints the next cursor when a further page
     * exists (`nextCursor` is `null` on the last page); the key columns and
     * ordered fields are added to the internal projection only for the probe
     * and cursor minting, then stripped so the caller's projection is what
     * comes back (§8).
     *
     * @param query - The normalized page query, carrying an optional `cursor`
     * @returns A {@linkcode PageResult} carrying `rows` and the `nextCursor`
     * @throws {UnsupportedQueryFeatureError} When the token is malformed or the
     *   fingerprint does not match the current sort (rejected, never a
     *   synchronous throw)
     */
    findPage: async (query) => {
      // §3.8 keyset pipeline. `normalized`, `decoded`, `fingerprint`, `keyset`,
      // the internal projection, and the probe all live in this closure so the
      // one implementation is shared with the transaction data source.
      const normalized = normalizePageQuery(query);
      if (normalized instanceof PageNormalizationError) {
        return Promise.reject(normalized);
      }

      // 2. Decode cursor. A missing cursor means start of the walk; a malformed
      //    token is refused by name.
      let decoded: CursorPayload | null = null;
      if (normalized.cursor !== undefined) {
        decoded = decodeCursor(normalized.cursor);
        if (decoded === null) {
          return Promise.reject(
            new UnsupportedQueryFeatureError(
              'cursor-pagination',
              'mongo',
              `cursor-pagination: entity '${target.collection}': malformed cursor token`,
            ),
          );
        }
      }

      // 3. Sort-fingerprint guard — a cross-sort cursor would return a
      //    silently wrong page.
      const fingerprint = sortFingerprint(normalized.orderBy);
      if (decoded !== null && decoded.sortFingerprint !== fingerprint) {
        return Promise.reject(
          new UnsupportedQueryFeatureError(
            'cursor-pagination',
            'mongo',
            `cursor-pagination: entity '${target.collection}': cursor fingerprint ` +
              `mismatch — expected '${fingerprint}', got '${decoded.sortFingerprint}'`,
          ),
        );
      }

      // 4. Keyset predicate through the shared builder; it is a FilterExpression,
      //    so it reaches the collection through the existing translateQuery
      //    path with no new translation code.
      const keyset = decoded === null ? undefined : keysetPredicate(
        decoded.orderedValues,
        decoded.keyValues,
        normalized.orderBy,
        target.primaryKey,
      );
      const keysetFilter = conjoinFilters(normalized.filter, keyset);

      // 5. One-extra-row probe. A non-zero skip is never applied: the keyset
      //    position replaces offset (and §3.10 refused the two together). The
      //    `limit + 1` is folded directly into the driver `find` below.
      const keyColumns = target.primaryKey;
      const internalSelect = normalized.select.length > 0
        ? [...new Set([...normalized.select, ...keyColumns, ...Object.keys(normalized.orderBy)])]
        : [];
      const mapped = mapQueryToDriver(
        {
          ...normalized,
          limit: normalized.limit > 0 ? normalized.limit + 1 : normalized.limit,
          select: internalSelect,
          ...(keysetFilter === undefined ? {} : { filter: keysetFilter }),
        },
        target,
      );
      const { filter: translatedFilter, options: findOptions } = translateQuery(mapped);
      const filter = mapMongoIdValues(translatedFilter, target, objectIdCtor);
      const projection = findOptions.projection === undefined
        ? undefined
        : mapProjection(findOptions.projection, keyColumns);
      const found = await collection.find(
        filter,
        projection === undefined
          ? { ...findOptions, ...options() }
          : { ...findOptions, projection, ...options() },
      ).toArray();

      // The driver returns raw documents keyed by `_id`; the cursor minting
      // reads the repository primary-key columns and the caller expects
      // repository-shaped rows, so map BEFORE minting and returning.
      const mappedRows = found.map((row) => fromDriverDocument(row, target));

      // 6. Probe outcome: more than `limit` rows means a next page exists and
      //    the LAST returned row mints the cursor; otherwise the page is terminal.
      const hasMore = normalized.limit > 0 && mappedRows.length > normalized.limit;
      const pageRows = hasMore ? mappedRows.slice(0, normalized.limit) : mappedRows;
      const nextCursor = mintNextCursor(
        pageRows,
        normalized.orderBy,
        keyColumns,
        fingerprint,
        hasMore,
      );

      // 7. The caller's projection is what comes back — the key columns and the
      //    ordered fields joined the internal select only for the probe and the
      //    cursor minting, and are stripped here.
      const rows = internalSelect.length > 0
        ? pageRows.map(
          (row) => projectFields(row, normalized.select) as Record<string, unknown>,
        )
        : pageRows;
      return Promise.resolve({ rows, nextCursor });
    },
  };
}

/**
 * Conjoin two optional portable filters, preferring the single expression when
 * only one is present — an `and` node with one child would be a shape the
 * caller never wrote and every backend translates differently.
 *
 * @param base - The caller's own filter, or `undefined`
 * @param extra - The keyset predicate, or `undefined` on the first page
 * @returns The conjoined expression, or `undefined` when neither is present
 */
function conjoinFilters(
  base: FilterExpression | undefined,
  extra: FilterExpression | undefined,
): FilterExpression | undefined {
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  return { type: 'and', filters: [base, extra] };
}

/** Maps repository-visible primary-key fields onto Mongo's `_id` field. */
function mapQueryToDriver(
  query: NormalizedQuery,
  target: MongoTarget,
): NormalizedQuery {
  const columns = target.primaryKey;
  // Flat composite (multi-column, no compound _id) uses top-level fields.
  // Compound _id wraps the subdocument under _id.
  // Scalar keys rename the single column to _id.
  const isFlatComposite = columns.length > 1 && target.idType !== 'compound';
  const isCompound = target.idType === 'compound' && columns.length > 1;

  let where: Record<string, unknown>;
  let orderBy: Record<string, OrderDirection>;

  if (isCompound) {
    // Build _id subdocument in the mapping's declared column order (P5).
    const idSubdoc: Record<string, unknown> = {};
    for (const col of columns) {
      if (query.where[col] !== undefined) {
        idSubdoc[col] = query.where[col];
      }
    }
    where = Object.keys(idSubdoc).length > 0 ? { _id: idSubdoc } : {};
    orderBy = Object.fromEntries(
      columns.map((col) => [
        '_id.' + col,
        query.orderBy[col] as OrderDirection | undefined,
      ]).filter(([, d]) => d !== undefined) as [string, OrderDirection][],
    );
  } else if (isFlatComposite) {
    // Flat composite: columns remain as top-level fields; no _id mapping.
    where = { ...query.where };
    orderBy = { ...query.orderBy };
  } else {
    // Scalar: rename only the primary-key column when present; otherwise leave unchanged.
    const key = columns[0];
    where = key !== undefined && key in query.where
      ? { _id: query.where[key] }
      : { ...query.where };
    orderBy = key !== undefined && key in query.orderBy
      ? { _id: query.orderBy[key] }
      : { ...query.orderBy };
  }

  return {
    ...query,
    where,
    orderBy,
    ...(query.filter === undefined
      ? {}
      : { filter: mapFilterToDriver(query.filter, columns, isCompound, isFlatComposite) }),
  };
}

/**
 * Resolve a filter comparison's field to a string key — for comparison against
 * the primary-key column list. A path array is NOT a primary key column, so it
 * passes through as its first segment (the root field).
 */
function filterFieldKey(field: string | readonly string[]): string {
  if (Array.isArray(field)) {
    return field[0];
  }
  return field as string;
}

/** Recursively maps a portable primary-key filter field/value to Mongo form. */
function mapFilterToDriver(
  expression: FilterExpression,
  columns: readonly string[],
  isCompound: boolean,
  isFlatComposite: boolean,
): FilterExpression {
  if (expression.type !== 'comparison') {
    return {
      ...expression,
      filters: expression.filters.map((child) =>
        mapFilterToDriver(child, columns, isCompound, isFlatComposite)
      ),
    };
  }
  // Flat composite fields stay as-is (already top-level in the document).
  // Compound keys: prepend '_id.' prefix to field paths for subdocument lookup.
  // Scalar keys: rename to '_id'.
  // A path array (nested field) is NOT a primary-key column, so it passes
  // through unchanged — the mapper does not touch nested paths.
  const fieldKey = filterFieldKey(expression.field);
  if (!isCompound && !isFlatComposite && columns.includes(fieldKey)) {
    return { ...expression, field: '_id' };
  }
  if (isCompound && columns.includes(fieldKey)) {
    return { ...expression, field: '_id.' + fieldKey };
  }
  return expression;
}

/** Converts values carried by native `_id` predicates to the driver's id form. */
function mapMongoIdValues(
  filter: Record<string, unknown>,
  target: MongoTarget,
  objectIdCtor?: IMongoObjectIdCtor,
): Record<string, unknown> {
  const mapValue = (value: unknown): unknown => toDriverId(value, target.idType, objectIdCtor);
  const mapped: Record<string, unknown> = {};
  for (const [field, condition] of Object.entries(filter)) {
    if (field === '$and' || field === '$or') {
      mapped[field] = (condition as Record<string, unknown>[]).map((child) =>
        mapMongoIdValues(child, target, objectIdCtor)
      );
    } else if (field === '_id') {
      mapped[field] = mapMongoIdCondition(condition, mapValue);
    } else {
      mapped[field] = condition;
    }
  }
  return mapped;
}

/** Converts scalar and operator-document Mongo `_id` predicates. */
function mapMongoIdCondition(
  condition: unknown,
  mapValue: (value: unknown) => unknown,
): unknown {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return mapValue(condition);
  }
  const entries = Object.entries(condition);
  if (!entries.some(([operator]) => operator.startsWith('$'))) {
    return mapValue(condition);
  }
  const operators: Record<string, unknown> = {};
  for (const [operator, value] of entries) {
    operators[operator] = operator === '$options' || operator === '$regex'
      ? value
      : operator === '$in' && Array.isArray(value)
      ? value.map(mapValue)
      : mapValue(value);
  }
  return operators;
}

/**
 * The transaction handle opened by {@linkcode MongoAdapter.beginTransaction}.
 *
 * `commit`/`rollback` map to `commitTransaction`/`abortTransaction`, and the
 * session is ended in a `finally`. A transaction-scoped data source carries
 * the session to every operation, so the whole set of repositories opened from
 * one handle commits or rolls back together.
 *
 * @internal
 */
export class MongoTransaction implements IAdapterTransaction {
  readonly #session: IMongoSession;
  readonly #client: IMongoClient;
  readonly #databaseName: string;
  readonly #mapping: Readonly<Record<string, MongoEntityMapping>> | undefined;
  readonly #objectIdCtor: IMongoObjectIdCtor | undefined;
  #finalized = false;

  constructor(
    session: IMongoSession,
    client: IMongoClient,
    databaseName: string,
    mapping: Readonly<Record<string, MongoEntityMapping>> | undefined,
    objectIdCtor?: IMongoObjectIdCtor,
  ) {
    this.#session = session;
    this.#client = client;
    this.#databaseName = databaseName;
    this.#mapping = mapping;
    this.#objectIdCtor = objectIdCtor;
  }

  /** @inheritdoc */
  async commit(): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    try {
      await this.#session.commitTransaction();
    } finally {
      await this.#session.endSession();
    }
  }

  /** @inheritdoc */
  async rollback(): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    try {
      await this.#session.abortTransaction();
    } finally {
      await this.#session.endSession();
    }
  }

  /** @inheritdoc */
  createDataSource(entity: string): IDataSource {
    if (this.#finalized) {
      throw new Error('MongoAdapter transaction is already finalized');
    }
    return createMongoDataSource(
      this.#client,
      this.#databaseName,
      entity,
      this.#mapping,
      this.#objectIdCtor,
      this.#session,
    );
  }
}

/**
 * Converts a repository projection to the physical Mongo document shape.
 *
 * Mongo includes `_id` with an inclusion projection unless it is explicitly
 * excluded. The repository contract promises that `select` drops unselected
 * fields, including the mapped primary key, so this makes `_id` explicit and
 * maps a requested primary key back to Mongo's field name.
 */
function mapProjection(
  projection: Record<string, 1>,
  primaryKey: readonly string[],
): Record<string, 0 | 1> {
  const mapped: Record<string, 0 | 1> = {};
  let includesPrimaryKey = false;
  for (const field of Object.keys(projection)) {
    if (primaryKey.includes(field)) {
      includesPrimaryKey = true;
    } else {
      mapped[field] = 1;
    }
  }
  mapped._id = includesPrimaryKey ? 1 : 0;
  return mapped;
}
