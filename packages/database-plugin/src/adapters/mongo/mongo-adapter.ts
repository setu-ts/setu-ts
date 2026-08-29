/**
 * Mongo adapter over the native `mongodb` driver — a first-class `'mongodb'`
 * arm of the database plugin.
 *
 * Implements {@linkcode IDatabaseAdapter} from `@setu-ts/common`: all six
 * `IDataSource` methods (via {@linkcode createMongoDataSource}) and all six
 * `NormalizedQuery` members translated natively (via {@linkcode translateQuery}),
 * while refusing the one SQL-shaped member, {@linkcode rawQuery}, by name.
 *
 * The client is supplied inject-or-lazy (§12.2 of AI_GUIDELINES):
 * {@linkcode MongoAdapterOptions.client} (preferred — the application
 * constructs and configures it) or a lazy literal `import('npm:mongodb@^6.21.0')`
 * at {@linkcode connect} time. Transactions use a driver session and refuse
 * late — at {@linkcode beginTransaction}, never at {@linkcode connect} — so a
 * standalone `mongod` that never opens one is still a valid deployment.
 *
 * @module
 */
import type { IAdapterTransaction, IDatabaseAdapter } from '@setu-ts/common';
import type { MongoAdapterOptions } from '../../interfaces/index.ts';
import { MongoTransactionUnavailableError, UnsupportedRawQueryError } from '../../errors.ts';
import {
  createInjectedClientLoader,
  createLazyClientLoader,
  type MongoClientLoader,
} from './mongo-client.ts';
import { createMongoDataSource, MongoTransaction } from './mongo-data-source.ts';
import type { IMongoClient, IMongoSession } from './mongo-client-types.ts';
import type { MongoTarget } from './mongo-mapping.ts';

/**
 * The Mongo adapter — a document-store backend over the native driver.
 *
 * Constructed by {@linkcode DatabasePlugin} for the `'mongodb'` arm, and also
 * constructible directly by an application for the `'custom'` arm.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin, MongoAdapter } from '@setu-ts/database-plugin';
 *
 * app.register(DatabasePlugin({
 *   type: 'mongodb',
 *   options: { url: 'mongodb://localhost:27017/mydb' },
 * }));
 * ```
 * @since 0.1.0
 */
export class MongoAdapter implements IDatabaseAdapter {
  #client: IMongoClient | null = null;
  /** The in-flight `connect()`, so concurrent callers share one attempt. */
  #connecting: Promise<void> | null = null;
  #loader: MongoClientLoader | null = null;
  #connected = false;
  readonly #options: MongoAdapterOptions;
  /** The database the adapter's collections live in, resolved at connect(). */
  #databaseName: string;
  /** The resolved entity mapping, carried by transaction data sources. */
  #mapping: Readonly<Record<string, import('./mongo-mapping.ts').MongoEntityMapping>> | undefined;

  /**
   * Creates the adapter.
   *
   * @param options - The `'mongodb'` arm options; `url` is required unless
   *   `client` is supplied
   * @throws {Error} When neither `url` nor `client` is supplied. A typed
   *   caller cannot reach this — {@linkcode MongoAdapterOptions} is a union
   *   whose arms each require one of the two — but the plugin builds the bag
   *   through an untyped carry (`buildAdapterOptions`), so the runtime guard
   *   is the backstop for that cast rather than dead code.
   */
  constructor(options: MongoAdapterOptions) {
    if (options.client === undefined && options.url === undefined) {
      throw new Error('MongoAdapter requires either options.client or options.url');
    }
    this.#options = options;
    this.#databaseName = options.database ?? '';
    this.#mapping = options.collections ?? undefined;
  }

  /**
   * Establishes the database connection, resolving the client and database name.
   *
   * Nothing is retained until the connection is fully established: a failure
   * leaves `#client` null, so the `#client !== null` guard above does not turn
   * a transient outage into a permanently unusable adapter. Assigning the
   * field first made every later `connect()` a no-op while `isReady()` stayed
   * `false`, so the adapter could never recover.
   *
   * @inheritdoc
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    // Concurrent callers share one attempt rather than each constructing a
    // client and all but the last leaking. The attempt is NEVER cached past
    // settlement: holding a rejected promise here would reinstate exactly the
    // permanently-unusable adapter this method was fixed to avoid.
    if (this.#connecting !== null) return await this.#connecting;
    const attempt = this.#establish();
    this.#connecting = attempt;
    try {
      await attempt;
    } finally {
      this.#connecting = null;
    }
  }

  /**
   * Performs one connection attempt.
   *
   * @throws {Error} When the driver cannot connect or no database resolves
   */
  async #establish(): Promise<void> {
    // Resolve the loader — injected (no import) or the literal lazy import.
    const injected = this.#options.client !== undefined;
    const loader = this.#options.client !== undefined
      ? createInjectedClientLoader(this.#options.client, this.#options.objectIdCtor)
      : await createLazyClientLoader(this.#options.url as string);
    const client = await loader.createClient(this.#options.url as string);
    try {
      await client.connect();
      // Fail at startup when no database can be resolved (the plan §3.9 contract),
      // not lazily on the first data operation.
      this.#resolveDatabaseName();
    } catch (error) {
      // Close only a client this adapter created. An injected one belongs to
      // the application, which may reuse it. The close failure is discarded
      // deliberately: the connect error is the one the caller needs.
      if (!injected) await client.close().catch(() => {});
      throw error;
    }
    this.#loader = loader;
    this.#client = client;
    this.#connected = true;
  }

  /** Closes the connection and releases the client. @inheritdoc */
  async disconnect(): Promise<void> {
    if (this.#client !== null) {
      await this.#client.close();
      this.#client = null;
    }
    this.#connected = false;
  }

  /** Reports whether the adapter is connected. @inheritdoc */
  isReady(): boolean {
    return this.#connected;
  }

  /** Returns a data source for the named entity's collection. @inheritdoc */
  createDataSource(entity: string): import('@setu-ts/common').IDataSource {
    this.assertConnected();
    return createMongoDataSource(
      this.#client as IMongoClient,
      this.#resolveDatabaseName(),
      entity,
      this.#mapping,
      this.#loader?.objectIdCtor,
    );
  }

  /**
   * Opens a driver session and calls `startTransaction()`. A deployment
   * without a replica set fails here, with the driver's own error wrapped in
   * {@linkcode MongoTransactionUnavailableError} — never at `connect()`.
   *
   * @inheritdoc
   */
  async beginTransaction(): Promise<IAdapterTransaction> {
    this.assertConnected();
    const client = this.#client as IMongoClient;
    const session = client.startSession();
    try {
      await session.startTransaction();
    } catch (error) {
      await session.endSession();
      throw new MongoTransactionUnavailableError(
        'Mongo transactions require a replica set (rs0); the current deployment is a standalone mongod. ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return new MongoTransaction(
      session,
      client,
      this.#resolveDatabaseName(),
      this.#mapping,
      this.#loader?.objectIdCtor,
    );
  }

  /**
   * Refuses the raw SQL query by name — MongoDB has no SQL — rather than
   * emulating it (the silent-divergence defect M70j closed). The error names
   * the adapter and points at the injected client for native commands.
   *
   * It rejects, never throws synchronously.
   *
   * @inheritdoc
   */
  // deno-lint-ignore require-await -- the refusal must REJECT, not throw synchronously
  async rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    throw new UnsupportedRawQueryError(
      'MongoAdapter does not support raw SQL queries. MongoDB has no SQL; use the injected client ' +
        'directly for native commands (collection.find / aggregate / runCommand).',
    );
  }

  /**
   * Resolves the database the adapter's collections live in.
   *
   * The explicit `options.database` wins; otherwise the database encoded in
   * `url` is used (the first path segment of a `mongodb://` URI); absent from
   * both, {@linkcode connect} fails at startup naming the option.
   *
   * @returns The resolved database name
   * @throws {Error} When neither `database` nor a `url` database is present
   */
  #resolveDatabaseName(): string {
    if (this.#databaseName) return this.#databaseName;
    const fromUrl = parseDatabaseFromUrl(this.#options.url as string);
    if (fromUrl) {
      this.#databaseName = fromUrl;
      return fromUrl;
    }
    throw new Error(
      'MongoAdapter could not resolve a database name: set options.database or include it in options.url',
    );
  }

  /**
   * Asserts the adapter is connected before a data operation.
   *
   * @throws {Error} When the adapter is not connected
   */
  assertConnected(): void {
    if (!this.#connected) {
      throw new Error('MongoAdapter is not connected — call connect() first');
    }
  }
}

/**
 * The session the transaction path opens.
 *
 * @internal
 */
export type { IMongoSession };

/**
 * The resolved entity target the adapter reads for collection resolution.
 *
 * @internal
 */
export type { MongoTarget };

/**
 * Parses the database name out of a `mongodb://` connection URI — the first
 * path segment after the host.
 *
 * @param url - The connection string
 * @returns The database name, or `undefined` when none is encoded
 * @since 0.1.0
 */
export function parseDatabaseFromUrl(url: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : undefined;
}
