/**
 * The zero-dependency default adapter: exact brute-force cosine search over
 * an in-process map keyed by collection, then scope. It is the oracle the
 * conformance table compares every other adapter against.
 *
 * @module
 */
import { VectorVersionConflictError } from '@setu-ts/common';
import type {
  IVectorStoreAdapter,
  VectorCollectionSpec,
  VectorFilter,
  VectorMatch,
  VectorMetadataValue,
  VectorQuery,
  VectorRecord,
} from '@setu-ts/common';

interface StoredRecord {
  readonly id: string;
  readonly vector: readonly number[];
  readonly norm: number;
  readonly sourceId?: string;
  readonly content?: string;
  readonly metadata: Readonly<Record<string, VectorMetadataValue>>;
  /** The `replaceSource` version this record was written under. */
  readonly version?: number;
}

/** Options for {@linkcode MemoryVectorStore}. */
export interface MemoryVectorStoreOptions {
  /** Called once from `close()` at application shutdown. */
  readonly onClose?: () => void | Promise<void>;
}

/**
 * In-process vector store for development, tests and small corpora. Records
 * live only as long as the process.
 *
 * @example
 * ```typescript
 * VectorStorePlugin({
 *   adapter: new MemoryVectorStore(),
 *   collections: [{ name: 'documents', dimensions: 1024 }],
 * });
 * ```
 * @since 0.12.0
 */
export class MemoryVectorStore implements IVectorStoreAdapter {
  /** @inheritdoc */
  readonly name = 'memory';
  /** @inheritdoc */
  readonly versionedReplace = true;
  readonly #collections = new Map<string, Map<string, Map<string, StoredRecord>>>();
  readonly #onClose: (() => void | Promise<void>) | undefined;

  /** @param options - Optional shutdown callback */
  constructor(options: MemoryVectorStoreOptions = {}) {
    this.#onClose = options.onClose;
  }

  /** @inheritdoc */
  open(): Promise<void> {
    return Promise.resolve();
  }

  /** @inheritdoc */
  ensureCollection(spec: VectorCollectionSpec): Promise<void> {
    if (!this.#collections.has(spec.name)) this.#collections.set(spec.name, new Map());
    return Promise.resolve();
  }

  /** @inheritdoc */
  upsert(
    spec: VectorCollectionSpec,
    scope: string,
    records: readonly VectorRecord[],
  ): Promise<void> {
    const rows = this.#scope(spec, scope, true)!;
    for (const record of records) rows.set(record.id, stored(record));
    return Promise.resolve();
  }

  /** @inheritdoc */
  replaceSource(
    spec: VectorCollectionSpec,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
    version?: number,
  ): Promise<void> {
    const rows = this.#scope(spec, scope, true)!;
    if (version !== undefined) {
      for (const row of rows.values()) {
        if (row.sourceId === sourceId && row.version !== undefined && row.version > version) {
          return Promise.reject(
            new VectorVersionConflictError(
              `memory: replaceSource version ${version} is older than the stored version ${row.version}`,
            ),
          );
        }
      }
    }
    const kept = new Set<string>();
    for (const record of records) {
      rows.set(record.id, stored(record, version));
      kept.add(record.id);
    }
    for (const [id, row] of rows) {
      if (row.sourceId === sourceId && !kept.has(id)) rows.delete(id);
    }
    return Promise.resolve();
  }

  /** @inheritdoc */
  query(
    spec: VectorCollectionSpec,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]> {
    const rows = this.#scope(spec, scope, false);
    if (rows === undefined) return Promise.resolve([]);
    const queryNorm = Math.hypot(...query.vector);
    const matches: VectorMatch[] = [];
    for (const row of rows.values()) {
      if (query.filter !== undefined && !matchesFilter(row.metadata, query.filter)) continue;
      const score = dot(row.vector, query.vector) / (row.norm * queryNorm);
      if (query.minScore !== undefined && score < query.minScore) continue;
      matches.push({
        id: row.id,
        score,
        ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
        ...(row.content === undefined ? {} : { content: row.content }),
        metadata: { ...row.metadata },
      });
    }
    // Score descending, then id ascending: ties have one defined order.
    matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return Promise.resolve(matches.slice(0, query.topK));
  }

  /** @inheritdoc */
  delete(spec: VectorCollectionSpec, scope: string, ids: readonly string[]): Promise<void> {
    const rows = this.#scope(spec, scope, false);
    for (const id of ids) rows?.delete(id);
    return Promise.resolve();
  }

  /** @inheritdoc */
  deleteScope(spec: VectorCollectionSpec, scope: string): Promise<void> {
    this.#collections.get(spec.name)?.delete(scope);
    return Promise.resolve();
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    await this.#onClose?.();
  }

  #scope(
    spec: VectorCollectionSpec,
    scope: string,
    create: boolean,
  ): Map<string, StoredRecord> | undefined {
    let collection = this.#collections.get(spec.name);
    if (collection === undefined) {
      collection = new Map();
      this.#collections.set(spec.name, collection);
    }
    let rows = collection.get(scope);
    if (rows === undefined && create) {
      rows = new Map();
      collection.set(scope, rows);
    }
    return rows;
  }
}

function stored(record: VectorRecord, version?: number): StoredRecord {
  return {
    id: record.id,
    vector: [...record.vector],
    norm: Math.hypot(...record.vector),
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.content === undefined ? {} : { content: record.content }),
    metadata: { ...record.metadata },
    ...(version === undefined ? {} : { version }),
  };
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Evaluates a validated filter. A record without the field never matches a
 * comparison on it.
 *
 * @param metadata - The record's metadata
 * @param filter - A filter the service validated
 * @returns Whether the record matches
 */
function matchesFilter(
  metadata: Readonly<Record<string, VectorMetadataValue>>,
  filter: VectorFilter,
): boolean {
  if ('and' in filter) return filter.and.every((child) => matchesFilter(metadata, child));
  if (!Object.hasOwn(metadata, filter.field)) return false;
  const value = metadata[filter.field]!;
  switch (filter.op) {
    case 'eq':
      return value === filter.value;
    case 'in':
      return (filter.value as readonly VectorMetadataValue[]).includes(value);
    case 'gt':
      return typeof value === 'number' && value > filter.value;
    case 'gte':
      return typeof value === 'number' && value >= filter.value;
    case 'lt':
      return typeof value === 'number' && value < filter.value;
    case 'lte':
      return typeof value === 'number' && value <= filter.value;
  }
}
