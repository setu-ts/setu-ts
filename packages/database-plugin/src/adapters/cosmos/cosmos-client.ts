/**
 * Injection seam for the `@azure/cosmos` SDK — the structural
 * {@linkcode ICosmosClient} facade the adapter operates against, plus the
 * inject-or-lazy loader that supplies the real module on the lazy path.
 *
 * The adapter never imports `npm:@azure/cosmos` directly: it accepts a client
 * through {@linkcode CosmosAdapterOptions.client} (preferred — the application
 * constructs and configures it, which is also how a managed-identity or
 * connection-string client reaches the adapter) or loads it lazily at
 * `connect()` time. The loader performs a real, literal
 * `import('npm:@azure/cosmos@^4')`, so the seam is not a global-hook shim that
 * only tests populate (the CLAUDE.md pitfall: a `globalThis.__x` loader throws
 * in production even when the package is installed).
 *
 * @module
 */
import type {
  CosmosAccessCondition,
  CosmosBatchDeleteOperation,
  CosmosBatchInsertOperation,
  CosmosBatchOperation,
  CosmosBatchPatchOperation,
  CosmosBatchReplaceOperation,
  CosmosBatchResponse,
  CosmosContainerDefinition,
  CosmosFeedResponse,
  CosmosItemResponse,
  CosmosPartitionKeyValue,
  CosmosPatchOperation,
  CosmosQueryParameter,
  CosmosQuerySpec,
  CosmosRequestOptions,
  ICosmosClient,
  ICosmosContainer,
  ICosmosDatabase,
  ICosmosItem,
  ICosmosItems,
  ICosmosQueryIterator,
} from './cosmos-client-types.ts';

/**
 * A structural subset of the SDK `CosmosClient` — the members the adapter
 * drives.
 *
 * @since 0.2.0
 */
export type { ICosmosClient };

/**
 * A structural subset of the SDK `Database`.
 *
 * @since 0.2.0
 */
export type { ICosmosDatabase };

/**
 * A structural subset of the SDK `Container`.
 *
 * @since 0.2.0
 */
export type { ICosmosContainer };

/**
 * A structural subset of the SDK `Items` collection.
 *
 * @since 0.2.0
 */
export type { ICosmosItems };

/**
 * A structural subset of the SDK `Item` handle.
 *
 * @since 0.2.0
 */
export type { ICosmosItem };

/**
 * A query iterator, narrowed to the one member the adapter uses.
 *
 * @since 0.2.0
 */
export type { ICosmosQueryIterator };

/**
 * One named query parameter.
 *
 * @since 0.2.0
 */
export type { CosmosQueryParameter };

/**
 * A parameterized Cosmos SQL query.
 *
 * @since 0.2.0
 */
export type { CosmosQuerySpec };

/**
 * A partition-key value as Cosmos accepts it.
 *
 * @since 0.2.0
 */
export type { CosmosPartitionKeyValue };

/**
 * The response envelope every single-item operation answers with.
 *
 * @since 0.2.0
 */
export type { CosmosItemResponse };

/**
 * A materialized query response.
 *
 * @since 0.2.0
 */
export type { CosmosFeedResponse };

/**
 * The container definition the partition-key resolver reads.
 *
 * @since 0.2.0
 */
export type { CosmosContainerDefinition };

/**
 * Per-request options for a single-item operation.
 *
 * @since 0.2.0
 */
export type { CosmosRequestOptions };

/**
 * The optimistic-concurrency guard the replace path sends.
 *
 * @since 0.2.0
 */
export type { CosmosAccessCondition };

/**
 * One `set` patch operation.
 *
 * @since 0.2.0
 */
export type { CosmosPatchOperation };

/**
 * One operation in a transactional batch — a discriminated union, so a `Patch`
 * carrying a document body (or a `Delete` carrying one at all) is a compile
 * error rather than a request the service refuses.
 *
 * @since 0.2.0
 */
export type { CosmosBatchOperation };

/**
 * The batch arm inserting a whole document (`Create`, `Upsert`).
 *
 * @since 0.2.0
 */
export type { CosmosBatchInsertOperation };

/**
 * The batch arm overwriting a whole document, which names the id it replaces.
 *
 * @since 0.2.0
 */
export type { CosmosBatchReplaceOperation };

/**
 * The batch arm carrying patch operations, which COMPOSE when two of them
 * address the same item.
 *
 * @since 0.2.0
 */
export type { CosmosBatchPatchOperation };

/**
 * The batch arm removing one document.
 *
 * @since 0.2.0
 */
export type { CosmosBatchDeleteOperation };

/**
 * The response a transactional batch answers with.
 *
 * @since 0.2.0
 */
export type { CosmosBatchResponse };

/**
 * The `@azure/cosmos` module shape the lazy loader adapts.
 *
 * @since 0.2.0
 */
export interface CosmosSdkModule {
  /** The SDK `CosmosClient` constructor. */
  CosmosClient: new (options: { endpoint: string; key: string }) => ICosmosClient;
}

/**
 * The client loader seam — an injected client (no import), or a lazy loader
 * that performs the real `npm:@azure/cosmos@^4` import.
 *
 * @since 0.2.0
 */
export interface CosmosClientLoader {
  /**
   * Supplies the client.
   *
   * @returns The client to drive
   */
  createClient(): Promise<ICosmosClient>;
}

/**
 * A client supplied through options: an already-constructed
 * {@linkcode ICosmosClient}.
 *
 * @param client - The constructed client
 * @returns A loader that hands the client back without importing anything
 * @since 0.2.0
 */
export function createInjectedClientLoader(client: ICosmosClient): CosmosClientLoader {
  return {
    createClient: (): Promise<ICosmosClient> => Promise.resolve(client),
  };
}

/**
 * A lazy loader that constructs a client from the literal
 * `npm:@azure/cosmos@^4` specifier at `connect()` time.
 *
 * Performs a real `import('npm:@azure/cosmos@^4')`; the SDK is resolved by the
 * runtime at call time and is not part of this package's dependency graph.
 *
 * @param endpoint - The account endpoint (for example `https://acct.documents.azure.com:443/`)
 * @param key - The account key
 * @returns A loader that performs the real import on first use
 * @since 0.2.0
 */
export async function createLazyClientLoader(
  endpoint: string,
  key: string,
): Promise<CosmosClientLoader> {
  const mod = await import('npm:@azure/cosmos@^4') as unknown as CosmosSdkModule;
  return {
    createClient: (): Promise<ICosmosClient> =>
      Promise.resolve(new mod.CosmosClient({ endpoint, key })),
  };
}
