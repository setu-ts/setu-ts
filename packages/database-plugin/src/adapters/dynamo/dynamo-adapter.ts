/**
 * DynamoDB adapter over the native `@aws-sdk/client-dynamodb` — the backend
 * `DatabasePlugin` constructs for the `'dynamodb'` arm, and an application
 * constructs directly for the `'custom'` arm.
 *
 * Implements {@linkcode IDatabaseAdapter} from `@setu-ts/common`: per-entity
 * data sources via {@linkcode createDynamoDataSource}, and **deferred
 * transactions** — writes buffer in a transaction-owned
 * {@linkcode IDynamoTransactionBuffer} and flush as ONE `TransactWriteItems`
 * call at commit; rollback discards the buffer without contacting DynamoDB.
 * DynamoDB has no interactive transaction to hold open, so this is the M52c
 * D1 deferred-batch shape, with the two measured constraints the plan records
 * (§1A T2/T3) enforced by the buffer before any adapter call is made: at most
 * 100 writes, and at most one operation per physical item key. Reads inside a
 * transaction hit committed state; read-your-own-writes is documented rather
 * than emulated.
 *
 * The client is supplied inject-or-lazy (§12.2 of AI_GUIDELINES):
 * {@linkcode DynamoAdapterOptions.client} (preferred — the application
 * constructs and configures it) or a lazy literal
 * `import('npm:@aws-sdk/client-dynamodb@^3')` at {@linkcode connect} time.
 * AWS SDK v3 performs no I/O while constructing a client, so `connect()`
 * resolves the loader and marks the adapter ready; the first command is the
 * first thing that can fail on the wire.
 *
 * @module
 */
import type { IAdapterTransaction, IDatabaseAdapter, IDataSource } from '@setu-ts/common';
import type { DynamoAdapterOptions } from '../../interfaces/index.ts';
import { UnsupportedRawQueryError } from '../../errors.ts';
import { createInjectedDynamoLoader, createLazyDynamoLoader } from './dynamo-client.ts';
import type { DynamoClientConfiguration } from './dynamo-client.ts';
import type { IDynamoClient } from './dynamo-client-types.ts';
import type { DynamoEntityMapping } from './dynamo-mapping.ts';
import { createDynamoDataSource } from './dynamo-data-source.ts';
import {
  createDynamoTransactionBuffer,
  type IDynamoTransactionBuffer,
} from './dynamo-transaction-buffer.ts';

/** The operations every injected client must expose — the driven surface. */
const CLIENT_MEMBERS = [
  'query',
  'scan',
  'getItem',
  'putItem',
  'updateItem',
  'deleteItem',
  'transactWriteItems',
  'destroy',
] as const;

/**
 * The DynamoDB adapter — a key-value store backend served through the portable
 * data-access contract.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@setu-ts/database-plugin';
 *
 * app.register(DatabasePlugin({
 *   type: 'dynamodb',
 *   options: { region: 'us-east-1' },
 * }));
 * ```
 * @since 0.1.0
 */
export class DynamoAdapter implements IDatabaseAdapter {
  #client: IDynamoClient | null = null;
  /** The in-flight `connect()`, so concurrent callers share one attempt. */
  #connecting: Promise<void> | null = null;
  #connected = false;
  /** Whether the adapter constructed the client (lazy arm) and owns `destroy()`. */
  #owned = false;
  readonly #options: DynamoAdapterOptions;

  /**
   * Creates the adapter.
   *
   * @param options - The `'dynamodb'` arm options; `region` is required unless
   *   `client` is supplied
   * @throws {Error} When neither `region` nor `client` is supplied. A typed
   *   caller cannot reach this — {@linkcode DynamoAdapterOptions} is a union
   *   whose arms each require one of the two — but the plugin builds the bag
   *   through an untyped carry (`buildAdapterOptions`), so the runtime guard
   *   is the backstop for that cast rather than dead code.
   * @throws {Error} When an injected `client` lacks the driven surface — the
   *   M52c/M52d binding-guard precedent: a mistyped client must fail at
   *   construction with a name rather than at the first request with a bare
   *   `TypeError`.
   * @throws {Error} When `maxPageFetches` is not a positive safe integer.
   *   `Infinity` would silently DISABLE the very bound the option configures
   *   (measured: a `findPage` whose filter matches nothing scans the whole
   *   partition to exhaustion instead of stopping), and `NaN` makes every
   *   `fetches < maxPageFetches` comparison `false`, collapsing the fill loop
   *   to a single server page. Both fail at construction rather than
   *   degrading a later page silently.
   */
  constructor(options: DynamoAdapterOptions) {
    if (options.client === undefined && options.region === undefined) {
      throw new Error('DynamoAdapter requires either options.client or options.region');
    }
    if (options.client !== undefined) {
      assertDrivenSurface(options.client);
    }
    assertPageFetchBound(options.maxPageFetches);
    this.#options = options;
  }

  /**
   * Establishes the adapter's client, resolving the injected or lazy loader.
   *
   * Nothing is retained until the loader resolves: a failure leaves `#client`
   * null, so a later `connect()` retries instead of returning silently behind
   * a permanently-unusable adapter (the Mongo `#establish` ordering lesson).
   *
   * @inheritdoc
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    // Concurrent callers share one attempt rather than each importing the SDK
    // and constructing a client, all but the last of which leaks. The attempt
    // is NEVER cached past settlement: holding a rejected promise here would
    // make a transient load failure permanent.
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
   * Performs one client-resolution attempt.
   *
   * @throws {Error} When the lazy SDK import cannot be loaded
   */
  async #establish(): Promise<void> {
    const injected = this.#options.client !== undefined;
    const loader = injected
      ? createInjectedDynamoLoader(this.#options.client)
      : createLazyDynamoLoader(this.#lazyConfiguration());
    const client = await loader.load();
    this.#client = client;
    this.#owned = !injected;
    this.#connected = true;
  }

  /**
   * Builds the AWS client configuration for the lazy arm.
   *
   * Optional members are omitted rather than set to `undefined`
   * (`exactOptionalPropertyTypes`), so the SDK receives exactly the settings
   * the application supplied.
   */
  #lazyConfiguration(): DynamoClientConfiguration {
    return {
      region: this.#options.region as string,
      ...(this.#options.endpoint === undefined ? {} : { endpoint: this.#options.endpoint }),
      ...(this.#options.credentials === undefined
        ? {}
        : { credentials: this.#options.credentials }),
    };
  }

  /**
   * Destroys the client the adapter constructed and releases it. An injected
   * client is released without `destroy()`: it belongs to the application,
   * which may reuse it.
   *
   * @inheritdoc
   */
  disconnect(): Promise<void> {
    if (this.#client !== null) {
      if (this.#owned) this.#client.destroy();
      this.#client = null;
    }
    this.#connected = false;
    return Promise.resolve();
  }

  /** Reports whether the adapter resolved a client. @inheritdoc */
  isReady(): boolean {
    return this.#connected;
  }

  /** Returns a data source for the named entity's table. @inheritdoc */
  createDataSource(entity: string): IDataSource {
    this.#assertConnected();
    return createDynamoDataSource(
      this.#client as IDynamoClient,
      entity,
      this.#options.entities,
      this.#options.maxPageFetches,
    );
  }

  /**
   * Opens a deferred transaction: an empty buffer shared by every data source
   * created from the returned handle. Commit flushes the buffer as one
   * `TransactWriteItems` call; rollback discards it and sends nothing.
   *
   * @inheritdoc
   */
  // deno-lint-ignore require-await -- the not-connected refusal must REJECT, not throw synchronously
  async beginTransaction(): Promise<IAdapterTransaction> {
    this.#assertConnected();
    const client = this.#client as IDynamoClient;
    return new DynamoTransaction(
      client,
      this.#options.entities,
      this.#options.maxPageFetches,
      createDynamoTransactionBuffer(),
    );
  }

  /**
   * Refuses the raw SQL query by name — DynamoDB has no SQL — rather than
   * emulating it (the silent-divergence defect M70j closed). The error names
   * the adapter and points at the client for native commands.
   *
   * It rejects, never throws synchronously.
   *
   * @inheritdoc
   */
  // deno-lint-ignore require-await -- the refusal must REJECT, not throw synchronously
  async rawQuery<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    throw new UnsupportedRawQueryError(
      'DynamoAdapter does not support raw SQL queries. DynamoDB has no SQL; use the injected client ' +
        "directly for native commands (query / scan / getItem or the AWS SDK's PartiQL runner).",
    );
  }

  /**
   * Asserts the adapter resolved a client before a data operation.
   *
   * @throws {Error} When the adapter is not connected
   */
  #assertConnected(): void {
    if (!this.#connected) {
      throw new Error('DynamoAdapter is not connected — call connect() first');
    }
  }
}

/**
 * Validates that an injected client structurally exposes everything the
 * adapter drives — the M52c `isD1Database` / M52d `isDurableObjectNamespace`
 * binding-guard family applied to the injection seam: a client missing one
 * member otherwise boots clean and fails at the first request with a bare
 * `TypeError`, naming nothing.
 *
 * @param client - The client an application injected through `options.client`
 * @throws {Error} When the client is not an object, or when any driven
 *   operation is missing — every absent member is named in one message
 */
function assertDrivenSurface(client: IDynamoClient): void {
  if (typeof client !== 'object' || client === null) {
    throw new Error(
      `DynamoAdapter client must be an object exposing the DynamoDB operations: ` +
        `${CLIENT_MEMBERS.join(', ')}.`,
    );
  }
  const missing = CLIENT_MEMBERS.filter((member) => typeof client[member] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `DynamoAdapter client is missing the required DynamoDB operations: ${missing.join(', ')}.`,
    );
  }
}

/**
 * Validates the `findPage` fill-loop bound.
 *
 * The loop condition is `fetches < maxPageFetches`, so the two pathological
 * numeric values break it in opposite directions and neither raises anything:
 * `Infinity` can never be reached, removing the bound the option exists to
 * impose, and `NaN` makes the comparison `false` on the first pass, collapsing
 * the fill loop to one server page. A non-integer or non-positive value is
 * equally meaningless as a page count. All are refused at construction, where
 * the option is supplied, rather than silently changing a later page's cost.
 *
 * @param maxPageFetches - The configured bound, or `undefined` for the default
 * @throws {Error} When the value is not a positive safe integer
 */
function assertPageFetchBound(maxPageFetches: number | undefined): void {
  if (maxPageFetches === undefined) return;
  if (!Number.isSafeInteger(maxPageFetches) || maxPageFetches < 1) {
    throw new Error(
      `DynamoAdapter maxPageFetches must be a positive integer; received ${maxPageFetches}.`,
    );
  }
}

/**
 * The deferred transaction handle opened by
 * {@linkcode DynamoAdapter.beginTransaction}.
 *
 * Data sources created from the handle append their native Put/Update/Delete
 * items to one shared {@linkcode IDynamoTransactionBuffer}; the buffer itself
 * refuses a duplicate physical item key and a 101st write, each by name,
 * before any adapter call is made (M80 plan §1A T2/T3 — AWS reports both with
 * a `ValidationException` naming neither the entity nor the key). `commit`
 * retrieves the writes once and submits them in ONE `TransactWriteItems` call,
 * preserving call order; `rollback` discards the buffer and sends nothing.
 *
 * @internal
 */
class DynamoTransaction implements IAdapterTransaction {
  readonly #client: IDynamoClient;
  readonly #mappings: Readonly<Record<string, DynamoEntityMapping>> | undefined;
  readonly #maxPageFetches: number | undefined;
  readonly #buffer: IDynamoTransactionBuffer;
  #finalized = false;

  constructor(
    client: IDynamoClient,
    mappings: Readonly<Record<string, DynamoEntityMapping>> | undefined,
    maxPageFetches: number | undefined,
    buffer: IDynamoTransactionBuffer,
  ) {
    this.#client = client;
    this.#mappings = mappings;
    this.#maxPageFetches = maxPageFetches;
    this.#buffer = buffer;
  }

  /** @inheritdoc */
  async commit(): Promise<void> {
    if (this.#finalized) return;
    // Finality is claimed before the flush: a rejected TransactWriteItems ends
    // the handle, so a retrying caller cannot resend a partially-failed batch
    // (the MongoTransaction ordering).
    this.#finalized = true;
    const writes = this.#buffer.getWrites();
    // An empty TransactItems list is a guaranteed server-side rejection — the
    // API requires one to one hundred items — and a transaction with no
    // buffered write has nothing to commit, so zero writes send nothing.
    if (writes.length > 0) {
      await this.#client.transactWriteItems({ TransactItems: writes });
    }
  }

  /** @inheritdoc */
  rollback(): Promise<void> {
    if (!this.#finalized) {
      this.#finalized = true;
      // Rollback contacts DynamoDB with nothing: the writes were never sent,
      // so discarding the buffer is the whole transaction.
      this.#buffer.discard();
    }
    return Promise.resolve();
  }

  /** @inheritdoc */
  createDataSource(entity: string): IDataSource {
    if (this.#finalized) {
      throw new Error('DynamoAdapter transaction is already finalized');
    }
    return createDynamoDataSource(
      this.#client,
      entity,
      this.#mappings,
      this.#maxPageFetches,
      this.#buffer,
    );
  }
}
