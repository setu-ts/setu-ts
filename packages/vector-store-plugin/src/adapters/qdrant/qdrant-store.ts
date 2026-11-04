/**
 * The Qdrant adapter over the application's own client. The plugin never
 * imports `@qdrant/js-client-rest`: the client is typed by a structural facade
 * and validated when the adapter is created (plan §3.8).
 *
 * @module
 */
import { VectorCollectionMismatchError, toBackendFault, vectorRecordKey } from '@setu-ts/common';
import type {
  IRuntimeServices,
  IVectorStoreAdapter,
  VectorCollectionSpec,
  VectorMatch,
  VectorMetadataValue,
  VectorQuery,
  VectorRecord,
} from '@setu-ts/common';
import {
  CONTENT_KEY,
  ID_KEY,
  METADATA_KEY,
  SCOPE_KEY,
  SOURCE_KEY,
  scopeCondition,
  scopedFilter,
} from './qdrant-filter.ts';

const CLIENT_METHODS = [
  'collectionExists',
  'getCollection',
  'createCollection',
  'createPayloadIndex',
  'upsert',
  'query',
  'delete',
] as const;

/**
 * The parts of `QdrantClient` (`@qdrant/js-client-rest`) this adapter calls.
 *
 * @since 0.12.0
 */
export interface QdrantClientLike {
  /** `GET /collections/{name}/exists`. */
  collectionExists(name: string): Promise<{
    /** Whether the collection is present. */
    exists: boolean;
  }>;
  /** `GET /collections/{name}`. */
  getCollection(name: string): Promise<unknown>;
  /** `PUT /collections/{name}`. */
  createCollection(name: string, body: Record<string, unknown>): Promise<unknown>;
  /** `PUT /collections/{name}/index`. */
  createPayloadIndex(name: string, body: Record<string, unknown>): Promise<unknown>;
  /** `PUT /collections/{name}/points`. */
  upsert(name: string, body: Record<string, unknown>): Promise<unknown>;
  /** `POST /collections/{name}/points/query`. */
  query(name: string, body: Record<string, unknown>): Promise<unknown>;
  /** `POST /collections/{name}/points/delete`. */
  delete(name: string, body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Options for {@linkcode QdrantVectorStore}.
 *
 * @since 0.12.0
 */
export interface QdrantVectorStoreOptions {
  /** The application's client, e.g. `new QdrantClient({ url })`. Never closed by the adapter. */
  readonly client: QdrantClientLike;
  /** Called once from `close()` at shutdown. */
  readonly onClose?: () => void | Promise<void>;
}

interface QdrantPoint {
  readonly id?: string | number;
  readonly score?: number;
  readonly payload?: Record<string, unknown> | null;
}

/**
 * Stores vectors in Qdrant: one collection per declared collection, the scope
 * as an `is_tenant` keyword payload index, and point ids derived from
 * `(scope, id)` so tenants writing the same id never meet.
 *
 * @example
 * ```typescript
 * VectorStorePlugin({
 *   adapter: new QdrantVectorStore({ client: new QdrantClient({ url: env.QDRANT_URL }) }),
 *   collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
 * });
 * ```
 * @since 0.12.0
 */
export class QdrantVectorStore implements IVectorStoreAdapter {
  /** @inheritdoc */
  readonly name = 'qdrant';
  readonly #client: QdrantClientLike;
  readonly #onClose: (() => void | Promise<void>) | undefined;
  #subtle: SubtleCrypto | undefined;

  /**
   * @param options - The client and shutdown callback
   * @throws {TypeError} When the client lacks a method the adapter calls
   */
  constructor(options: QdrantVectorStoreOptions) {
    const client = (options as { client?: unknown } | undefined)?.client as
      Record<string, unknown> | undefined;
    const missing =
      client === null || typeof client !== 'object'
        ? ['client']
        : CLIENT_METHODS.filter((method) => typeof client[method] !== 'function');
    if (missing.length > 0) {
      throw new TypeError(
        `QdrantVectorStore: client must be a QdrantClient (missing ${missing.join(', ')}).`,
      );
    }
    this.#client = options.client;
    this.#onClose = options.onClose;
  }

  /** @inheritdoc */
  open(runtime: IRuntimeServices): Promise<void> {
    this.#subtle = runtime.subtle;
    return Promise.resolve();
  }

  /** @inheritdoc */
  async ensureCollection(spec: VectorCollectionSpec): Promise<void> {
    const name = collectionName(spec);
    const { exists } = await this.#run(() => this.#client.collectionExists(name));
    if (!exists) {
      await this.#run(() =>
        this.#client.createCollection(name, {
          vectors: { size: spec.dimensions, distance: 'Cosine' },
        }),
      );
    } else {
      const vectors = (
        (await this.#run(() => this.#client.getCollection(name))) as {
          config?: { params?: { vectors?: { size?: unknown; distance?: unknown } } };
        }
      ).config?.params?.vectors;
      if (vectors?.size !== spec.dimensions || vectors?.distance !== 'Cosine') {
        throw new VectorCollectionMismatchError(
          `qdrant: collection '${name}' has vectors ${JSON.stringify(vectors ?? null)}; declared ${spec.dimensions} dimensions, Cosine.`,
        );
      }
    }
    // Idempotent: creating an index that exists is accepted by Qdrant.
    const indexes: [string, Record<string, unknown> | string][] = [
      [SCOPE_KEY, { type: 'keyword', is_tenant: true }],
      [SOURCE_KEY, 'keyword'],
      ...Object.entries(spec.filterable ?? {}).map(([field, type]): [string, string] => [
        `${METADATA_KEY}.${field}`,
        type === 'string' ? 'keyword' : type === 'number' ? 'float' : 'bool',
      ]),
    ];
    for (const [field, schema] of indexes) {
      await this.#run(() =>
        this.#client.createPayloadIndex(name, {
          field_name: field,
          field_schema: schema,
          wait: true,
        }),
      );
    }
  }

  /** @inheritdoc */
  async upsert(
    spec: VectorCollectionSpec,
    scope: string,
    records: readonly VectorRecord[],
  ): Promise<void> {
    const points = await Promise.all(records.map((record) => this.#point(scope, record)));
    await this.#run(() => this.#client.upsert(collectionName(spec), { wait: true, points }));
  }

  /**
   * @inheritdoc
   *
   * Qdrant has no transactions: the write and the stale-delete are two calls,
   * so two replacements of the SAME source must not run at once (one could
   * delete the other's records). Serialise them per source, e.g. one queue job
   * per document at a time.
   */
  async replaceSource(
    spec: VectorCollectionSpec,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
  ): Promise<void> {
    if (records.length > 0) await this.upsert(spec, scope, records);
    const kept = await Promise.all(records.map((record) => this.#pointId(scope, record.id)));
    await this.#run(() =>
      this.#client.delete(collectionName(spec), {
        wait: true,
        filter: {
          must: [scopeCondition(scope), { key: SOURCE_KEY, match: { value: sourceId } }],
          ...(kept.length === 0 ? {} : { must_not: [{ has_id: kept }] }),
        },
      }),
    );
  }

  /** @inheritdoc */
  async query(
    spec: VectorCollectionSpec,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]> {
    const response = (await this.#run(() =>
      this.#client.query(collectionName(spec), {
        query: [...query.vector],
        filter: scopedFilter(scope, query.filter),
        limit: query.topK,
        with_payload: true,
        ...(query.minScore === undefined ? {} : { score_threshold: query.minScore }),
      }),
    )) as { points?: readonly QdrantPoint[] };
    const matches = (response.points ?? []).map((point): VectorMatch => {
      const payload = point.payload ?? {};
      const source = payload[SOURCE_KEY];
      const content = payload[CONTENT_KEY];
      return {
        id: typeof payload[ID_KEY] === 'string' ? payload[ID_KEY] : String(point.id),
        score: Number(point.score),
        ...(typeof source === 'string' ? { sourceId: source } : {}),
        ...(typeof content === 'string' ? { content } : {}),
        metadata: (payload[METADATA_KEY] ?? {}) as Record<string, VectorMetadataValue>,
      };
    });
    // Qdrant orders by score; ties get the portable id order.
    return matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** @inheritdoc */
  async delete(spec: VectorCollectionSpec, scope: string, ids: readonly string[]): Promise<void> {
    const pointIds = await Promise.all(ids.map((id) => this.#pointId(scope, id)));
    // A points selector cannot carry the scope, so ids go through a scoped filter.
    await this.#run(() =>
      this.#client.delete(collectionName(spec), {
        wait: true,
        filter: { must: [scopeCondition(scope), { has_id: pointIds }] },
      }),
    );
  }

  /** @inheritdoc */
  async deleteScope(spec: VectorCollectionSpec, scope: string): Promise<void> {
    await this.#run(() =>
      this.#client.delete(collectionName(spec), { wait: true, filter: scopedFilter(scope) }),
    );
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    await this.#onClose?.();
  }

  async #point(scope: string, record: VectorRecord): Promise<Record<string, unknown>> {
    return {
      id: await this.#pointId(scope, record.id),
      vector: [...record.vector],
      payload: {
        [SCOPE_KEY]: scope,
        [ID_KEY]: record.id,
        ...(record.sourceId === undefined ? {} : { [SOURCE_KEY]: record.sourceId }),
        ...(record.content === undefined ? {} : { [CONTENT_KEY]: record.content }),
        [METADATA_KEY]: { ...record.metadata },
      },
    };
  }

  /** A UUID from the first 128 bits of the tenant-separated record key. */
  async #pointId(scope: string, id: string): Promise<string> {
    if (this.#subtle === undefined) {
      throw new Error('QdrantVectorStore: open() must run before any other call.');
    }
    const hex = await vectorRecordKey(this.#subtle, scope, id);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  async #run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toBackendFault(error, 'vector-store-plugin: qdrant') ?? error;
    }
  }
}

function collectionName(spec: VectorCollectionSpec): string {
  return `vs_${spec.name}`;
}
