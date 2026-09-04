/**
 * Cosmos adapter over the `@azure/cosmos` SDK — a first-class `'cosmos'` arm
 * of the database plugin, serving Azure Cosmos DB's NoSQL (SQL) API.
 *
 * Implements {@linkcode IDatabaseAdapter} from `@setu-ts/common`: all six
 * `IDataSource` members plus `findPage` (via
 * {@linkcode createCosmosDataSource}), every `NormalizedQuery` member
 * translated natively (via `cosmos-query.ts`), and the one SQL-shaped member
 * that has nowhere to name a container, {@linkcode rawQuery}, refused by name.
 *
 * The client is supplied inject-or-lazy (AI_GUIDELINES §12.2):
 * {@linkcode CosmosAdapterOptions.client} (preferred — the application
 * constructs it, which is also how a managed-identity client reaches the
 * adapter) or a lazy literal `import('npm:@azure/cosmos@^4')` at
 * {@linkcode connect} time.
 *
 * The Cosmos DB for MongoDB API is NOT served here: it speaks the MongoDB wire
 * protocol, so it is served by the plugin's `'mongodb'` arm pointed at a
 * Cosmos connection string.
 *
 * @module
 */
import type { IAdapterTransaction, IDatabaseAdapter, IDataSource } from '@setu-ts/common';
import type { CosmosAdapterOptions } from '../../interfaces/index.ts';
import { UnsupportedRawQueryError } from '../../errors.ts';
import type { ICosmosClient, ICosmosDatabase } from './cosmos-client-types.ts';
import {
  type CosmosClientLoader,
  createInjectedClientLoader,
  createLazyClientLoader,
} from './cosmos-client.ts';
import type { CosmosEntityMapping, CosmosTarget } from './cosmos-mapping.ts';
import { resolveCosmosTarget } from './cosmos-mapping.ts';
import { PartitionKeyResolver } from './cosmos-partition-key.ts';
import { CosmosTransaction, createCosmosDataSource } from './cosmos-data-source.ts';

/**
 * The Cosmos adapter — an Azure Cosmos DB NoSQL-API backend.
 *
 * Constructed by `DatabasePlugin` for the `'cosmos'` arm, and also
 * constructible directly by an application for the `'custom'` arm.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@setu-ts/database-plugin';
 *
 * app.register(DatabasePlugin({
 *   type: 'cosmos',
 *   options: {
 *     endpoint: 'https://my-account.documents.azure.com:443/',
 *     key: config.getOrThrow('COSMOS_KEY'),
 *     database: 'app',
 *     containers: { Order: { container: 'orders', partitionKey: 'tenantId' } },
 *   },
 * }));
 * ```
 * @since 0.2.0
 */
export class CosmosAdapter implements IDatabaseAdapter {
  readonly #options: CosmosAdapterOptions;
  readonly #mapping: Readonly<Record<string, CosmosEntityMapping>> | undefined;
  #client: ICosmosClient | null = null;
  #database: ICosmosDatabase | null = null;
  #partitionKeys: PartitionKeyResolver | null = null;
  /**
   * The in-flight `connect()`, so concurrent callers share one attempt —
   * TAGGED with the generation it belongs to.
   *
   * The tag is what makes sharing safe across a `disconnect()`. An untagged
   * promise is shared by a later `connect()` too, and that attempt discards its
   * own result because its generation has moved — so the reconnect RESOLVES
   * with the adapter still disconnected, and only a third call would fix it.
   */
  #connecting: { readonly generation: number; readonly promise: Promise<void> } | null = null;
  #connected = false;
  /**
   * Bumped by `disconnect()`, so an attempt it superseded discards its result.
   *
   * Without it a `disconnect()` that lands while `connect()` is still in flight
   * is undone: the attempt completes afterwards, re-assigns the client and sets
   * `#connected = true`, and the adapter then reports ready and holds a client
   * although shutdown has already run — with no second `disconnect()` coming.
   */
  #generation = 0;

  /**
   * Creates the adapter.
   *
   * @param options - The `'cosmos'` arm options
   * @throws {Error} When neither `client` nor an `endpoint`/`key` pair is
   *   supplied, or when `database` is absent. A typed caller cannot reach
   *   this — {@linkcode CosmosAdapterOptions} is a union whose arms each
   *   require one of the two — but the plugin builds the bag through an
   *   untyped carry, so the runtime guard is the backstop for that cast
   *   rather than dead code.
   */
  constructor(options: CosmosAdapterOptions) {
    if (
      options.client === undefined && (options.endpoint === undefined || options.key === undefined)
    ) {
      throw new Error(
        'CosmosAdapter requires either options.client or options.endpoint + options.key',
      );
    }
    if (options.database === undefined || options.database === '') {
      throw new Error(
        'CosmosAdapter requires options.database: a Cosmos endpoint encodes no database name, so ' +
          'there is nothing to fall back to',
      );
    }
    this.#options = options;
    this.#mapping = options.containers;
  }

  /**
   * Establishes the connection: resolves the client and proves the database is
   * reachable with these credentials.
   *
   * Nothing is retained until the connection is fully established, and the
   * in-flight attempt is never cached past settlement — holding a rejected
   * promise would turn one transient outage into a permanently unusable
   * adapter.
   *
   * @inheritdoc
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const inFlight = this.#connecting;
    // Only an attempt from the CURRENT generation may be shared: one started
    // before a `disconnect()` will discard its own result, so awaiting it would
    // report a connection that does not exist.
    if (inFlight !== null && inFlight.generation === this.#generation) {
      return await inFlight.promise;
    }
    const pending = { generation: this.#generation, promise: this.#establish() };
    this.#connecting = pending;
    try {
      await pending.promise;
    } finally {
      // Clear only our own attempt: a `disconnect()` and reconnect during this
      // one will have installed a newer attempt that must survive.
      if (this.#connecting === pending) this.#connecting = null;
    }
  }

  /**
   * Performs one connection attempt.
   *
   * @throws {Error} When the SDK cannot be loaded or the database is unreachable
   */
  async #establish(): Promise<void> {
    const generation = this.#generation;
    const loader: CosmosClientLoader = this.#options.client !== undefined
      ? createInjectedClientLoader(this.#options.client)
      : await createLazyClientLoader(this.#options.endpoint as string, this.#options.key as string);
    const client = await loader.createClient();
    const database = client.database(this.#options.database as string);
    // A database read is the cheapest proof that the endpoint, the key and the
    // database name are all usable. Failing here beats failing on the first
    // request, and it names the database rather than the operation.
    try {
      await database.read();
    } catch (error) {
      throw new Error(
        `CosmosAdapter could not reach database '${this.#options.database}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // A `disconnect()` during this attempt bumped the generation, so the result
    // is dropped rather than resurrecting a closed adapter.
    if (generation !== this.#generation) return;
    this.#client = client;
    this.#database = database;
    this.#partitionKeys = new PartitionKeyResolver(database);
    this.#connected = true;
  }

  /**
   * Releases the client and the per-container caches.
   *
   * The SDK client holds no socket the adapter must close — it is a
   * `fetch`-based handle — so this drops the references rather than closing
   * something, and an injected client stays usable by the application that
   * supplied it.
   *
   * @inheritdoc
   */
  disconnect(): Promise<void> {
    this.#generation += 1;
    this.#client = null;
    this.#database = null;
    this.#partitionKeys = null;
    this.#connected = false;
    return Promise.resolve();
  }

  /** Reports whether the adapter is connected. @inheritdoc */
  isReady(): boolean {
    return this.#connected;
  }

  /** Returns a data source for the named entity's container. @inheritdoc */
  createDataSource(entity: string): IDataSource {
    this.#assertConnected();
    return createCosmosDataSource({
      database: this.#database as ICosmosDatabase,
      target: this.#target(entity),
      partitionKeys: this.#partitionKeys as PartitionKeyResolver,
    });
  }

  /**
   * Opens a deferred-write transaction whose buffer is flushed as one
   * transactional batch at commit.
   *
   * Cosmos has no interactive transaction, so reads inside it observe
   * committed state only and every write lands at commit — the contract's
   * deferred-write clause, and the shape `D1Adapter` established.
   *
   * @inheritdoc
   */
  beginTransaction(): Promise<IAdapterTransaction> {
    // The not-connected refusal REJECTS rather than throwing synchronously:
    // this method is typed `Promise<…>`, and a synchronous throw bypasses any
    // caller using `.catch()`. `createDataSource` returns its value
    // synchronously, so its own throw is correct as it stands.
    if (!this.#connected) {
      return Promise.reject(new Error('CosmosAdapter is not connected — call connect() first'));
    }
    return Promise.resolve(
      new CosmosTransaction(
        this.#database as ICosmosDatabase,
        this.#partitionKeys as PartitionKeyResolver,
        (entity) => this.#target(entity),
      ),
    );
  }

  /**
   * Refuses the raw query by name.
   *
   * Cosmos has a SQL dialect, but every query is scoped to ONE container and
   * this signature has nowhere to name it — guessing one would be the silent
   * divergence M70j closed elsewhere. An application reaches the injected
   * client directly for a container-scoped query.
   *
   * It rejects, never throws synchronously.
   *
   * @inheritdoc
   */
  // deno-lint-ignore require-await -- the refusal must REJECT, not throw synchronously
  async rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    throw new UnsupportedRawQueryError(
      'cosmos',
      'CosmosAdapter does not support container-less raw queries. A Cosmos SQL query is scoped to ' +
        'one container and this signature names none; use the injected client directly ' +
        '(container.items.query).',
    );
  }

  /**
   * Resolves an entity name to its target.
   *
   * @param entity - The entity name
   * @returns The resolved target
   */
  #target(entity: string): CosmosTarget {
    return resolveCosmosTarget(entity, this.#mapping);
  }

  /**
   * Asserts the adapter is connected before a data operation.
   *
   * @throws {Error} When the adapter is not connected
   */
  #assertConnected(): void {
    if (!this.#connected) {
      throw new Error('CosmosAdapter is not connected — call connect() first');
    }
  }
}
