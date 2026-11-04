/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The pgvector adapter against a recording database. Every statement is
 * rendered with Drizzle's real PostgreSQL dialect, so the assertions read the
 * exact SQL text and bound parameters the driver would receive: values and
 * metadata keys never appear in the text, and the scope is bound in every
 * data statement.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BackendUnavailableError,
  OptionalDependencyUnavailableError,
  VectorCollectionMismatchError,
  VectorOperationUnsupportedError,
} from '@setu-ts/common';
import type { VectorCollectionSpec } from '@setu-ts/common';
import { PgVectorStore } from '../../src/adapters/pgvector/pgvector-store.ts';
import type { SqlTag } from '../../src/adapters/pgvector/pgvector-sql.ts';
import { filterCondition } from '../../src/adapters/pgvector/pgvector-sql.ts';

const dialect = new PgDialect();
const spec: VectorCollectionSpec = Object.freeze({
  name: 'documents',
  dimensions: 3,
  filterable: Object.freeze({ tag: 'string', year: 'number', public: 'boolean' }),
});

interface Rendered {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly inTransaction: boolean;
}

type Responder = (rendered: Rendered) => unknown;

function recordingDb(respond: Responder = () => ({ rows: [] }), arrayResults = false) {
  const statements: Rendered[] = [];
  let transactions = 0;
  const executor = (inTransaction: boolean) => ({
    async execute(statement: unknown) {
      const query = dialect.sqlToQuery(statement as SQL);
      const rendered = { text: query.sql, params: query.params, inTransaction };
      statements.push(rendered);
      const result = respond(rendered);
      if (result instanceof Error) throw result;
      return arrayResults ? ((result as { rows?: unknown[] }).rows ?? result) : result;
    },
  });
  const db = {
    ...executor(false),
    async transaction<T>(work: (tx: ReturnType<typeof executor>) => Promise<T>): Promise<T> {
      transactions += 1;
      return await work(executor(true));
    },
  };
  return { db, statements, transactions: () => transactions };
}

/** Answers the extension and describe probes as a healthy installation would. */
function healthy(overrides: Partial<Record<'version' | 'dimensions', unknown>> = {}): Responder {
  return ({ text }) => {
    if (text.includes('FROM pg_extension')) {
      return {
        rows: overrides.version === null ? [] : [{ extversion: overrides.version ?? '0.8.1' }],
      };
    }
    if (text.includes('FROM pg_attribute')) {
      return {
        rows: [{ dimensions: overrides.dimensions ?? 3, source_index: true, vector_index: true }],
      };
    }
    return { rows: [] };
  };
}

async function opened(respond: Responder = healthy(), ensure?: 'create' | 'verify') {
  const recording = recordingDb(respond);
  const store = new PgVectorStore({
    db: recording.db,
    ...(ensure === undefined ? {} : { ensure }),
  });
  await store.open();
  return { store, ...recording };
}

describe('PgVectorStore', () => {
  it('refuses a db without execute and transaction, and a bad ensure mode', () => {
    expect(() => new PgVectorStore({ db: {} as never })).toThrow('execute() and transaction()');
    expect(() => new PgVectorStore(undefined as never)).toThrow('execute() and transaction()');
    expect(() => new PgVectorStore({ db: null as never })).toThrow('execute() and transaction()');
    expect(() => new PgVectorStore({ db: recordingDb().db, ensure: 'migrate' as never })).toThrow(
      "ensure must be 'create' or 'verify'",
    );
  });

  it('names drizzle-orm when it cannot be loaded', async () => {
    const store = new PgVectorStore({ db: recordingDb().db }, () =>
      Promise.reject(new OptionalDependencyUnavailableError('drizzle-orm')),
    );
    await expect(store.open()).rejects.toThrow(OptionalDependencyUnavailableError);
  });

  it('refuses any call before open()', async () => {
    const store = new PgVectorStore({ db: recordingDb().db });
    await expect(store.deleteScope(spec, 't')).rejects.toThrow('open() must run');
  });

  it('creates the extension when missing in create mode, then requires 0.8.0', async () => {
    let installed = false;
    const { statements } = await opened(({ text }) => {
      if (text.includes('CREATE EXTENSION')) {
        installed = true;
        return { rows: [] };
      }
      if (text.includes('FROM pg_extension')) {
        return { rows: installed ? [{ extversion: '0.8.0' }] : [] };
      }
      return { rows: [] };
    });
    expect(statements.map((s) => s.text)).toEqual([
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      'CREATE EXTENSION IF NOT EXISTS vector',
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    ]);
  });

  it.each([
    ['missing in verify mode', { version: null }, 'verify', 'is not installed'],
    ['too old', { version: '0.7.4' }, 'create', 'is 0.7.4'],
    ['unparseable', { version: 'devel' }, 'create', 'is devel'],
  ] as const)('refuses an extension %s', async (_label, overrides, ensure, message) => {
    await expect(opened(healthy(overrides), ensure)).rejects.toThrow(
      VectorOperationUnsupportedError,
    );
    await expect(opened(healthy(overrides), ensure)).rejects.toThrow(message);
  });

  it('accepts a newer major version', async () => {
    await expect(opened(healthy({ version: '1.0.0' }))).resolves.toBeDefined();
  });

  it('creates the table and indexes, then verifies dimensions and indexes', async () => {
    const { store, statements } = await opened();
    statements.length = 0;
    await store.ensureCollection(spec);
    expect(statements.map((s) => s.text)).toEqual([
      'CREATE TABLE IF NOT EXISTS "vs_documents" (scope text NOT NULL, id text NOT NULL, source_id text, content text, metadata jsonb NOT NULL DEFAULT \'{}\'::jsonb, embedding vector(3) NOT NULL, PRIMARY KEY (scope, id))',
      'CREATE INDEX IF NOT EXISTS "vs_documents_src" ON "vs_documents" (scope, source_id)',
      'CREATE INDEX IF NOT EXISTS "vs_documents_hnsw" ON "vs_documents" USING hnsw (embedding vector_cosine_ops)',
      "SELECT a.atttypmod AS dimensions, to_regclass($1) IS NOT NULL AS source_index, to_regclass($2) IS NOT NULL AS vector_index FROM pg_attribute a WHERE a.attrelid = to_regclass($3) AND a.attname = 'embedding' AND NOT a.attisdropped",
    ]);
    expect(statements[3]!.params).toEqual([
      'vs_documents_src',
      'vs_documents_hnsw',
      'vs_documents',
    ]);
  });

  it('only verifies in verify mode', async () => {
    const { store, statements } = await opened(healthy(), 'verify');
    statements.length = 0;
    await store.ensureCollection(spec);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toContain('FROM pg_attribute');
  });

  it.each<[string, Responder, string]>([
    [
      'a missing table',
      ({ text }) =>
        text.includes('pg_attribute')
          ? { rows: [] }
          : healthy()({ text, params: [], inTransaction: false }),
      'does not exist',
    ],
    ['another dimension', healthy({ dimensions: 768 }), 'stores 768-dimension vectors'],
    [
      'a missing HNSW index',
      ({ text }) =>
        text.includes('pg_attribute')
          ? { rows: [{ dimensions: 3, source_index: true, vector_index: false }] }
          : healthy()({ text, params: [], inTransaction: false }),
      'missing its HNSW index',
    ],
    [
      'a missing source index',
      ({ text }) =>
        text.includes('pg_attribute')
          ? { rows: [{ dimensions: 3, source_index: false, vector_index: true }] }
          : healthy()({ text, params: [], inTransaction: false }),
      'missing its source index',
    ],
  ])('refuses %s', async (_label, respond, message) => {
    const { store } = await opened(respond);
    await expect(store.ensureCollection(spec)).rejects.toThrow(VectorCollectionMismatchError);
    await expect(store.ensureCollection(spec)).rejects.toThrow(message);
  });

  it('refuses more dimensions than HNSW indexes', async () => {
    const { store } = await opened();
    await expect(store.ensureCollection({ ...spec, dimensions: 2001 })).rejects.toThrow(
      VectorOperationUnsupportedError,
    );
  });

  it('upserts with every value bound and the scope in the key', async () => {
    const { store, statements } = await opened();
    statements.length = 0;
    await store.upsert(spec, 'tenant-a', [
      {
        id: 'r1',
        vector: [1, 0, 0],
        sourceId: 's1',
        content: "it's",
        metadata: { tag: "x'); DROP TABLE t;--" },
      },
      { id: 'r2', vector: [0, 1, 0.5] },
    ]);
    const [insert] = statements;
    expect(insert!.text).toBe(
      'INSERT INTO "vs_documents" (scope, id, source_id, content, metadata, embedding) VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector), ($7, $8, $9, $10, $11::jsonb, $12::vector) ON CONFLICT (scope, id) DO UPDATE SET source_id = excluded.source_id, content = excluded.content, metadata = excluded.metadata, embedding = excluded.embedding',
    );
    expect(insert!.params).toEqual([
      'tenant-a',
      'r1',
      's1',
      "it's",
      '{"tag":"x\'); DROP TABLE t;--"}',
      '[1,0,0]',
      'tenant-a',
      'r2',
      null,
      null,
      '{}',
      '[0,1,0.5]',
    ]);
  });

  it('replaces a source in one transaction: write, then delete that source’s other ids', async () => {
    const { store, statements, transactions } = await opened();
    statements.length = 0;
    await store.replaceSource(spec, 'tenant-a', 's1', [
      { id: 'r1', vector: [1, 0, 0], sourceId: 's1' },
    ]);
    expect(transactions()).toBe(1);
    expect(statements.every((s) => s.inTransaction)).toBe(true);
    // The source lock comes first, so replacements of one source serialise.
    expect(statements[0]!.text).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))');
    expect(statements[0]!.params).toEqual(['vs_documents|8:tenant-a|s1']);
    expect(statements[1]!.text.startsWith('INSERT INTO "vs_documents"')).toBe(true);
    expect(statements[2]!.text).toBe(
      'DELETE FROM "vs_documents" WHERE scope = $1 AND source_id = $2 AND id NOT IN (SELECT jsonb_array_elements_text($3::jsonb))',
    );
    expect(statements[2]!.params).toEqual(['tenant-a', 's1', '["r1"]']);
    statements.length = 0;
    await store.replaceSource(spec, 'tenant-a', 's1', []);
    expect(statements).toHaveLength(2);
    expect(statements[1]!.params).toEqual(['tenant-a', 's1', '[]']);
  });

  it('queries inside a transaction with the HNSW settings, an inner scan and an outer order', async () => {
    const respond: Responder = (rendered) =>
      rendered.text.startsWith('SELECT candidates')
        ? {
            rows: [
              { id: 'r1', source_id: 's1', content: 'text', metadata: { tag: 'x' }, score: '0.9' },
              { id: 'r2', source_id: null, content: null, metadata: '{"year":1}', score: 0.5 },
              { id: 'r3', source_id: null, content: null, metadata: null, score: 0.1 },
            ],
          }
        : healthy()(rendered);
    const { store, statements } = await opened(respond);
    statements.length = 0;
    const matches = await store.query(spec, 'tenant-a', {
      vector: [1, 0, 0],
      topK: 50,
      minScore: 0.2,
      filter: { field: 'tag', op: 'eq', value: 'x' },
    });
    expect(matches).toEqual([
      { id: 'r1', score: 0.9, sourceId: 's1', content: 'text', metadata: { tag: 'x' } },
      { id: 'r2', score: 0.5, metadata: { year: 1 } },
      { id: 'r3', score: 0.1, metadata: {} },
    ]);
    expect(statements).toHaveLength(3);
    expect(statements[0]!.text).toBe('SET LOCAL hnsw.ef_search = 50');
    expect(statements[1]!.text).toBe('SET LOCAL hnsw.iterative_scan = strict_order');
    expect(statements[2]!.text.startsWith('SELECT candidates.id, candidates.source_id')).toBe(true);
    expect(statements.every((s) => s.inTransaction)).toBe(true);
    expect(statements[2]!.text).toBe(
      'SELECT candidates.id, candidates.source_id, candidates.content, candidates.metadata, candidates.score FROM (SELECT id, source_id, content, metadata, 1 - (embedding <=> $1::vector) AS score FROM "vs_documents" WHERE scope = $2 AND (metadata -> $3::text) = $4::jsonb ORDER BY embedding <=> $5::vector LIMIT $6) AS candidates WHERE candidates.score >= $7 ORDER BY candidates.score DESC, candidates.id ASC',
    );
    expect(statements[2]!.params).toEqual([
      '[1,0,0]',
      'tenant-a',
      'tag',
      '"x"',
      '[1,0,0]',
      50,
      0.2,
    ]);
  });

  it('uses at least 40 HNSW candidates and no filter or minScore clause when absent', async () => {
    const { store, statements } = await opened();
    statements.length = 0;
    await store.query(spec, 'tenant-a', { vector: [1, 0, 0], topK: 5 });
    expect(statements[0]!.text).toBe('SET LOCAL hnsw.ef_search = 40');
    expect(statements[2]!.text).not.toContain('WHERE candidates.score');
    expect(statements[2]!.text).toContain('WHERE scope = $2 ORDER BY');
  });

  it('deletes by ids and by scope with the scope bound', async () => {
    const { store, statements } = await opened();
    statements.length = 0;
    await store.delete(spec, 'tenant-a', ['r1', 'r2']);
    await store.deleteScope(spec, 'tenant-a');
    expect(statements.map((s) => [s.text, s.params])).toEqual([
      [
        'DELETE FROM "vs_documents" WHERE scope = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))',
        ['tenant-a', '["r1","r2"]'],
      ],
      ['DELETE FROM "vs_documents" WHERE scope = $1', ['tenant-a']],
    ]);
  });

  it('reads postgres-js array results as well as node-postgres { rows }', async () => {
    const recording = recordingDb(healthy(), true);
    const store = new PgVectorStore({ db: recording.db });
    await store.open();
    await store.ensureCollection(spec);
  });

  it('turns a connection failure into a backend fault and rethrows anything else', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const failing =
      (error: Error): Responder =>
      (rendered) =>
        rendered.text.startsWith('DELETE') ? error : healthy()(rendered);
    const down = await opened(failing(refused));
    await expect(down.store.deleteScope(spec, 't')).rejects.toThrow(BackendUnavailableError);
    const broken = await opened(failing(new Error('syntax error')));
    await expect(broken.store.deleteScope(spec, 't')).rejects.toThrow('syntax error');
  });

  it('calls onClose once at close, and close is a no-op without it', async () => {
    let closed = 0;
    const store = new PgVectorStore({ db: recordingDb().db, onClose: () => void closed++ });
    await store.close();
    await new PgVectorStore({ db: recordingDb().db }).close();
    expect(closed).toBe(1);
  });
});

describe('pgvector filter translation', () => {
  const tag = sql as unknown as SqlTag;
  const render = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

  it('binds keys and values for every operator', () => {
    expect(
      render(filterCondition(tag, { field: 'tag', op: 'in', value: ['a', 'b'] })),
    ).toMatchObject({
      sql: '(metadata -> $1::text) IN (SELECT jsonb_array_elements($2::jsonb))',
      params: ['tag', '["a","b"]'],
    });
    for (const [op, symbol] of [
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<='],
    ] as const) {
      expect(render(filterCondition(tag, { field: 'year', op, value: 2020 })).sql).toBe(
        `(CASE WHEN jsonb_typeof(metadata -> $1::text) = 'number' THEN (metadata ->> $2::text)::double precision END) ${symbol} $3`,
      );
    }
    expect(
      render(
        filterCondition(tag, {
          and: [
            { field: 'public', op: 'eq', value: true },
            { field: 'year', op: 'eq', value: 1 },
          ],
        }),
      ),
    ).toMatchObject({
      sql: '((metadata -> $1::text) = $2::jsonb AND (metadata -> $3::text) = $4::jsonb)',
      params: ['public', 'true', 'year', '1'],
    });
  });

  it('throws on an operator outside the filter type rather than skipping it', () => {
    expect(() =>
      filterCondition(tag, { field: 'tag', op: 'contains', value: 'x' } as never),
    ).toThrow("unsupported filter operator 'contains'");
  });
});
