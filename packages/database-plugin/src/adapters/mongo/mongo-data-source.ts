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
  toIdString,
} from './mongo-mapping.ts';
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
      const { filter, options: findOptions } = translateQuery(query);
      const rows = await collection.find(filter, findOptions, options());
      return rows.map((row) => fromDriverDocument(row, target));
    },

    findById: async (id: string | number): Promise<Record<string, unknown> | null> => {
      const document = await collection.findOne({ _id: convertId(id) }, undefined, options());
      return document ? fromDriverDocument(document, target) : null;
    },

    create: async (data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      const document = toDriverDocument(data, target, objectIdCtor);
      const result = await collection.insertOne(document, options());
      // Compose the returned document from what we inserted plus the generated
      // `_id`, rather than re-reading: the driver returns
      // `{ acknowledged, insertedId }`, so the row we want is the input with
      // the primary-key field set to the generated id.
      const row: Record<string, unknown> = { ...data };
      if (result.insertedId !== undefined) {
        row[target.primaryKey] = toIdString(result.insertedId);
      }
      return fromDriverDocument(row, target);
    },

    update: async (
      id: string | number,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const result = await collection.findOneAndUpdate(
        { _id: convertId(id) },
        { $set: toDriverDocument(data, target, objectIdCtor) },
        { returnDocument: 'after' },
        options(),
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
      return await collection.countDocuments(translateCountFilter(where, filter), options());
    },
  };
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
  #finalized = false;

  constructor(
    session: IMongoSession,
    client: IMongoClient,
    databaseName: string,
    mapping: Readonly<Record<string, MongoEntityMapping>> | undefined,
  ) {
    this.#session = session;
    this.#client = client;
    this.#databaseName = databaseName;
    this.#mapping = mapping;
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
      undefined,
      this.#session,
    );
  }
}
