/**
 * Internal structural types for the `@azure/cosmos` SDK, owned by the Cosmos
 * adapter.
 *
 * These are the SDK's public shapes narrowed to exactly what the adapter
 * calls, so the adapter never imports the SDK's own classes (a backend must be
 * implementable without importing another package's concrete types —
 * AI_GUIDELINES §2.2, and §12.2 keeps the driver out of this package's
 * dependency graph). A faithful test double that reproduces these members is
 * assignable here.
 *
 * Every shape below was measured against `@azure/cosmos@4` driving the real
 * emulator: the response envelopes (`{ statusCode, resource }`), the fact that
 * a 404 point read RETURNS rather than throws, and the batch response
 * (`{ code, result }`). Reproducing the measured shapes is what keeps a test
 * double from being more forgiving than the SDK.
 *
 * This file is internal and NOT exported from the package.
 *
 * @internal
 * @module
 */

/**
 * A partition-key value as Cosmos accepts it: a JSON scalar, or an array of
 * them for a hierarchical (`MultiHash`) partition key.
 *
 * @since 0.2.0
 */
export type CosmosPartitionKeyValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean | null)[];

/**
 * One named query parameter. Values are always bound rather than interpolated,
 * so a value can never be read as SQL.
 *
 * @since 0.2.0
 */
export interface CosmosQueryParameter {
  /** The parameter name, including its leading `@`. */
  readonly name: string;
  /** The bound value. */
  readonly value: unknown;
}

/**
 * A parameterized Cosmos SQL query — the shape `items.query` accepts.
 *
 * @since 0.2.0
 */
export interface CosmosQuerySpec {
  /** The SQL text, with `@name` placeholders for every value. */
  readonly query: string;
  /** The bound parameters. */
  readonly parameters: readonly CosmosQueryParameter[];
}

/**
 * The response envelope every single-item operation answers with.
 *
 * `resource` is `undefined` for a 404 point read — measured, and the reason
 * the read path branches on the field rather than catching.
 *
 * @typeParam T - The resource shape
 * @since 0.2.0
 */
export interface CosmosItemResponse<T> {
  /** The HTTP status code. */
  readonly statusCode: number;
  /** The resource, or `undefined` when none was returned. */
  readonly resource?: T;
}

/**
 * A materialized query response.
 *
 * @typeParam T - The row shape
 * @since 0.2.0
 */
export interface CosmosFeedResponse<T> {
  /** The rows the query returned. */
  readonly resources: T[];
}

/**
 * A query iterator, narrowed to the one member the adapter uses.
 *
 * `fetchNext()` is deliberately absent: the adapter pages by the portable
 * keyset cursor rather than by continuation token, because Cosmos returns no
 * continuation token for a query carrying `ORDER BY` (measured).
 *
 * @typeParam T - The row shape
 * @since 0.2.0
 */
export interface ICosmosQueryIterator<T> {
  /**
   * Materializes every matching row.
   *
   * @returns The feed response carrying the rows
   */
  fetchAll(): Promise<CosmosFeedResponse<T>>;
}

/**
 * One access condition — the optimistic-concurrency guard the replace path
 * uses.
 *
 * @since 0.2.0
 */
export interface CosmosAccessCondition {
  /** The condition kind; the adapter only ever sends `IfMatch`. */
  readonly type: 'IfMatch';
  /** The `_etag` the write is conditional on. */
  readonly condition: string;
}

/**
 * Per-request options the adapter passes to a single-item operation.
 *
 * @since 0.2.0
 */
export interface CosmosRequestOptions {
  /** The optimistic-concurrency guard, when the write is conditional. */
  readonly accessCondition?: CosmosAccessCondition;
}

/**
 * One JSON-patch-shaped operation. The adapter only emits `set`, and only for
 * top-level fields, so the "cannot create a path whose parent is absent"
 * limitation measured on the SDK is unreachable through it.
 *
 * @since 0.2.0
 */
export interface CosmosPatchOperation {
  /** The operation kind. */
  readonly op: 'set';
  /** The document path, always a single leading-slash segment. */
  readonly path: string;
  /** The value to set. */
  readonly value: unknown;
}

/**
 * One operation in a transactional batch.
 *
 * @since 0.2.0
 */
export type CosmosBatchOperation =
  | CosmosBatchInsertOperation
  | CosmosBatchReplaceOperation
  | CosmosBatchPatchOperation
  | CosmosBatchDeleteOperation;

/**
 * A batch operation inserting a whole document. The id is optional: the
 * service mints one when the body carries none.
 *
 * @since 0.2.0
 */
export interface CosmosBatchInsertOperation {
  /** The operation kind. */
  readonly operationType: 'Create' | 'Upsert';
  /** The document to write. */
  readonly resourceBody: Record<string, unknown>;
  /** The document id, when the caller chose one. */
  readonly id?: string;
}

/**
 * A batch operation overwriting a whole document, which therefore names the
 * document it replaces.
 *
 * @since 0.2.0
 */
export interface CosmosBatchReplaceOperation {
  /** The operation kind. */
  readonly operationType: 'Replace';
  /** The document id. */
  readonly id: string;
  /** The document to write in its place. */
  readonly resourceBody: Record<string, unknown>;
}

/**
 * A batch operation carrying patch operations rather than a whole document.
 *
 * Two of these addressing the same item COMPOSE — measured against the
 * emulator, `[set /a, set /b]` on one id answers `[200, 200]` and leaves both
 * fields set — which is what lets a Unit of Work update one row twice without
 * the second write discarding the first.
 *
 * @since 0.2.0
 */
export interface CosmosBatchPatchOperation {
  /** The operation kind. */
  readonly operationType: 'Patch';
  /** The document id. */
  readonly id: string;
  /** The patch operations, in the envelope the SDK expects. */
  readonly resourceBody: { readonly operations: readonly CosmosPatchOperation[] };
}

/**
 * A batch operation removing one document.
 *
 * @since 0.2.0
 */
export interface CosmosBatchDeleteOperation {
  /** The operation kind. */
  readonly operationType: 'Delete';
  /** The document id. */
  readonly id: string;
}

/**
 * The response a transactional batch answers with.
 *
 * @since 0.2.0
 */
export interface CosmosBatchResponse {
  /** The overall status code; `200` when every operation succeeded. */
  readonly code?: number;
  /** The per-operation results, in the order the operations were sent. */
  readonly result?: readonly { readonly statusCode: number }[];
}

/**
 * A structural subset of the SDK `Items` collection — the members the data
 * source drives.
 *
 * @since 0.2.0
 */
export interface ICosmosItems {
  /**
   * Inserts one document, refusing a duplicate id within the partition.
   *
   * @param body - The document to insert
   * @returns The created document envelope
   */
  create(body: Record<string, unknown>): Promise<CosmosItemResponse<Record<string, unknown>>>;

  /**
   * Runs a parameterized SQL query across the container.
   *
   * @param spec - The query text and its bound parameters
   * @returns An iterator over the matching rows
   */
  query(spec: CosmosQuerySpec): ICosmosQueryIterator<Record<string, unknown>>;

  /**
   * Runs a transactional batch, atomic within one partition-key value.
   *
   * @param operations - The operations, at most 100
   * @param partitionKey - The single partition-key value every operation targets
   * @returns The batch response
   */
  batch(
    operations: readonly CosmosBatchOperation[],
    partitionKey: CosmosPartitionKeyValue,
  ): Promise<CosmosBatchResponse>;
}

/**
 * A structural subset of the SDK `Item` handle — one document addressed by its
 * id and partition key.
 *
 * @since 0.2.0
 */
export interface ICosmosItem {
  /**
   * Reads the document.
   *
   * @returns The envelope; `resource` is `undefined` when the document does
   *   not exist under this partition key (a 404 does NOT throw)
   */
  read(): Promise<CosmosItemResponse<Record<string, unknown>>>;

  /**
   * Replaces the document wholesale.
   *
   * @param body - The full replacement document
   * @param options - Per-request options (the `IfMatch` guard)
   * @returns The replaced document envelope
   */
  replace(
    body: Record<string, unknown>,
    options?: CosmosRequestOptions,
  ): Promise<CosmosItemResponse<Record<string, unknown>>>;

  /**
   * Applies a patch to the document server-side.
   *
   * @param operations - The `set` operations to apply
   * @returns The patched document envelope
   */
  patch(
    operations: readonly CosmosPatchOperation[],
  ): Promise<CosmosItemResponse<Record<string, unknown>>>;

  /**
   * Deletes the document, throwing a 404 when it does not exist.
   *
   * @returns The delete envelope
   */
  delete(): Promise<CosmosItemResponse<Record<string, unknown>>>;
}

/**
 * The container definition the partition-key resolver reads.
 *
 * @since 0.2.0
 */
export interface CosmosContainerDefinition {
  /** The partition-key definition, present on every container. */
  readonly partitionKey?: {
    /** The document paths the partition key is composed of, each leading-slash. */
    readonly paths?: readonly string[];
    /** `MultiHash` for a hierarchical key; absent for a single-path one. */
    readonly kind?: string;
  };
}

/**
 * A structural subset of the SDK `Container` — the members the adapter drives.
 *
 * @since 0.2.0
 */
export interface ICosmosContainer {
  /** The document collection. */
  readonly items: ICosmosItems;

  /**
   * Addresses one document by id and partition key.
   *
   * @param id - The document id
   * @param partitionKey - The partition-key value
   * @returns The item handle
   */
  item(id: string, partitionKey?: CosmosPartitionKeyValue): ICosmosItem;

  /**
   * Reads the container definition, which is also what proves the container
   * exists.
   *
   * @returns The definition envelope
   */
  read(): Promise<CosmosItemResponse<CosmosContainerDefinition>>;
}

/**
 * A structural subset of the SDK `Database`.
 *
 * @since 0.2.0
 */
export interface ICosmosDatabase {
  /**
   * Addresses a container by id. The container is not created.
   *
   * @param id - The container id
   * @returns The container handle
   */
  container(id: string): ICosmosContainer;

  /**
   * Reads the database, proving the credentials and the database name.
   *
   * @returns The read envelope
   */
  read(): Promise<CosmosItemResponse<Record<string, unknown>>>;
}

/**
 * A structural subset of the SDK `CosmosClient` — the members the adapter
 * drives.
 *
 * @since 0.2.0
 */
export interface ICosmosClient {
  /**
   * Addresses a database by id. The database is not created.
   *
   * @param id - The database id
   * @returns The database handle
   */
  database(id: string): ICosmosDatabase;
}
