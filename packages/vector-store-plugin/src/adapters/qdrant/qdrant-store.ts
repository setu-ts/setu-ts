/**
 * The Qdrant adapter over the application's own client. The plugin never
 * imports `@qdrant/js-client-rest`: the client is typed by a structural facade
 * and validated when the adapter is created (plan §3.8).
 *
 * @module
 */
import {
  VectorCollectionMismatchError,
  VectorOperationUnsupportedError,
  VectorVersionConflictError,
  toBackendFault,
  vectorRecordKey,
} from '@setu-ts/common';
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
  VERSION_KEY,
  scopeCondition,
  scopedFilter,
} from './qdrant-filter.ts';
import { MAX_RECORDS_PER_CALL } from '../../services/limits.ts';

const CLIENT_METHODS = [
  'collectionExists',
  'getCollection',
  'createCollection',
  'createPayloadIndex',
  'upsert',
  'query',
  'delete',
  'count',
  'versionInfo',
] as const;

/** The first Qdrant release whose upsert takes `update_filter` (conditional update). */
const MIN_VERSIONED: readonly [number, number] = [1, 16];

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
  /** `POST /collections/{name}/points/count`. */
  count(
    name: string,
    body: Record<string, unknown>,
  ): Promise<{
    /** Points matching the filter. */
    count: number;
  }>;
  /** `GET /`: the server's version, checked before the first versioned write. */
  versionInfo(): Promise<{
    /** The server version, e.g. `1.20.0`. */
    version: string;
  }>;
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
 *   adapter: new QdrantVectorStore({
 *     client: new QdrantClient({ url: env.QDRANT_URL, timeout: 15_000 }),
 *   }),
 *   collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
 * });
 * ```
 * @since 0.12.0
 */
export class QdrantVectorStore implements IVectorStoreAdapter {
  /** @inheritdoc */
  readonly name = 'qdrant';
  /** @inheritdoc */
  readonly versionedReplace = true;
  readonly #client: QdrantClientLike;
  /** Settles once the server is known to take `update_filter`; reset after a failed probe. */
  #versionChecked: Promise<void> | undefined;
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
      [VERSION_KEY, 'integer'],
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
   * Qdrant has no transactions: the write slices precede the stale-delete,
   * so two replacements of the SAME source must not run at once (one could
   * delete the other's records). Serialise them per source, e.g. one queue job
   * per document at a time, or pass a `version`.
   *
   * With a `version` (Qdrant 1.16+), the upsert's `update_filter` keeps any
   * point a newer version wrote, a count afterwards finds a newer version that
   * landed first, and the stale-delete never touches a newer point. Concurrent
   * writes of one source then settle on the highest version's records, though
   * a reader can briefly see both versions' chunks.
   */
  async replaceSource(
    spec: VectorCollectionSpec,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
    version?: number,
  ): Promise<void> {
    const name = collectionName(spec);
    const source = [scopeCondition(scope), { key: SOURCE_KEY, match: { value: sourceId } }];
    const kept = await Promise.all(records.map((record) => this.#pointId(scope, record.id)));
    if (version === undefined) {
      for (let start = 0; start < records.length; start += MAX_RECORDS_PER_CALL)
        await this.upsert(spec, scope, records.slice(start, start + MAX_RECORDS_PER_CALL));
      await this.#deleteSource(name, { must: source, ...notKept(kept) });
      return;
    }
    await this.#requireConditionalUpdate();
    // A stored point of this source at a newer version keeps its state; new ids
    // are inserted, and a point of another source is reassigned as usual.
    const newer = { key: VERSION_KEY, range: { gt: version } };
    const newerOfSource = { must: [source[1], newer] };
    for (let start = 0; start < records.length; start += MAX_RECORDS_PER_CALL) {
      const points = await Promise.all(
        records
          .slice(start, start + MAX_RECORDS_PER_CALL)
          .map((record) => this.#point(scope, record, version)),
      );
      await this.#run(() =>
        this.#client.upsert(name, {
          wait: true,
          points,
          update_filter: { must_not: [newerOfSource] },
        }),
      );
    }
    // Without transactions, a newer write may already have landed. Then every
    // point at or below this version, including ids this call just inserted,
    // is stale: remove them and report the conflict.
    const { count } = await this.#run(() =>
      this.#client.count(name, { exact: true, filter: { must: [...source, newer] } }),
    );
    if (count > 0) {
      await this.#deleteSource(name, { must: source, must_not: [newer] });
      throw new VectorVersionConflictError(
        `qdrant: replaceSource version ${version} is older than a stored version`,
      );
    }
    // Never delete a newer write that lands after the check.
    await this.#deleteSource(name, {
      must: source,
      must_not: [newer, ...(kept.length === 0 ? [] : [{ has_id: kept }])],
    });
  }

  /** @inheritdoc */
  async query(
    spec: VectorCollectionSpec,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]> {
    const response = (await this.#run(() =>
      this.#client.query(collectionName(spec), {
        query: unitVector(query.vector),
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

  async #deleteSource(name: string, filter: Record<string, unknown>): Promise<void> {
    await this.#run(() => this.#client.delete(name, { wait: true, filter }));
  }

  /**
   * Refuses a versioned write on a server older than 1.16, which predates
   * `update_filter`: whether it would reject the field or ignore it is not
   * documented, and ignoring it would let an older write replace a newer one.
   */
  #requireConditionalUpdate(): Promise<void> {
    this.#versionChecked ??= this.#run(() => this.#client.versionInfo()).then(
      ({ version }) => {
        if (!atLeast(version, MIN_VERSIONED)) {
          throw new VectorOperationUnsupportedError(
            `qdrant: a versioned replaceSource needs Qdrant ${MIN_VERSIONED.join('.')} or later; the server is ${version}.`,
          );
        }
      },
      (error: unknown) => {
        // A failed probe is retried on the next call rather than remembered.
        this.#versionChecked = undefined;
        throw error;
      },
    );
    return this.#versionChecked;
  }

  async #point(
    scope: string,
    record: VectorRecord,
    version?: number,
  ): Promise<Record<string, unknown>> {
    return {
      id: await this.#pointId(scope, record.id),
      vector: unitVector(record.vector),
      payload: {
        [SCOPE_KEY]: scope,
        [ID_KEY]: record.id,
        ...(record.sourceId === undefined ? {} : { [SOURCE_KEY]: record.sourceId }),
        ...(record.content === undefined ? {} : { [CONTENT_KEY]: record.content }),
        [METADATA_KEY]: { ...record.metadata },
        ...(version === undefined ? {} : { [VERSION_KEY]: version }),
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

function notKept(kept: readonly string[]): { must_not?: unknown[] } {
  return kept.length === 0 ? {} : { must_not: [{ has_id: kept }] };
}

function atLeast(version: string, [major, minor]: readonly [number, number]): boolean {
  const [a, b] = version.split('.').map((part) => Number.parseInt(part, 10));
  return a !== undefined && b !== undefined && (a > major || (a === major && b >= minor));
}

function collectionName(spec: VectorCollectionSpec): string {
  return `vs_${spec.name}`;
}

/**
 * Scales a vector to unit length. Qdrant normalises cosine vectors itself, but
 * skips one whose float32 squared norm is below `f32::EPSILON` (a norm below
 * about 3.45e-4), whose scores then come back scaled by its length (M135 audit
 * R1). Cosine similarity ignores length, so normalising first changes no score.
 * The service has already refused zero and non-finite norms.
 *
 * @param vector - A validated vector
 * @returns The same direction at length 1
 */
function unitVector(vector: readonly number[]): number[] {
  const norm = Math.hypot(...vector);
  return vector.map((component) => component / norm);
}
