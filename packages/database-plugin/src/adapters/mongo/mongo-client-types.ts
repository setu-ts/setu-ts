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
   * Both the parameter and the return are deliberately `unknown`: the real
   * driver declares `startTransaction(options?: TransactionOptions): void`,
   * whose option interface is not assignable to `Record<string, unknown>` and
   * whose `void` return is not assignable to `Promise<void>`, so the typed
   * forms made the real `ClientSession` fail this structural subset (X47-1).
   * The adapter calls it with no arguments and discards the result
   * (`mongo-adapter.ts`), and a fake returning `Promise<void>` still
   * satisfies the widened member.
   *
   * @param options - Transaction options (the adapter passes none)
   */
  startTransaction(options?: unknown): unknown;

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
  /** The session a transaction-scoped operation runs under. */
  session?: IMongoSession;
}

/** A structural subset of the driver's cursor returned from `find()`. */
export interface IMongoCursor {
  /** Materializes the cursor's matching documents. */
  toArray(): Promise<Record<string, unknown>[]>;
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
   * @returns The matching document, or `null`
   */
  findOne(
    filter: Record<string, unknown>,
    options?: MongoOptions & {
      projection?: Record<string, 0 | 1>;
      /**
       * Deliberately `unknown`: the real driver's `FindOptions.sort` is the
       * `Sort` union, which admits bare strings and arrays, so a
       * `Record<string, unknown>` here made the real collection fail this
       * member (X47-1). The adapter builds a `Record` and the real driver
       * accepts it; `unknown` keeps both assignable.
       */
      sort?: unknown;
    },
  ): Promise<Record<string, unknown> | null>;

  /**
   * Finds matching documents.
   *
   * @param filter - The match filter
   * @param options - The `find` options (`sort`/`skip`/`limit`/`projection`)
   * @returns A cursor that materializes the matching documents with `toArray()`
   */
  find(
    filter: Record<string, unknown>,
    options?: MongoOptions & {
      /**
       * Deliberately `unknown` — see {@linkcode IMongoCollection.findOne}: the
       * real `Sort` union admits strings and arrays, which a `Record` typing
       * rejected.
       */
      sort?: unknown;
      skip?: number;
      limit?: number;
      projection?: Record<string, 0 | 1>;
    },
  ): IMongoCursor;

  /**
   * Finds one document and applies an update, returning the updated document.
   *
   * @param filter - The match filter
   * @param update - The update document (`$set` form)
   * @param options - The `findOneAndUpdate` options
   * @returns The updated document, or `null` when none matched
   */
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: IMongoCollectionFindOneAndUpdateOptions,
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
   *
   * The resolved value is deliberately `unknown` rather than `void`: the real
   * driver declares `connect(): Promise<this>` (`mongodb.d.ts`), and
   * `Promise<MongoClient>` is not assignable to `Promise<void>`, so the typed
   * `void` form made the documented injection arm a compile error for the one
   * client it exists to accept (X47-1). The adapter discards the resolved
   * value, so `unknown` is the widest return an implementation may specialise —
   * a fake resolving `void` still satisfies it. The assignment is pinned by the
   * compile-time fixture `test/types/mongo-seam.assert.ts`, which fails
   * `deno task check` the moment this facade drifts from the driver again.
   */
  connect(): Promise<unknown>;

  /**
   * Closes the connection.
   */
  close(): Promise<void>;

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

  /**
   * Runs a database command against this database (optional, M95b).
   *
   * The reachability probe sends `{ ping: 1 }` through it — the one cheap
   * liveness round trip the driver exposes. The real driver's
   * `Db.command(command: Document, options?): Promise<Document>` is
   * assignable to this shape, pinned by the committed static type fixture;
   * an injected facade that omits the member simply has no probe, and the
   * adapter reports its absence rather than failing readiness for a
   * backend it never asked.
   *
   * @param command - The command document (for example `{ ping: 1 }`)
   * @returns The driver's reply, unread by the probe
   */
  command?(command: Record<string, unknown>): Promise<unknown>;
}
