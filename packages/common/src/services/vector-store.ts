/**
 * Vector-store port: tenant-scoped similarity search over collections declared
 * up front. The tenant scope is a required argument of every data method,
 * never a filter key, so no call can be built without it; a filter names only
 * declared fields and is refused, never ignored, when it cannot be honoured.
 *
 * The port and its data types live here; `@setu-ts/vector-store-plugin`
 * provides the service and the memory, pgvector and Qdrant adapters, and
 * `@setu-ts/cloudflare-plugin` the Vectorize adapter.
 *
 * @module
 */
import type { IRequestContext } from '../http.ts';
import type { IRuntimeServices } from '../runtime.ts';
import type { ILogger } from './logger.ts';

/**
 * The type a filterable metadata field is declared with.
 *
 * @since 0.12.0
 */
export type VectorFieldType = 'string' | 'number' | 'boolean';

/**
 * A metadata value: strings of at most 64 UTF-8 bytes, finite numbers, booleans.
 *
 * @since 0.12.0
 */
export type VectorMetadataValue = string | number | boolean;

/**
 * One collection, declared when the plugin is configured.
 *
 * @since 0.12.0
 */
export interface VectorCollectionSpec {
  /** Collection name: `^[a-z][a-z0-9_]{0,39}$`. */
  readonly name: string;
  /** Vector length, an integer from 1 to 4,096; an adapter may support fewer. */
  readonly dimensions: number;
  /**
   * The metadata fields a filter may name, with their types (at most 10). Field
   * names match `^[a-z][a-z0-9_]{0,63}$` and are not `scope`, `id`,
   * `source_id` or `content`.
   */
  readonly filterable?: Readonly<Record<string, VectorFieldType>>;
}

/**
 * One stored vector.
 *
 * @since 0.12.0
 */
export interface VectorRecord {
  /** Record id, unique within a scope: at most 256 UTF-8 bytes. */
  readonly id: string;
  /** The embedding; its length equals the collection's `dimensions`. */
  readonly vector: readonly number[];
  /** The source document this record was cut from; `replaceSource` keys on it. */
  readonly sourceId?: string;
  /** The chunk text, returned with matches and never filtered on (at most 8 KiB). */
  readonly content?: string;
  /** Values for declared filterable fields only. */
  readonly metadata?: Readonly<Record<string, VectorMetadataValue>>;
}

/**
 * Options for {@linkcode IVectorStore.replaceSource}.
 *
 * @since 0.12.0
 */
export interface VectorReplaceOptions {
  /**
   * The submission's version, a non-negative safe integer that grows with each
   * newer submission of the source (a counter, or a millisecond timestamp
   * taken when the submission was accepted). Records written without one
   * leave the source unversioned, and a source with no records keeps no
   * version, so a versioned write after either is accepted.
   */
  readonly version?: number;
}

/**
 * A filter over declared fields. Ranges apply to `number` fields only; `in`
 * takes 1 to 100 strings or numbers; `and` nests at most 4 deep. There is no
 * `or`, substring match or negation: three of the four backends cannot honour
 * them, and an operator a backend cannot translate would be refused anyway.
 *
 * @since 0.12.0
 */
export type VectorFilter =
  | {
      /** A field declared in the collection's `filterable`. */
      readonly field: string;
      /** Equality. */
      readonly op: 'eq';
      /** A value of the field's declared type. */
      readonly value: VectorMetadataValue;
    }
  | {
      /** A field declared in the collection's `filterable`. */
      readonly field: string;
      /** Membership in a list. */
      readonly op: 'in';
      /** Strings for a string field, numbers for a number field. */
      readonly value: readonly (string | number)[];
    }
  | {
      /** A field declared in the collection's `filterable`. */
      readonly field: string;
      /** A numeric range bound. */
      readonly op: 'gt' | 'gte' | 'lt' | 'lte';
      /** The bound; the field must be declared `number`. */
      readonly value: number;
    }
  | {
      /** Clauses that must all match. */
      readonly and: readonly VectorFilter[];
    };

/**
 * A similarity query.
 *
 * @since 0.12.0
 */
export interface VectorQuery {
  /** The query embedding; same length as the collection's vectors, non-zero. */
  readonly vector: readonly number[];
  /** Matches to return, an integer from 1 to 50. Any adapter may return fewer. */
  readonly topK: number;
  /** Restricts candidates to records whose metadata matches. */
  readonly filter?: VectorFilter;
  /** Drops matches whose cosine similarity is below this value, in `[-1, 1]`. */
  readonly minScore?: number;
}

/**
 * One query result.
 *
 * @since 0.12.0
 */
export interface VectorMatch {
  /** The record id as written. */
  readonly id: string;
  /** Cosine similarity in `[-1, 1]`; higher is closer. */
  readonly score: number;
  /** The record's source, when it had one. */
  readonly sourceId?: string;
  /** The record's chunk text, when it had one. */
  readonly content?: string;
  /** The record's declared metadata. */
  readonly metadata: Readonly<Record<string, VectorMetadataValue>>;
}

/**
 * The service registered under `CAPABILITIES.VECTOR_STORE`. Every data method
 * takes the collection name and the tenant scope first; results are ordered by
 * score descending, then id ascending.
 *
 * @example
 * ```typescript
 * const store = ctx.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
 * const matches = await store.query('documents', store.scopeFor(ctx), { vector, topK: 5 });
 * ```
 * @since 0.12.0
 */
export interface IVectorStore {
  /**
   * The scope for a request: the request's tenant id, or the configured fixed
   * scope when the store was configured with one (always, whatever the tenant).
   *
   * @param ctx - The request
   * @returns The scope to pass to the data methods
   * @throws {VectorScopeRequiredError} When tenancy is required and the request has no tenant
   */
  scopeFor(ctx: IRequestContext): string;
  /**
   * Inserts or replaces records by id within the scope (at most 500).
   *
   * @param collection - A declared collection
   * @param scope - The tenant scope
   * @param records - The records to write
   * @returns Once written
   */
  upsert(collection: string, scope: string, records: readonly VectorRecord[]): Promise<void>;
  /**
   * Writes a source's new records, then deletes that source's other records in
   * the scope, so a re-run with the same ids leaves one copy. One call replaces
   * the WHOLE source (up to 5,000 records); do not split a source across calls.
   *
   * With `options.version`, the write is conditional: it is refused when the
   * source's stored records carry a higher version, so a late retry of an
   * older submission cannot replace a newer one. An equal version is written
   * again, so a retry of the same submission succeeds.
   *
   * @param collection - A declared collection
   * @param scope - The tenant scope
   * @param sourceId - The source every record carries
   * @param records - The source's complete new set (at most 5,000)
   * @param options - The version to write under
   * @returns Once both steps finish
   * @throws {VectorVersionConflictError} When a newer version is stored
   * @throws {VectorOperationUnsupportedError} When a version is given and the
   *   adapter cannot write conditionally
   */
  replaceSource(
    collection: string,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
    options?: VectorReplaceOptions,
  ): Promise<void>;
  /**
   * Returns the closest records within the scope.
   *
   * @param collection - A declared collection
   * @param scope - The tenant scope
   * @param query - The query
   * @returns At most `topK` matches
   */
  query(collection: string, scope: string, query: VectorQuery): Promise<readonly VectorMatch[]>;
  /**
   * Deletes records by id within the scope (at most 1,000 ids).
   *
   * @param collection - A declared collection
   * @param scope - The tenant scope
   * @param ids - The record ids
   * @returns Once deleted
   */
  delete(collection: string, scope: string, ids: readonly string[]): Promise<void>;
  /**
   * Deletes every record of the scope in the collection (tenant offboarding).
   *
   * @param collection - A declared collection
   * @param scope - The tenant scope
   * @returns Once deleted
   */
  deleteScope(collection: string, scope: string): Promise<void>;
}

/**
 * A backend. The service validates every argument before calling it, so an
 * adapter receives the declared spec, a valid scope and valid records; it maps
 * the scope to its strongest native boundary and keeps its own refusals.
 *
 * @since 0.12.0
 */
export interface IVectorStoreAdapter {
  /** Short backend name used in error messages, e.g. `pgvector`. */
  readonly name: string;
  /**
   * Called once at registration, before any other method.
   *
   * @param runtime - Runtime services, e.g. `subtle` for id hashing
   * @param logger - The application's logger when one is registered, for
   *   faults the adapter reports outside a call (a dropped pooled connection)
   * @returns Once ready
   */
  open(runtime: IRuntimeServices, logger?: ILogger): Promise<void>;
  /**
   * Creates the collection or verifies an existing one, at registration.
   *
   * @param spec - The declared collection
   * @returns Once the collection is usable
   */
  ensureCollection(spec: VectorCollectionSpec): Promise<void>;
  /**
   * @param spec - The declared collection
   * @param scope - The tenant scope
   * @param records - Validated records
   * @returns Once written
   */
  upsert(
    spec: VectorCollectionSpec,
    scope: string,
    records: readonly VectorRecord[],
  ): Promise<void>;
  /**
   * Set by an adapter that honours a `version`: it stores the version with the
   * source's records and refuses an older one atomically against concurrent
   * writes of that source. The service refuses a versioned call to an adapter
   * without it, so an adapter written before versions cannot ignore one.
   */
  readonly versionedReplace?: boolean;
  /**
   * Receives up to 5,000 records for the WHOLE source. Write every slice
   * before deleting stale records; separate calls replace each other.
   *
   * @param spec - The declared collection
   * @param scope - The tenant scope
   * @param sourceId - The source
   * @param records - Validated records, each carrying `sourceId`
   * @param version - A validated version (a non-negative safe integer), only
   *   when the adapter sets `versionedReplace`; absent writes unconditionally
   *   and leaves the source unversioned
   * @returns Once both steps finish
   * @throws {VectorVersionConflictError} When the stored records carry a
   *   higher version
   */
  replaceSource(
    spec: VectorCollectionSpec,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
    version?: number,
  ): Promise<void>;
  /**
   * @param spec - The declared collection
   * @param scope - The tenant scope
   * @param query - A validated query
   * @returns Matches ordered by score descending, then id ascending
   */
  query(
    spec: VectorCollectionSpec,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]>;
  /**
   * @param spec - The declared collection
   * @param scope - The tenant scope
   * @param ids - Validated ids
   * @returns Once deleted
   */
  delete(spec: VectorCollectionSpec, scope: string, ids: readonly string[]): Promise<void>;
  /**
   * @param spec - The declared collection
   * @param scope - The tenant scope
   * @returns Once deleted
   */
  deleteScope(spec: VectorCollectionSpec, scope: string): Promise<void>;
  /**
   * Called once at application shutdown. Built-in adapters never close a
   * client the application injected; they call their `onClose` option.
   *
   * @returns Once closed
   */
  close?(): Promise<void>;
}
