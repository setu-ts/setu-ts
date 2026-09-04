/**
 * The Bigtable adapter — a first-class `'bigtable'` arm of the database
 * plugin, serving Google Cloud Bigtable's wide-column store.
 *
 * Implements {@linkcode IDatabaseAdapter} from `@setu-ts/common`: all six
 * `IDataSource` members plus `findPage`, and the one SQL-shaped member
 * Bigtable has no surface for, {@linkcode BigtableAdapter.rawQuery}, refused
 * by name.
 *
 * **Bigtable inverts the DynamoDB problem.** Its row key is a single
 * lexicographically-sorted string, so `findById` fits it natively with no key
 * object at all. What it lacks instead is everything around the key: there is
 * no secondary index of any kind, so a predicate on a non-key column is a scan
 * with a server-side filter rather than an index seek, and `orderBy` is
 * row-key order or nothing.
 *
 * The client is supplied inject-or-lazy (AI_GUIDELINES §12.2):
 * `options.client` — the route for a client built with non-default
 * credentials — or a lazy literal `import('npm:@google-cloud/bigtable@^6')` at
 * {@linkcode BigtableAdapter.connect} time.
 *
 * @module
 */
import type { IAdapterTransaction, IDatabaseAdapter, IDataSource } from '@setu-ts/common';
import type { BigtableAdapterOptions } from '../../interfaces/index.ts';
import { UnsupportedRawQueryError } from '../../errors.ts';
import type { IBigtableClient, IBigtableInstance } from './bigtable-client-types.ts';
import {
  type BigtableClientLoader,
  createInjectedBigtableLoader,
  createLazyBigtableLoader,
} from './bigtable-client.ts';
import type { BigtableEntityMapping, BigtableTarget } from './bigtable-mapping.ts';
import { resolveBigtableTarget } from './bigtable-mapping.ts';
import { createBigtableDataSource } from './bigtable-data-source.ts';
import { BigtableTransaction } from './bigtable-transaction.ts';

/**
 * The Bigtable adapter.
 *
 * Constructed by `DatabasePlugin` for the `'bigtable'` arm, and also
 * constructible directly by an application for the `'custom'` arm.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@setu-ts/database-plugin';
 *
 * app.register(DatabasePlugin({
 *   type: 'bigtable',
 *   options: {
 *     projectId: 'my-project',
 *     instance: 'app-instance',
 *     tables: {
 *       Order: {
 *         table: 'orders',
 *         rowKey: { fields: ['tenantId', 'orderId'] },
 *         columnFamily: 'o',
 *       },
 *     },
 *   },
 * }));
 * ```
 * @since 0.2.0
 */
export class BigtableAdapter implements IDatabaseAdapter {
  readonly #options: BigtableAdapterOptions;
  readonly #mapping: Readonly<Record<string, BigtableEntityMapping>> | undefined;
  readonly #loader: BigtableClientLoader;
  #client: IBigtableClient | null = null;
  #instance: IBigtableInstance | null = null;
  /**
   * The in-flight `connect()`, TAGGED with the generation it belongs to, so
   * concurrent callers share one attempt while an attempt a `disconnect()`
   * superseded is never awaited as if it had succeeded.
   */
  #connecting: { readonly generation: number; readonly promise: Promise<void> } | null = null;
  #connected = false;
  /** Bumped by `disconnect()`, so a superseded attempt discards its result. */
  #generation = 0;

  /**
   * Creates the adapter and validates its configuration.
   *
   * The validation is the point: a blank instance id is otherwise a bare gRPC
   * failure on the first request rather than a named configuration error at
   * construction — the guard family M52c's and M52d's reviews added for D1 and
   * Durable Objects.
   *
   * @param options - The `'bigtable'` arm options
   * @param loader - An explicit client loader, overriding the inject-or-lazy
   *   choice `options` would otherwise make. Supply one to wrap a
   *   differently-pinned SDK module around
   *   {@linkcode createLazyBigtableLoader}'s adaptation; the loader's `owned`
   *   flag decides whether {@linkcode BigtableAdapter.disconnect} closes the
   *   client it produced.
   * @throws {Error} When neither `client` nor `projectId` is supplied, when
   *   `instance` is absent or blank, or when `maxPageFetches` is not a
   *   positive integer
   */
  constructor(options: BigtableAdapterOptions, loader?: BigtableClientLoader) {
    if (options.client === undefined && (options.projectId ?? '').trim() === '') {
      throw new Error('BigtableAdapter requires either options.client or options.projectId');
    }
    if ((options.instance ?? '').trim() === '') {
      throw new Error(
        'BigtableAdapter requires options.instance: a Bigtable table is addressed as ' +
          'project/instance/table, and neither a client nor a project encodes the instance',
      );
    }
    // `NaN` is the input this guard exists for, and it fails silently rather
    // than loudly: `fetches < maxPageFetches` is `false` for it, so the page
    // loop would never run a single fetch and EVERY `findPage` would answer an
    // empty terminal page. `0` and a negative disable it the same way.
    const pageFetches = options.maxPageFetches;
    if (
      pageFetches !== undefined &&
      (!Number.isInteger(pageFetches) || pageFetches < 1)
    ) {
      throw new Error(
        `BigtableAdapter requires options.maxPageFetches to be a positive integer; ` +
          `received ${String(pageFetches)}. A non-positive or NaN bound stops the page loop ` +
          `before its first fetch, so every findPage would answer an empty terminal page.`,
      );
    }
    this.#options = options;
    this.#mapping = options.tables;
    this.#loader = loader ??
      (options.client !== undefined
        ? createInjectedBigtableLoader(options.client)
        : createLazyBigtableLoader({
          projectId: options.projectId as string,
          ...(options.apiEndpoint === undefined ? {} : { apiEndpoint: options.apiEndpoint }),
        }));
  }

  /**
   * Resolves the client and the instance handle.
   *
   * **No RPC is issued.** A missing table or instance already answers
   * `5 NOT_FOUND` quoting the full resource path (measured), so a probe would
   * buy no diagnostic — while `instance.getTables()` is a table-ADMIN call a
   * data-plane service account commonly cannot make, so probing would refuse a
   * working configuration.
   *
   * @inheritdoc
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const inFlight = this.#connecting;
    if (inFlight !== null && inFlight.generation === this.#generation) {
      return await inFlight.promise;
    }
    const pending = { generation: this.#generation, promise: this.#establish() };
    this.#connecting = pending;
    try {
      await pending.promise;
    } finally {
      if (this.#connecting === pending) this.#connecting = null;
    }
  }

  /**
   * Performs one connection attempt.
   *
   * @throws {Error} When the SDK cannot be loaded
   */
  async #establish(): Promise<void> {
    const generation = this.#generation;
    const client = await this.#loader.load();
    const instance = client.instance(this.#options.instance);
    if (generation !== this.#generation) {
      // A `disconnect()` landed during this attempt, so its result is dropped
      // rather than resurrecting a closed adapter — and a client this attempt
      // created is closed here, because nothing else now holds it.
      if (this.#loader.owned) await client.close();
      return;
    }
    this.#client = client;
    this.#instance = instance;
    this.#connected = true;
  }

  /**
   * Releases the client.
   *
   * Only a client this adapter CREATED is closed: closing an injected one
   * would tear down gRPC channels the application still owns.
   *
   * @inheritdoc
   */
  async disconnect(): Promise<void> {
    this.#generation += 1;
    const client = this.#client;
    this.#client = null;
    this.#instance = null;
    this.#connected = false;
    if (client !== null && this.#loader.owned) await client.close();
  }

  /** Reports whether the adapter is connected. @inheritdoc */
  isReady(): boolean {
    return this.#connected;
  }

  /** Returns a data source for the named entity's table. @inheritdoc */
  createDataSource(entity: string): IDataSource {
    this.#assertConnected();
    const target = this.#target(entity);
    return createBigtableDataSource(
      (this.#instance as IBigtableInstance).table(target.table),
      target,
      this.#options.maxPageFetches === undefined
        ? {}
        : { maxPageFetches: this.#options.maxPageFetches },
    );
  }

  /**
   * Opens a single-row deferred-write transaction.
   *
   * @inheritdoc
   */
  beginTransaction(): Promise<IAdapterTransaction> {
    // REJECTS rather than throwing synchronously: this method is typed
    // `Promise<…>`, and a synchronous throw bypasses a caller using `.catch()`.
    if (!this.#connected) {
      return Promise.reject(new Error('BigtableAdapter is not connected — call connect() first'));
    }
    const maxPageFetches = this.#options.maxPageFetches;
    return Promise.resolve(
      new BigtableTransaction(
        this.#instance as IBigtableInstance,
        (entity) => this.#target(entity),
        (table, target, buffer) =>
          createBigtableDataSource(table, target, {
            buffer,
            ...(maxPageFetches === undefined ? {} : { maxPageFetches }),
          }),
      ),
    );
  }

  /**
   * Refuses the raw query by name.
   *
   * Bigtable has no query language reachable through `query(sql, params)` —
   * its data plane is ReadRows, MutateRow and CheckAndMutateRow. An
   * application reaching for GoogleSQL uses the injected client directly.
   *
   * It rejects, never throws synchronously.
   *
   * @inheritdoc
   */
  // deno-lint-ignore require-await -- the refusal must REJECT, not throw synchronously
  async rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    throw new UnsupportedRawQueryError(
      'bigtable',
      'BigtableAdapter does not support raw queries. Bigtable has no SQL surface behind ' +
        'query(sql, params) — its data plane is ReadRows, MutateRow and CheckAndMutateRow. ' +
        'Use the injected client directly for anything the portable contract does not express.',
    );
  }

  /**
   * Resolves an entity name to its target.
   *
   * @param entity - The entity name
   * @returns The resolved target
   */
  #target(entity: string): BigtableTarget {
    return resolveBigtableTarget(entity, this.#mapping);
  }

  /**
   * Asserts the adapter is connected before a data operation.
   *
   * @throws {Error} When the adapter is not connected
   */
  #assertConnected(): void {
    if (!this.#connected) {
      throw new Error('BigtableAdapter is not connected — call connect() first');
    }
  }
}
