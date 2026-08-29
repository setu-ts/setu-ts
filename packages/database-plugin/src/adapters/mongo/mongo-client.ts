/**
 * Injection seam for the native `mongodb` driver — the structural
 * `IMongoClient` facade the adapter operates against, plus the inject-or-lazy
 * loader that supplies the real module on the lazy path.
 *
 * The adapter never imports `npm:mongodb` directly: it accepts a client
 * through {@linkcode MongoAdapterOptions.client} (preferred — the application
 * constructs and configures it) or loads it lazily at {@linkcode
 * MongoAdapter.connect} time. The loader performs a real, literal
 * `import('npm:mongodb@^6.21.0')`, so the seam is not a global-hook shim that only
 * tests populate (the CLAUDE.md pitfall: a `globalThis.__x` loader throws in
 * production even when the package is installed).
 *
 * The driver's structural types live in `mongo-client-types.ts`; this file
 * re-exports the ones consumers need and owns the loader. The data-source
 * factory and transaction live in `mongo-data-source.ts`.
 *
 * @module
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
  MongoWriteOptions,
} from './mongo-client-types.ts';

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
 * The driver `ObjectId` constructor shape.
 *
 * @since 0.1.0
 */
export type { IMongoObjectIdCtor };

/**
 * A structural subset of the driver `MongoClient` — the members the adapter
 * drives.
 *
 * @since 0.1.0
 */
export type { IMongoClient };

/**
 * A structural subset of the driver `Database` — what the collection resolver
 * reads.
 *
 * @since 0.1.0
 */
export type { IMongoDatabase };

/**
 * A structural subset of the driver `ClientSession` — the members the
 * transaction path calls.
 *
 * @since 0.1.0
 */
export type { IMongoSession };

/**
 * A structural subset of the driver `Collection` — the methods the data source
 * calls to serve the six `IDataSource` methods.
 *
 * @since 0.1.0
 */
export type { IMongoCollection };

/**
 * The native driver `findOneAndUpdate` options the adapter passes through.
 *
 * @since 0.1.0
 */
export type { IMongoCollectionFindOneAndUpdateOptions };

/** A structural subset of the driver's cursor returned from `find()`. */
export type { IMongoCursor };

/**
 * Operation options the data source passes to every driver call — the session
 * a transaction-scoped data source binds to.
 *
 * @since 0.1.0
 */
export type { MongoOptions };

/**
 * Write-path operation options the data source passes to the driver.
 *
 * @since 0.1.0
 */
export type { MongoWriteOptions };

/**
 * The native `mongodb` module shape the lazy loader adapts.
 *
 * @since 0.1.0
 */
export interface MongoSdkModule {
  /** The driver `MongoClient` constructor. */
  MongoClient: new (url: string) => IMongoClient;
  /** The driver `ObjectId` constructor. */
  ObjectId: IMongoObjectIdCtor;
}

/**
 * The client loader seam — either an injected client (no import) or a lazy
 * loader that performs the real `npm:mongodb@^6.21.0` import.
 *
 * @since 0.1.0
 */
export interface MongoClientLoader {
  /**
   * Constructs a client from a connection URL.
   *
   * @param url - The connection string
   * @returns The constructed client
   */
  createClient(url: string): Promise<IMongoClient>;

  /** The `ObjectId` constructor, when the client was injected or lazily loaded. */
  readonly objectIdCtor?: IMongoObjectIdCtor;
}

/**
 * A client supplied through options: an already-constructed `IMongoClient`
 * plus its `ObjectId` constructor.
 *
 * @param client - The constructed client
 * @param objectIdCtor - The driver `ObjectId` constructor
 * @returns A loader that hands the client back without importing anything
 * @since 0.1.0
 */
export function createInjectedClientLoader(
  client: IMongoClient,
  objectIdCtor?: IMongoObjectIdCtor,
): MongoClientLoader {
  // `objectIdCtor` is a `readonly` optional on `MongoClientLoader`, so it is
  // folded into the object literal rather than assigned after construction.
  return objectIdCtor === undefined
    ? { createClient: (): Promise<IMongoClient> => Promise.resolve(client) }
    : {
      createClient: (): Promise<IMongoClient> => Promise.resolve(client),
      objectIdCtor,
    };
}

/**
 * A lazy loader that constructs a client from the literal `npm:mongodb@^6.21.0`
 * specifier at {@linkcode MongoAdapter.connect} time.
 *
 * Performs a real `import('npm:mongodb@^6.21.0')`; the driver is resolved by the
 * runtime at call time and is not part of this package's dependency graph.
 *
 * @param url - The connection string
 * @returns A loader that performs the real import on first use
 * @since 0.1.0
 */
export async function createLazyClientLoader(url: string): Promise<MongoClientLoader> {
  const mod = await import('npm:mongodb@^6.21.0') as unknown as MongoSdkModule;
  return {
    createClient: (): Promise<IMongoClient> => Promise.resolve(new mod.MongoClient(url)),
    objectIdCtor: mod.ObjectId,
  };
}
