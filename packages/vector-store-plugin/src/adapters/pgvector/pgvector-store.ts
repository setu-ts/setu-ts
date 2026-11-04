/**
 * The pgvector adapter: one table per collection in the application's own
 * PostgreSQL database, reached through the application's Drizzle instance.
 * `drizzle-orm` is loaded lazily (AI_GUIDELINES §12.2); the scope is in the
 * primary key and in every statement (plan §3.7).
 *
 * @module
 */
import {
  OptionalDependencyUnavailableError,
  VectorCollectionMismatchError,
  VectorOperationUnsupportedError,
  toBackendFault,
} from '@setu-ts/common';
import type {
  IVectorStoreAdapter,
  VectorCollectionSpec,
  VectorMatch,
  VectorMetadataValue,
  VectorQuery,
  VectorRecord,
} from '@setu-ts/common';
import {
  createExtensionStatement,
  createStatements,
  deleteIdsStatement,
  deleteScopeStatement,
  deleteStaleStatement,
  describeStatement,
  extensionVersionStatement,
  queryStatement,
  sourceLockStatement,
  querySettings,
  tableNames,
  upsertStatement,
} from './pgvector-sql.ts';
import type { SqlTag, Statement } from './pgvector-sql.ts';

/** HNSW indexes `vector` columns of at most this many dimensions. */
const MAX_INDEXED_DIMENSIONS = 2000;
/** `hnsw.iterative_scan` arrived in pgvector 0.8.0. */
const MIN_VERSION: readonly [number, number] = [0, 8];

/** A Drizzle database or transaction: anything that can execute a statement. */
export interface PgVectorExecutor {
  /** Executes a built statement. */
  execute(statement: unknown): Promise<unknown>;
}

/**
 * A Drizzle PostgreSQL database — `drizzle(pool)` from `drizzle-orm/node-postgres`
 * or `drizzle(client)` from `drizzle-orm/postgres-js`. Not the opaque handle
 * given to DatabasePlugin.
 */
export interface PgVectorDatabase extends PgVectorExecutor {
  /** Runs `work` in one transaction. */
  transaction<T>(work: (tx: PgVectorExecutor) => Promise<T>): Promise<T>;
}

/**
 * Options for {@linkcode PgVectorStore}.
 *
 * @since 0.12.0
 */
export interface PgVectorStoreOptions {
  /** The application's Drizzle PostgreSQL database. */
  readonly db: PgVectorDatabase;
  /**
   * `'create'` (default) creates the extension, tables and indexes when
   * missing; `'verify'` only checks them, for applications whose migrations
   * create them (replicas starting together can race on DDL).
   */
  readonly ensure?: 'create' | 'verify';
  /** Called once from `close()` at shutdown, e.g. to end a pool the app created for this store. */
  readonly onClose?: () => void | Promise<void>;
}

/** Loads `drizzle-orm`'s `sql` tag. A seam so tests can simulate an absent package. */
export type DrizzleLoader = () => Promise<SqlTag>;

async function loadDrizzleSql(): Promise<SqlTag> {
  let orm: typeof import('drizzle-orm');
  try {
    orm = await import('drizzle-orm');
  } catch (cause) {
    throw new OptionalDependencyUnavailableError('drizzle-orm', {
      requiredBy: '@setu-ts/vector-store-plugin',
      cause,
    });
  }
  return orm.sql as unknown as SqlTag;
}

/**
 * Stores vectors in PostgreSQL with the pgvector extension (0.8.0 or later),
 * through the application's Drizzle instance.
 *
 * @example
 * ```typescript
 * const pool = new Pool({ connectionString: env.DATABASE_URL });
 * VectorStorePlugin({
 *   adapter: new PgVectorStore({ db: drizzle(pool), onClose: () => pool.end() }),
 *   collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
 * });
 * ```
 * @since 0.12.0
 */
export class PgVectorStore implements IVectorStoreAdapter {
  /** @inheritdoc */
  readonly name = 'pgvector';
  readonly #db: PgVectorDatabase;
  readonly #ensure: 'create' | 'verify';
  readonly #onClose: (() => void | Promise<void>) | undefined;
  readonly #load: DrizzleLoader;
  #sql: SqlTag | undefined;

  /**
   * @param options - The database, ensure mode and shutdown callback
   * @param load - Internal seam: how `drizzle-orm` is loaded
   * @throws {TypeError} When `db` cannot execute statements and transactions
   */
  constructor(options: PgVectorStoreOptions, load: DrizzleLoader = loadDrizzleSql) {
    const db = (options as { db?: unknown } | undefined)?.db as Record<string, unknown> | undefined;
    if (
      db === null ||
      typeof db !== 'object' ||
      typeof db['execute'] !== 'function' ||
      typeof db['transaction'] !== 'function'
    ) {
      throw new TypeError(
        'PgVectorStore: db must be a Drizzle PostgreSQL database with execute() and transaction() (node-postgres or postgres-js).',
      );
    }
    const ensure = options.ensure ?? 'create';
    if (ensure !== 'create' && ensure !== 'verify') {
      throw new TypeError("PgVectorStore: ensure must be 'create' or 'verify'.");
    }
    this.#db = options.db;
    this.#ensure = ensure;
    this.#onClose = options.onClose;
    this.#load = load;
  }

  /** @inheritdoc */
  async open(): Promise<void> {
    this.#sql = await this.#load();
    const version = await this.#versionOf();
    if (version === undefined && this.#ensure === 'create') {
      await this.#run(() => this.#db.execute(createExtensionStatement(this.#tag())));
    }
    const installed = version ?? (await this.#versionOf());
    if (installed === undefined || !atLeast(installed, MIN_VERSION)) {
      throw new VectorOperationUnsupportedError(
        `pgvector: the vector extension ${installed === undefined ? 'is not installed' : `is ${installed}`}; 0.8.0 or later is required.`,
      );
    }
  }

  /** @inheritdoc */
  async ensureCollection(spec: VectorCollectionSpec): Promise<void> {
    if (spec.dimensions > MAX_INDEXED_DIMENSIONS) {
      throw new VectorOperationUnsupportedError(
        `pgvector: collection '${spec.name}' has ${spec.dimensions} dimensions; HNSW indexes at most ${MAX_INDEXED_DIMENSIONS}.`,
      );
    }
    const sql = this.#tag();
    if (this.#ensure === 'create') {
      for (const statement of createStatements(sql, spec)) {
        await this.#run(() => this.#db.execute(statement));
      }
    }
    const [row] = await this.#rows<{
      dimensions: number;
      source_index: boolean;
      vector_index: boolean;
    }>(this.#db, describeStatement(sql, spec));
    const { table } = tableNames(spec);
    if (row === undefined) {
      throw new VectorCollectionMismatchError(
        `pgvector: table '${table}' does not exist; create it in a migration or use ensure: 'create'.`,
      );
    }
    if (Number(row.dimensions) !== spec.dimensions) {
      throw new VectorCollectionMismatchError(
        `pgvector: '${table}' stores ${row.dimensions}-dimension vectors; collection '${spec.name}' declares ${spec.dimensions}.`,
      );
    }
    if (!row.source_index || !row.vector_index) {
      throw new VectorCollectionMismatchError(
        `pgvector: '${table}' is missing its ${!row.vector_index ? 'HNSW' : 'source'} index.`,
      );
    }
  }

  /** @inheritdoc */
  async upsert(
    spec: VectorCollectionSpec,
    scope: string,
    records: readonly VectorRecord[],
  ): Promise<void> {
    await this.#run(() => this.#db.execute(upsertStatement(this.#tag(), spec, scope, records)));
  }

  /** @inheritdoc */
  async replaceSource(
    spec: VectorCollectionSpec,
    scope: string,
    sourceId: string,
    records: readonly VectorRecord[],
  ): Promise<void> {
    const sql = this.#tag();
    await this.#run(() =>
      this.#db.transaction(async (tx) => {
        await tx.execute(sourceLockStatement(sql, spec, scope, sourceId));
        if (records.length > 0) await tx.execute(upsertStatement(sql, spec, scope, records));
        await tx.execute(
          deleteStaleStatement(
            sql,
            spec,
            scope,
            sourceId,
            records.map((record) => record.id),
          ),
        );
      }),
    );
  }

  /** @inheritdoc */
  async query(
    spec: VectorCollectionSpec,
    scope: string,
    query: VectorQuery,
  ): Promise<readonly VectorMatch[]> {
    const sql = this.#tag();
    const rows = await this.#run(() =>
      this.#db.transaction(async (tx) => {
        for (const setting of querySettings(sql, query.topK)) await tx.execute(setting);
        return await this.#rows<{
          id: string;
          source_id: string | null;
          content: string | null;
          metadata: Record<string, VectorMetadataValue> | string | null;
          score: number | string;
        }>(tx, queryStatement(sql, spec, scope, query));
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      score: Number(row.score),
      ...(row.source_id === null ? {} : { sourceId: row.source_id }),
      ...(row.content === null ? {} : { content: row.content }),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    }));
  }

  /** @inheritdoc */
  async delete(spec: VectorCollectionSpec, scope: string, ids: readonly string[]): Promise<void> {
    await this.#run(() => this.#db.execute(deleteIdsStatement(this.#tag(), spec, scope, ids)));
  }

  /** @inheritdoc */
  async deleteScope(spec: VectorCollectionSpec, scope: string): Promise<void> {
    await this.#run(() => this.#db.execute(deleteScopeStatement(this.#tag(), spec, scope)));
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    await this.#onClose?.();
  }

  async #versionOf(): Promise<string | undefined> {
    const [row] = await this.#rows<{ extversion: string }>(
      this.#db,
      extensionVersionStatement(this.#tag()),
    );
    return row?.extversion;
  }

  async #rows<T>(executor: PgVectorExecutor, statement: Statement): Promise<T[]> {
    const result = await this.#run(() => executor.execute(statement));
    // node-postgres answers `{ rows }`; postgres-js answers the row array.
    return ((result as { rows?: T[] }).rows ?? result) as T[];
  }

  /** Runs a driver call, turning a connection failure into a 503/504 backend fault. */
  async #run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toBackendFault(error, 'vector-store-plugin: pgvector') ?? error;
    }
  }

  #tag(): SqlTag {
    if (this.#sql === undefined) {
      throw new Error('PgVectorStore: open() must run before any other call.');
    }
    return this.#sql;
  }
}

function atLeast(version: string, [major, minor]: readonly [number, number]): boolean {
  const [a, b] = version.split('.').map((part) => Number.parseInt(part, 10));
  return a !== undefined && b !== undefined && (a > major || (a === major && b >= minor));
}
