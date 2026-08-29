/**
 * Internal structural types for the native `mongodb` driver, owned by the
 * Mongo adapter.
 *
 * These are the driver's public shapes narrowed to exactly what the adapter
 * calls, so the adapter never imports the driver's own classes (a backend in
 * another package must be able to implement the port without importing
 * another plugin — AI_GUIDELINES §2.2). A faithful test double that
 * reproduces these members is assignable here.
 *
 * This file is internal and NOT exported from the package.
 *
 * @internal
 * @module
 */

/**
 * A structural subset of the driver `ObjectId` — enough for the conversion
 * rules the mapping owns.
 *
 * @since 0.1.0
 */
export interface IMongoObjectId {
  /** Serializes the id to its 24-hex string, the value callers address. */
  toString(): string;
}

/**
 * The driver `ObjectId` constructor shape.
 *
 * @since 0.1.0
 */
export interface IMongoObjectIdCtor {
  /**
   * Tests whether a value is a valid `ObjectId` — exactly a 24-hex string,
   * so a 12-char value is rejected.
   *
   * @param value - The candidate value
   */
  isValid(value: unknown): boolean;

  /**
   * Constructs a new `ObjectId`.
   *
   * @param value - A 24-hex string (or no argument, for a fresh random id)
   */
  new (value?: string): IMongoObjectId;
}

/**
 * A structural subset of the driver `ClientSession` — the members the
 * transaction path calls.
 *
 * @since 0.1.0
 */
export interface IMongoSession {
  /**
   * Starts the transaction on this session.
   *
   * @param options - Transaction options
   */
  startTransaction(options?: Record<string, unknown>): Promise<void>;

  /** Commits the active transaction. */
  commitTransaction(): Promise<void>;

  /** Rolls the active transaction back. */
  abortTransaction(): Promise<void>;

  /** Ends the session, releasing its server resources. */
  endSession(): Promise<void>;
}

/**
 * The native driver `findOneAndUpdate` options the adapter passes through.
 *
 * @since 0.1.0
 */
export interface IMongoCollectionFindOneAndUpdateOptions {
  /** Returns the updated document (rather than the original). */
  returnDocument: 'before' | 'after';
}

/**
 * A structural subset of the driver `Collection` — the methods the data source
 * calls to serve the six `IDataSource` methods.
 *
 * The adapter reads the driver's documented return shapes (see the
 * milestone's §1.1: `insertOne` → `{ acknowledged, insertedId }`,
 * `findOneAndUpdate` → the document directly, `deleteOne` → `{ deletedCount }`)
 * rather than the driver's own classes, so a faithful test double that
 * reproduces those shapes is assignable here — the recurring contract-violating
 * double this seam exists to prevent.
 *
 * @since 0.1.0
 */
export interface IMongoCollection {
  /**
   * Inserts one document.
   *
   * @param document - The document to insert
   * @param options - The `insertOne` options (e.g. a session)
   * @returns `{ acknowledged, insertedId }`, `insertedId` an `ObjectId`
   */
  insertOne(
    document: Record<string, unknown>,
    options?: MongoWriteOptions,
  ): Promise<{
    acknowledged: boolean;
    insertedId: IMongoObjectId | string | number;
  }>;

  /**
   * Finds a single document.
   *
   * @param filter - The match filter
   * @param options - The `findOne` options (`projection`/`sort`)
   * @param sessionOptions - The operation options (e.g. a session)
   * @returns The matching document, or `null`
   */
  findOne(
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, 1>; sort?: Record<string, unknown> },
    sessionOptions?: MongoOptions,
  ): Promise<Record<string, unknown> | null>;

  /**
   * Finds matching documents.
   *
   * @param filter - The match filter
   * @param options - The `find` options (`sort`/`skip`/`limit`/`projection`)
   * @param sessionOptions - The operation options (e.g. a session)
   * @returns The matching documents
   */
  find(
    filter: Record<string, unknown>,
    options?: {
      sort?: Record<string, unknown>;
      skip?: number;
      limit?: number;
      projection?: Record<string, 1>;
    },
    sessionOptions?: MongoOptions,
  ): Promise<Record<string, unknown>[]>;

  /**
   * Finds one document and applies an update, returning the updated document.
   *
   * @param filter - The match filter
   * @param update - The update document (`$set` form)
   * @param options - The `findOneAndUpdate` options
   * @param sessionOptions - The operation options (e.g. a session)
   * @returns The updated document, or `null` when none matched
   */
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: IMongoCollectionFindOneAndUpdateOptions,
    sessionOptions?: MongoOptions,
  ): Promise<Record<string, unknown> | null>;

  /**
   * Deletes matching documents.
   *
   * @param filter - The match filter
   * @param options - The operation options (e.g. a session)
   * @returns `{ deletedCount }`
   */
  deleteOne(
    filter: Record<string, unknown>,
    options?: MongoWriteOptions,
  ): Promise<{ deletedCount: number }>;

  /**
   * Counts matching documents.
   *
   * @param filter - The match filter
   * @param options - The operation options (e.g. a session)
   * @returns The matching count
   */
  countDocuments(
    filter: Record<string, unknown>,
    options?: MongoWriteOptions,
  ): Promise<number>;
}

/**
 * Operation options the data source passes to every driver call — the session
 * a transaction-scoped data source binds to.
 *
 * @since 0.1.0
 */
export interface MongoOptions {
  /** The session a transaction-scoped operation runs under. */
  session?: IMongoSession;
}

/**
 * Write-path operation options the data source passes to the driver.
 *
 * @since 0.1.0
 */
export type MongoWriteOptions = MongoOptions;

/**
 * A structural subset of the driver `MongoClient` — the members the adapter
 * drives.
 *
 * @since 0.1.0
 */
export interface IMongoClient {
  /**
   * Opens the connection.
   */
  connect(): Promise<void>;

  /**
   * Closes the connection.
   */
  disconnect(): Promise<void>;

  /**
   * Returns the database named `name`.
   *
   * @param name - The database name
   */
  db(name: string): IMongoDatabase;

  /**
   * Starts a new session.
   */
  startSession(): IMongoSession;
}

/**
 * A structural subset of the driver `Database` — what the collection resolver
 * reads.
 *
 * @since 0.1.0
 */
export interface IMongoDatabase {
  /**
   * Returns the collection named `name`.
   *
   * @param name - The collection name
   */
  collection(name: string): IMongoCollection;
}
