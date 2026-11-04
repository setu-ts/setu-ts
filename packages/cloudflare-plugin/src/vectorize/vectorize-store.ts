/**
 * The Cloudflare Vectorize adapter for `@setu-ts/vector-store-plugin`, built
 * from the application's own `Vectorize` binding (the current API, not the
 * deprecated beta `VectorizeIndex`).
 *
 * The scope is the namespace. Vector ids are global to an index, so the stored
 * id is the tenant-separated `vectorRecordKey(scope, id)` and the caller's id
 * travels in metadata: two tenants writing the same id never overwrite each
 * other. Vectorize cannot delete by namespace or by filter, so `replaceSource`
 * and `deleteScope` are refused by name rather than emulated.
 *
 * @module
 */
import {
  VectorCollectionMismatchError,
  VectorFilterError,
  VectorOperationUnsupportedError,
  vectorRecordKey,
} from '@setu-ts/common';
import type {
  IRuntimeServices,
  IVectorStoreAdapter,
  VectorCollectionSpec,
  VectorFilter,
  VectorMatch,
  VectorMetadataValue,
  VectorQuery,
  VectorRecord,
} from '@setu-ts/common';

/** Vectorize indexes at most this many dimensions. */
const MAX_DIMENSIONS = 1536;
/** Vectorize refuses a filter whose compact JSON is 2048 bytes or more. */
const MAX_FILTER_BYTES = 2047;
/** Metadata keys the adapter owns; declared fields start with a letter, so they never collide. */
const ID_KEY = '_id';
const SOURCE_KEY = '_source';
const CONTENT_KEY = '_content';
const OPERATORS = { eq: '$eq', in: '$in', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' } as const;

/** One vector as Vectorize takes and returns it. */
export interface VectorizeVectorLike {
  readonly id: string;
  readonly values: readonly number[];
  readonly namespace?: string;
  readonly metadata?: Readonly<Record<string, VectorMetadataValue>>;
}

/**
 * The parts of a current `Vectorize` binding this adapter calls.
 *
 * @since 0.12.0
 */
export interface VectorizeIndexLike {
  /** Index information; the current API reports dimensions but not the metric. */
  describe(): Promise<{ readonly dimensions: number }>;
  /** Similarity query. */
  query(
    vector: readonly number[],
    options: {
      readonly topK: number;
      readonly namespace: string;
      readonly returnMetadata: 'all';
      readonly returnValues: false;
      readonly filter?: Readonly<Record<string, unknown>>;
    },
  ): Promise<{
    readonly matches: readonly {
      readonly id: string;
      readonly score: number;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[];
  }>;
  /** Inserts or replaces vectors; applied asynchronously. */
  upsert(vectors: VectorizeVectorLike[]): Promise<unknown>;
  /** Deletes vectors by id; applied asynchronously. */
  deleteByIds(ids: string[]): Promise<unknown>;
}

/**
 * Options for {@linkcode VectorizeVectorStore}.
 *
 * @since 0.12.0
 */
export interface VectorizeVectorStoreOptions {
  /** The Vectorize binding, e.g. `env.DOCUMENTS_INDEX`. */
  readonly index: VectorizeIndexLike;
  /** Called once from `close()` at shutdown. */
  readonly onClose?: () => void | Promise<void>;
}

/**
 * Stores vectors in a Cloudflare Vectorize index: one index per collection,
 * one namespace per scope. Create the index with `--metric cosine` and a
 * metadata index for every declared filterable field before the first write.
 * Writes are applied asynchronously, so a query may not see one yet.
 *
 * @example
 * ```typescript
 * VectorStorePlugin({
 *   adapter: new VectorizeVectorStore({ index: env.DOCUMENTS_INDEX }),
 *   collections: [{ name: 'documents', dimensions: 768, filterable: { tag: 'string' } }],
 * });
 * ```
 * @since 0.12.0
 */
export class VectorizeVectorStore implements IVectorStoreAdapter {
  /** @inheritdoc */
  readonly name = 'vectorize';
  readonly #index: VectorizeIndexLike;
  readonly #onClose: (() => void | Promise<void>) | undefined;
  #subtle: SubtleCrypto | undefined;

  /**
   * @param options - The binding and shutdown callback
   * @throws {TypeError} When the binding lacks a method the adapter calls
   */
  constructor(options: VectorizeVectorStoreOptions) {
    const index = (options as { index?: unknown } | undefined)?.index as
      Record<string, unknown> | undefined;
    const missing =
      index === null || typeof index !== 'object'
        ? ['index']
        : ['describe', 'query', 'upsert', 'deleteByIds'].filter(
            (method) => typeof index[method] !== 'function',
          );
    if (missing.length > 0) {
      throw new TypeError(
        `VectorizeVectorStore: index must be a Vectorize binding (missing ${missing.join(', ')}).`,
      );
    }
    this.#index = options.index;
    this.#onClose = options.onClose;
  }

  /** @inheritdoc */
  open(runtime: IRuntimeServices): Promise<void> {
    this.#subtle = runtime.subtle;
    return Promise.resolve();
  }

  /** @inheritdoc */
  async ensureCollection(spec: VectorCollectionSpec): Promise<void> {
    if (spec.dimensions > MAX_DIMENSIONS) {
      throw new VectorOperationUnsupportedError(
        `vectorize: collection '${spec.name}' has ${spec.dimensions} dimensions; Vectorize indexes at most ${MAX_DIMENSIONS}.`,
      );
    }
    const { dimensions } = await this.#index.describe();
    if (dimensions !== spec.dimensions) {
      throw new VectorCollectionMismatchError(
        `vectorize: the index for '${spec.name}' has ${dimensions} dimensions; declared ${spec.dimensions}.`,
      );
    }
  }

  /** @inheritdoc */
  async upsert(
    _spec: VectorCollectionSpec,
    scope: string,
    records: readonly VectorRecord[],
  ): Promise<void> {
    const vectors = await Promise.all(
      records.map(async (record) => ({
        id: await this.#key(scope, record.id),
        values: [...record.vector],
        namespace: scope,
        metadata: {
          ...record.metadata,
          [ID_KEY]: record.id,
          ...(record.sourceId === undefined ? {} : { [SOURCE_KEY]: record.sourceId }),
          ...(record.content === undefined ? {} : { [CONTENT_KEY]: record.content }),
        },
      })),
    );
    await this.#index.upsert(vectors);
  }

  /** @inheritdoc */
  replaceSource(): Promise<void> {
    return Promise.reject(
      new VectorOperationUnsupportedError(
        'vectorize: replaceSource needs delete-by-filter, which Vectorize does not offer; upsert deterministic ids and delete stale ids instead.',
      ),
    );
  }

  /** @inheritdoc */
  async query(
    _spec: VectorCollectionSpec,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]> {
    const filter = query.filter === undefined ? undefined : translateFilter(query.filter);
    const { matches } = await this.#index.query([...query.vector], {
      topK: query.topK,
      namespace: scope,
      returnMetadata: 'all',
      returnValues: false,
      ...(filter === undefined ? {} : { filter }),
    });
    const results: VectorMatch[] = [];
    for (const match of matches) {
      if (query.minScore !== undefined && match.score < query.minScore) continue;
      const {
        [ID_KEY]: id,
        [SOURCE_KEY]: source,
        [CONTENT_KEY]: content,
        ...metadata
      } = match.metadata ?? {};
      results.push({
        id: typeof id === 'string' ? id : match.id,
        score: match.score,
        ...(typeof source === 'string' ? { sourceId: source } : {}),
        ...(typeof content === 'string' ? { content } : {}),
        metadata: metadata as Record<string, VectorMetadataValue>,
      });
    }
    return results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** @inheritdoc */
  async delete(_spec: VectorCollectionSpec, scope: string, ids: readonly string[]): Promise<void> {
    await this.#index.deleteByIds(await Promise.all(ids.map((id) => this.#key(scope, id))));
  }

  /** @inheritdoc */
  deleteScope(): Promise<void> {
    return Promise.reject(
      new VectorOperationUnsupportedError(
        'vectorize: deleteScope needs delete-by-namespace, which Vectorize does not offer; delete the ids you stored, or use one index per tenant group.',
      ),
    );
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    await this.#onClose?.();
  }

  async #key(scope: string, id: string): Promise<string> {
    if (this.#subtle === undefined) {
      throw new Error('VectorizeVectorStore: open() must run before any other call.');
    }
    return await vectorRecordKey(this.#subtle, scope, id);
  }
}

/**
 * Translates a validated filter to Vectorize's object form, an implicit AND
 * of per-field operator objects. Two clauses with the same operator on one
 * field cannot be expressed and are refused, as is a filter over 2 KB.
 *
 * @param filter - A filter the service validated
 * @returns The Vectorize filter
 * @throws {VectorFilterError} When the filter cannot be expressed exactly
 */
export function translateFilter(filter: VectorFilter): Record<string, Record<string, unknown>> {
  const fields: Record<string, Record<string, unknown>> = {};
  const visit = (node: VectorFilter): void => {
    if ('and' in node) {
      for (const child of node.and) visit(child);
      return;
    }
    const operator = OPERATORS[node.op];
    if (operator === undefined) {
      throw new VectorFilterError(`vectorize: unsupported filter operator '${String(node.op)}'`);
    }
    const field = (fields[node.field] ??= {});
    if (Object.hasOwn(field, operator)) {
      throw new VectorFilterError(
        `vectorize: filter field '${node.field}' uses '${node.op}' twice; Vectorize cannot express that`,
      );
    }
    field[operator] = Array.isArray(node.value) ? [...node.value] : node.value;
  };
  visit(filter);
  if (new TextEncoder().encode(JSON.stringify(fields)).length > MAX_FILTER_BYTES) {
    throw new VectorFilterError('vectorize: the filter is 2 KB or more as JSON');
  }
  return fields;
}
