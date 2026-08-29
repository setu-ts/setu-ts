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
  FilterExpression,
  IAdapterTransaction,
  IDataSource,
  NormalizedQuery,
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

  const convertId = (id: string | number): unknown => toDriverId(id, target.idType, objectIdCtor);

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

    findById: async (id: string | number): Promise<Record<string, unknown> | null> => {
      const document = await collection.findOne({ _id: convertId(id) }, options());
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
      id: string | number,
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
      delete patch[target.primaryKey];
      delete patch['_id'];
      const result = await collection.findOneAndUpdate(
        { _id: convertId(id) },
        { $set: patch },
        { returnDocument: 'after', ...options() },
      );
      if (result === null || result === undefined) {
        throw new Error(
          `MongoAdapter: no ${target.collection} row with ${target.primaryKey} '${String(id)}'`,
        );
      }
      return fromDriverDocument(result, target);
    },

    delete: async (id: string | number): Promise<boolean> => {
      const result = await collection.deleteOne({ _id: convertId(id) }, options());
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
  const mapField = (field: string): string => field === target.primaryKey ? '_id' : field;
  const where = Object.fromEntries(
    Object.entries(query.where).map(([field, value]) => [
      mapField(field),
      value,
    ]),
  );
  const orderBy = Object.fromEntries(
    Object.entries(query.orderBy).map(([field, direction]) => [mapField(field), direction]),
  );
  return {
    ...query,
    where,
    orderBy,
    ...(query.filter === undefined
      ? {}
      : { filter: mapFilterToDriver(query.filter, target.primaryKey) }),
  };
}

/** Recursively maps a portable primary-key filter field/value to Mongo form. */
function mapFilterToDriver(
  expression: FilterExpression,
  primaryKey: string,
): FilterExpression {
  if (expression.type !== 'comparison') {
    return {
      ...expression,
      filters: expression.filters.map((child) => mapFilterToDriver(child, primaryKey)),
    };
  }
  return expression.field === primaryKey ? { ...expression, field: '_id' } : expression;
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
  primaryKey: string,
): Record<string, 0 | 1> {
  const mapped: Record<string, 0 | 1> = {};
  let includesPrimaryKey = false;
  for (const field of Object.keys(projection)) {
    if (field === primaryKey) {
      includesPrimaryKey = true;
    } else {
      mapped[field] = 1;
    }
  }
  mapped._id = includesPrimaryKey ? 1 : 0;
  return mapped;
}
