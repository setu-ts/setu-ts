/**
 * SQL for the pgvector adapter, built with Drizzle's `sql` tag so every value
 * AND every metadata key is a bound parameter; only validated identifiers
 * (`vs_<collection>`) and a validated integer reach the statement text.
 *
 * Metadata lives in one `jsonb` column. Equality and `in` compare `jsonb`
 * values (so a string `'5'` never equals the number `5`); ranges cast inside a
 * `CASE` that first checks the value is a JSON number, so a mistyped value can
 * never raise a cast error for a whole tenant.
 *
 * @module
 */
import type {
  VectorCollectionSpec,
  VectorFilter,
  VectorQuery,
  VectorRecord,
} from '@setu-ts/common';

/** The parts of `drizzle-orm`'s `sql` tag this module uses. */
export interface SqlTag {
  (strings: TemplateStringsArray, ...params: unknown[]): unknown;
  identifier(value: string): unknown;
  raw(value: string): unknown;
  join(chunks: unknown[], separator?: unknown): unknown;
}

/** A built statement, opaque to everything but `db.execute`. */
export type Statement = unknown;

/**
 * Table and index names for a collection. The collection grammar
 * (`^[a-z][a-z0-9_]{0,39}$`) keeps every name under PostgreSQL's 63 bytes.
 *
 * @param spec - The collection
 * @returns The names
 */
export function tableNames(spec: VectorCollectionSpec): {
  readonly table: string;
  readonly sourceIndex: string;
  readonly vectorIndex: string;
} {
  const table = `vs_${spec.name}`;
  return { table, sourceIndex: `${table}_src`, vectorIndex: `${table}_hnsw` };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Statements that create a collection's table and indexes when missing.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @returns The statements, in order
 */
export function createStatements(sql: SqlTag, spec: VectorCollectionSpec): Statement[] {
  const { table, sourceIndex, vectorIndex } = tableNames(spec);
  const t = sql.identifier(table);
  return [
    sql`CREATE TABLE IF NOT EXISTS ${t} (scope text NOT NULL, id text NOT NULL, source_id text, content text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, embedding vector(${sql.raw(String(spec.dimensions))}) NOT NULL, source_version bigint, PRIMARY KEY (scope, id))`,
    sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(sourceIndex)} ON ${t} (scope, source_id)`,
    sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(vectorIndex)} ON ${t} USING hnsw (embedding vector_cosine_ops)`,
  ];
}

/**
 * Adds the `source_version` column to a table created before versioned
 * `replaceSource`. Run only when {@linkcode describeStatement} reports the
 * column missing: `ALTER TABLE` takes an ACCESS EXCLUSIVE lock even when
 * `IF NOT EXISTS` would skip, so running it on every start would queue the
 * table's traffic behind any long query.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @returns The statement
 */
export function addVersionColumnStatement(sql: SqlTag, spec: VectorCollectionSpec): Statement {
  return sql`ALTER TABLE ${sql.identifier(tableNames(spec).table)} ADD COLUMN IF NOT EXISTS source_version bigint`;
}

/**
 * Reads the installed `vector` extension version.
 *
 * @param sql - The `sql` tag
 * @returns The statement; one row `{ extversion }` or none
 */
export function extensionVersionStatement(sql: SqlTag): Statement {
  return sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
}

/**
 * Creates the `vector` extension.
 *
 * @param sql - The `sql` tag
 * @returns The statement
 */
export function createExtensionStatement(sql: SqlTag): Statement {
  return sql`CREATE EXTENSION IF NOT EXISTS vector`;
}

/**
 * Describes an existing collection: the embedding column's declared length,
 * whether both indexes have their expected table and key shape and whether
 * the `source_version` column exists. The vector index must be cosine HNSW;
 * neither index may be partial or invalid (a failed `CREATE INDEX CONCURRENTLY`).
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @returns The statement; one row `{ dimensions, source_index, vector_index, source_version }` or none
 */
export function describeStatement(sql: SqlTag, spec: VectorCollectionSpec): Statement {
  const { table, sourceIndex, vectorIndex } = tableNames(spec);
  return sql`SELECT a.atttypmod AS dimensions,
    EXISTS (SELECT 1 FROM pg_index i
      JOIN pg_attribute s ON s.attrelid = i.indrelid AND s.attnum = i.indkey[0]
      JOIN pg_attribute t ON t.attrelid = i.indrelid AND t.attnum = i.indkey[1]
      WHERE i.indexrelid = to_regclass(${sourceIndex}) AND i.indrelid = a.attrelid
        AND i.indnkeyatts = 2 AND s.attname = 'scope' AND t.attname = 'source_id'
        AND i.indisvalid AND i.indpred IS NULL) AS source_index,
    EXISTS (SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am m ON m.oid = c.relam
      JOIN pg_opclass o ON o.oid = i.indclass[0]
      WHERE i.indexrelid = to_regclass(${vectorIndex}) AND i.indrelid = a.attrelid
        AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
        AND m.amname = 'hnsw' AND o.opcname = 'vector_cosine_ops'
        AND i.indisvalid AND i.indpred IS NULL) AS vector_index,
    EXISTS (SELECT 1 FROM pg_attribute v WHERE v.attrelid = a.attrelid AND v.attname = 'source_version' AND NOT v.attisdropped) AS source_version FROM pg_attribute a WHERE a.attrelid = to_regclass(${table}) AND a.attname = 'embedding' AND NOT a.attisdropped`;
}

/**
 * Inserts or replaces records by `(scope, id)`. A replaced row takes the new
 * version, so a record written without one is unversioned again.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @param records - At least one validated record
 * @param version - The `replaceSource` version the records carry, if any
 * @returns The statement
 */
export function upsertStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
  records: readonly VectorRecord[],
  version?: number,
): Statement {
  const rows = records.map(
    (record) =>
      sql`(${scope}, ${record.id}, ${record.sourceId ?? null}, ${record.content ?? null}, ${JSON.stringify(record.metadata ?? {})}::jsonb, ${vectorLiteral(record.vector)}::vector, ${version ?? null}::bigint)`,
  );
  return sql`INSERT INTO ${sql.identifier(tableNames(spec).table)} (scope, id, source_id, content, metadata, embedding, source_version) VALUES ${sql.join(rows, sql`, `)} ON CONFLICT (scope, id) DO UPDATE SET source_id = excluded.source_id, content = excluded.content, metadata = excluded.metadata, embedding = excluded.embedding, source_version = excluded.source_version`;
}

/**
 * Reads the highest version among a source's records in the scope. Run under
 * {@linkcode sourceLockStatement}, so no other replacement of the source can
 * change it before this transaction writes.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @param sourceId - The source
 * @returns The statement; one row `{ version }`, `null` when unversioned
 */
export function sourceVersionStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
  sourceId: string,
): Statement {
  return sql`SELECT max(source_version) AS version FROM ${sql.identifier(tableNames(spec).table)} WHERE scope = ${scope} AND source_id = ${sourceId}`;
}

/**
 * Deletes a source's records in the scope whose ids are not in `keep`.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @param sourceId - The source
 * @param keep - Ids to keep (possibly none)
 * @returns The statement
 */
export function deleteStaleStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
  sourceId: string,
  keep: readonly string[],
): Statement {
  return sql`DELETE FROM ${sql.identifier(tableNames(spec).table)} WHERE scope = ${scope} AND source_id = ${sourceId} AND id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb))`;
}

/**
 * Serialises replacements of one source: a transaction-scoped advisory lock
 * keyed on the table, scope and source, so two `replaceSource` calls for the
 * same source never interleave their write and stale-delete steps.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @param sourceId - The source
 * @returns The statement
 */
export function sourceLockStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
  sourceId: string,
): Statement {
  const key = `${tableNames(spec).table}|${scope.length}:${scope}|${sourceId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}

/**
 * Deletes records by id in the scope.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @param ids - The ids
 * @returns The statement
 */
export function deleteIdsStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
  ids: readonly string[],
): Statement {
  return sql`DELETE FROM ${sql.identifier(tableNames(spec).table)} WHERE scope = ${scope} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}

/**
 * Deletes every record of the scope.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @returns The statement
 */
export function deleteScopeStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
): Statement {
  return sql`DELETE FROM ${sql.identifier(tableNames(spec).table)} WHERE scope = ${scope}`;
}

/**
 * The session settings a query runs under, inside its transaction: enough
 * HNSW candidates for `topK`, and an iterative scan that keeps results in
 * distance order when a filter removes candidates.
 *
 * @param sql - The `sql` tag
 * @param topK - A validated integer from 1 to 50
 * @returns The statements
 */
export function querySettings(sql: SqlTag, topK: number): Statement[] {
  // SET takes no bind parameters; topK is an integer the service validated.
  const efSearch = Math.max(40, Math.trunc(topK));
  return [
    sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(efSearch))}`,
    sql`SET LOCAL hnsw.iterative_scan = strict_order`,
  ];
}

/**
 * The similarity query: an inner, index-ordered scan limited to `topK`, then an
 * outer `minScore` filter and the portable order (score descending, id
 * ascending). `minScore` stays outside the scan so it cannot defeat the index.
 *
 * @param sql - The `sql` tag
 * @param spec - The collection
 * @param scope - The tenant scope
 * @param query - A validated query
 * @returns The statement; rows `{ id, source_id, content, metadata, score }`
 */
export function queryStatement(
  sql: SqlTag,
  spec: VectorCollectionSpec,
  scope: string,
  query: VectorQuery,
): Statement {
  const vector = vectorLiteral(query.vector);
  const where =
    query.filter === undefined ? sql`` : sql` AND ${filterCondition(sql, query.filter)}`;
  const minScore =
    query.minScore === undefined ? sql`` : sql` WHERE candidates.score >= ${query.minScore}`;
  return sql`SELECT candidates.id, candidates.source_id, candidates.content, candidates.metadata, candidates.score FROM (SELECT id, source_id, content, metadata, 1 - (embedding <=> ${vector}::vector) AS score FROM ${sql.identifier(tableNames(spec).table)} WHERE scope = ${scope}${where} ORDER BY embedding <=> ${vector}::vector LIMIT ${query.topK}) AS candidates${minScore} ORDER BY candidates.score DESC, candidates.id COLLATE "C" ASC`;
}

/**
 * Translates a validated filter. Throws on anything outside the filter type —
 * a defence in depth behind the service's validation, never a silent skip.
 *
 * @param sql - The `sql` tag
 * @param filter - A validated filter
 * @returns The condition
 */
export function filterCondition(sql: SqlTag, filter: VectorFilter): unknown {
  if ('and' in filter) {
    return sql`(${sql.join(
      filter.and.map((child) => filterCondition(sql, child)),
      sql` AND `,
    )})`;
  }
  const key = filter.field;
  switch (filter.op) {
    case 'eq':
      return sql`(metadata -> ${key}::text) = ${JSON.stringify(filter.value)}::jsonb`;
    case 'in':
      return sql`(metadata -> ${key}::text) IN (SELECT jsonb_array_elements(${JSON.stringify(filter.value)}::jsonb))`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
      return sql`(CASE WHEN jsonb_typeof(metadata -> ${key}::text) = 'number' THEN (metadata ->> ${key}::text)::double precision END) ${sql.raw(operator)} ${filter.value}`;
    }
    default:
      throw new TypeError(
        `pgvector: unsupported filter operator '${String((filter as { op: unknown }).op)}'`,
      );
  }
}
