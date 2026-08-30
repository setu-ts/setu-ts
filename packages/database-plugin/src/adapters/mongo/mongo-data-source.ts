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
  EntityKey,
  FilterExpression,
  IAdapterTransaction,
  IDataSource,
  NormalizedQuery,
  OrderDirection,
} from '@setu-ts/common';
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
  };
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
  if (!isCompound && !isFlatComposite && columns.includes(expression.field)) {
    return { ...expression, field: '_id' };
  }
  if (isCompound && columns.includes(expression.field)) {
    return { ...expression, field: '_id.' + expression.field };
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
