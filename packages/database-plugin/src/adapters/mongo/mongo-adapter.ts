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
 *   options: { mongo: { url: 'mongodb://localhost:27017' } },
 * }));
 * ```
 * @since 0.1.0
 */
export class MongoAdapter implements IDatabaseAdapter {
  #client: IMongoClient | null = null;
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
   * @throws {Error} When neither `url` nor `client` is supplied — a compile
   *   error on the discriminated union, so this is defensive
   */
  constructor(options: MongoAdapterOptions) {
    if (options.client === undefined && options.url === undefined) {
      throw new Error('MongoAdapter requires either options.client or options.url');
    }
    this.#options = options;
    this.#databaseName = options.database ?? '';
    this.#mapping = options.collections ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    // Resolve the loader — injected (no import) or the literal lazy import.
    this.#loader = this.#options.client !== undefined
      ? createInjectedClientLoader(this.#options.client, this.#options.objectIdCtor)
      : await createLazyClientLoader(this.#options.url as string);
    this.#client = await this.#loader.createClient(this.#options.url as string);
    await this.#client.connect();
    // Fail at startup when no database can be resolved (the plan §3.9 contract),
    // not lazily on the first data operation.
    this.#resolveDatabaseName();
    this.#connected = true;
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    if (this.#client !== null) {
      await this.#client.close();
      this.#client = null;
    }
    this.#connected = false;
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this.#connected;
  }

  /** @inheritdoc */
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
   * @inheritdoc
   *
   * Opens a driver session and calls `startTransaction()`. A deployment
   * without a replica set fails here, with the driver's own error wrapped in
   * {@linkcode MongoTransactionUnavailableError} — never at `connect()`.
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
   * @inheritdoc
   *
   * MongoDB has no SQL, so a raw query is refused by name rather than emulated
   * (the silent-divergence defect M70j closed). The error names the adapter
   * and points at the injected client for native commands.
   *
   * It rejects, never throws synchronously.
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
