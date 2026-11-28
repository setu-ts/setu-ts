/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The pgvector adapter against a recording database. Every statement is
 * rendered with Drizzle's real PostgreSQL dialect, so the assertions read the
 * exact SQL text and bound parameters the driver would receive: values and
 * metadata keys never appear in the text, and the scope is bound in every
 * data statement.
 */
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BackendUnavailableError,
  OptionalDependencyUnavailableError,
  VectorCollectionMismatchError,
  VectorOperationUnsupportedError,
  VectorVersionConflictError,
} from '@setu-ts/common';
import type { VectorCollectionSpec } from '@setu-ts/common';
import {
  isPoolAcquireTimeout,
  PgVectorStore,
  poolSaturated,
  QUERY_PROGRESS_WINDOW_MS,
} from '../../src/adapters/pgvector/pgvector-store.ts';
import type { SqlTag } from '../../src/adapters/pgvector/pgvector-sql.ts';
import { filterCondition } from '../../src/adapters/pgvector/pgvector-sql.ts';

const dialect = new PgDialect();
const spec: VectorCollectionSpec = Object.freeze({
  name: 'documents',
  dimensions: 3,
  filterable: Object.freeze({ tag: 'string', year: 'number', public: 'boolean' }),
});

describe('pgvector index diagnostics', () => {
  for (const column of ['vector', 'source'] as const) {
    for (const present of [false, true]) {
      it(`${column} index distinguishes ${present ? 'wrong relation' : 'missing relation'}`, async () => {
        const h = await opened((rendered) =>
          rendered.text.includes('FROM pg_attribute')
            ? {
                rows: [
                  {
                    dimensions: 3,
                    source_index: true,
                    vector_index: true,
                    source_version: true,
                    [`${column}_index`]: false,
                    [`${column}_index_present`]: present,
                  },
                ],
              }
            : healthy()(rendered),
        );
        await expect(h.store.ensureCollection(spec)).rejects.toThrow(
          present
            ? /has a relation named .* that is not the expected valid, non-partial/
            : /is missing its/,
        );
        const query = h.statements.find((s) => s.text.includes('AS dimensions'))!;
        expect(query.text).toContain('AS vector_index_present');
        expect(query.text).toContain('AS source_index_present');
      });
    }
  }
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
        rows: [
          {
            dimensions: overrides.dimensions ?? 3,
            source_index: true,
            vector_index: true,
            source_version: true,
          },
        ],
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
  it.each([undefined, 7])(
    'M139c slices a replacement under one lock and transaction (version %s)',
    async (version) => {
      const h = await opened();
      const records = Array.from({ length: 1201 }, (_, i) => ({
        id: `r${i}`,
        sourceId: 'source',
        vector: [1, 0, 0],
      }));
      h.statements.length = 0;
      await h.store.replaceSource(spec, 'tenant-a', 'source', records, version);
      const writes = h.statements.filter((s) => s.text.startsWith('INSERT'));
      expect(writes.map((s) => s.params.length / 7)).toEqual([500, 500, 201]);
      expect(writes.flatMap((s) => s.params.filter((_, i) => i % 7 === 1))).toEqual(
        records.map((r) => r.id),
      );
      for (const s of writes) {
        expect(s.inTransaction).toBe(true);
        expect(s.params.filter((_, i) => i % 7 === 0)).toEqual(
          Array(s.params.length / 7).fill('tenant-a'),
        );
        expect(s.params.filter((_, i) => i % 7 === 6)).toEqual(
          Array(s.params.length / 7).fill(version ?? null),
        );
      }
      expect(h.transactions()).toBe(1);
      expect(h.statements[0]!.text).toContain('pg_advisory_xact_lock');
      expect(h.statements.at(-1)!.params).toEqual([
        'tenant-a',
        'source',
        JSON.stringify(records.map((r) => r.id)),
      ]);
      expect(h.statements.filter((s) => s.text.startsWith('DELETE'))).toHaveLength(1);
    },
  );
  it.each(['source_index', 'vector_index'] as const)(
    'M139c names the expected %s shape and fails closed',
    async (column) => {
      // A string 'f' from a driver's boolean parser must fail closed, not read as truthy.
      for (const value of [false, null, undefined, 'f', 'false', 't', 1]) {
        const h = await opened((rendered) =>
          rendered.text.includes('FROM pg_attribute')
            ? {
                rows: [
                  {
                    dimensions: 3,
                    source_index: true,
                    vector_index: true,
                    source_version: true,
                    [column]: value,
                  },
                ],
              }
            : healthy()(rendered),
        );
        await expect(h.store.ensureCollection(spec)).rejects.toThrow(
          column === 'source_index'
            ? 'expected vs_documents_src ON vs_documents (scope, source_id).'
            : 'expected vs_documents_hnsw ON vs_documents USING hnsw (embedding vector_cosine_ops).',
        );
      }
    },
  );
  it('M139c describes index table, ordered key columns, access method and cosine opclass', async () => {
    const h = await opened();
    await h.store.ensureCollection(spec);
    const query = h.statements.find((s) => s.text.includes('AS dimensions'))!;
    for (const sql of [
      'FROM pg_index',
      'JOIN pg_class',
      'JOIN pg_am',
      'JOIN pg_opclass',
      'i.indrelid = a.attrelid',
      'i.indnkeyatts = 2',
      "s.attname = 'scope'",
      "t.attname = 'source_id'",
      'i.indnkeyatts = 1',
      'i.indkey[0] = a.attnum',
      "m.amname = 'hnsw'",
      "o.opcname = 'vector_cosine_ops'",
      'i.indisvalid AND i.indpred IS NULL) AS source_index',
      'i.indisvalid AND i.indpred IS NULL) AS vector_index',
    ])
      expect(query.text).toContain(sql);
    expect(query.params).toEqual([
      'vs_documents_hnsw',
      'vs_documents_src',
      'vs_documents_src',
      'vs_documents_hnsw',
      'vs_documents',
    ]);
  });
  it('gives the app-owned pool an error listener at open, reporting through the logger (audit F1)', async () => {
    const { EventEmitter } = await import('node:events');
    const pool = new EventEmitter();
    const recording = recordingDb(healthy());
    const warnings: unknown[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const store = new PgVectorStore({ db: Object.assign(recording.db, { $client: pool }) });
    await store.open(undefined, logger as never);
    // An idle connection drop no longer reaches the process as an unhandled 'error'.
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    // A client checked out for a transaction gets its own listener.
    const client = new EventEmitter();
    pool.emit('acquire', client);
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(warnings).toEqual([
      'Database pool reported an idle-connection error',
      'Database pool reported a checked-out-connection error',
    ]);
    // Without a logger the listener still keeps the process alive.
    const quiet = new EventEmitter();
    await new PgVectorStore({
      db: Object.assign(recordingDb(healthy()).db, { $client: quiet }),
    }).open();
    expect(() => quiet.emit('error', new Error('x'))).not.toThrow();
  });

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
    expect(statements.slice(0, 3).map((s) => s.text)).toEqual([
      'CREATE TABLE IF NOT EXISTS "vs_documents" (scope text NOT NULL, id text NOT NULL, source_id text, content text, metadata jsonb NOT NULL DEFAULT \'{}\'::jsonb, embedding vector(3) NOT NULL, source_version bigint, PRIMARY KEY (scope, id))',
      'CREATE INDEX IF NOT EXISTS "vs_documents_src" ON "vs_documents" (scope, source_id)',
      'CREATE INDEX IF NOT EXISTS "vs_documents_hnsw" ON "vs_documents" USING hnsw (embedding vector_cosine_ops)',
    ]);
    expect(statements).toHaveLength(4);
    expect(statements[3]!.text).toContain('FROM pg_index');
    expect(statements[3]!.text).toContain('AS source_version');
    expect(statements[3]!.params).toEqual([
      'vs_documents_hnsw',
      'vs_documents_src',
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

  it('adds a missing source_version column in create mode only, never on every start', async () => {
    const withoutColumn: Responder = ({ text }) =>
      text.includes('pg_attribute')
        ? {
            rows: [
              { dimensions: 3, source_index: true, vector_index: true, source_version: false },
            ],
          }
        : healthy()({ text, params: [], inTransaction: false });
    const alter = 'ALTER TABLE "vs_documents" ADD COLUMN IF NOT EXISTS source_version bigint';
    const created = await opened(withoutColumn);
    created.statements.length = 0;
    await created.store.ensureCollection(spec);
    expect(created.statements.at(-1)!.text).toBe(alter);
    // With the column present, the ALTER (an ACCESS EXCLUSIVE lock) is not run.
    const present = await opened();
    await present.store.ensureCollection(spec);
    expect(present.statements.some((s) => s.text.startsWith('ALTER'))).toBe(false);
    // A migration-owned table is refused, never altered.
    const verified = await opened(withoutColumn, 'verify');
    await expect(verified.store.ensureCollection(spec)).rejects.toThrow(
      'ADD COLUMN source_version bigint',
    );
    expect(verified.statements.some((s) => s.text.startsWith('ALTER'))).toBe(false);
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
      'INSERT INTO "vs_documents" (scope, id, source_id, content, metadata, embedding, source_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, $7::bigint), ($8, $9, $10, $11, $12::jsonb, $13::vector, $14::bigint) ON CONFLICT (scope, id) DO UPDATE SET source_id = excluded.source_id, content = excluded.content, metadata = excluded.metadata, embedding = excluded.embedding, source_version = excluded.source_version',
    );
    expect(insert!.params).toEqual([
      'tenant-a',
      'r1',
      's1',
      "it's",
      '{"tag":"x\'); DROP TABLE t;--"}',
      '[1,0,0]',
      null,
      'tenant-a',
      'r2',
      null,
      null,
      '{}',
      '[0,1,0.5]',
      null,
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

  it('reads the stored version under the source lock and writes the new one', async () => {
    const { store, statements } = await opened();
    statements.length = 0;
    await store.replaceSource(
      spec,
      'tenant-a',
      's1',
      [{ id: 'r1', vector: [1, 0, 0], sourceId: 's1' }],
      7,
    );
    expect(statements.map((s) => s.text.slice(0, 40))).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextext',
      'SELECT max(source_version) AS version FR',
      'INSERT INTO "vs_documents" (scope, id, s',
      'DELETE FROM "vs_documents" WHERE scope =',
    ]);
    expect(statements[1]!.params).toEqual(['tenant-a', 's1']);
    expect(statements[2]!.params.at(-1)).toBe(7);
  });

  it.each<[string, unknown, number, boolean]>([
    ['an unversioned source', null, 0, false],
    ['an equal version', '5', 5, false],
    ['an older stored version', 4, 5, false],
    ['a newer stored version (node-postgres bigint string)', '6', 5, true],
    ['a newer stored version (number)', 9, 5, true],
  ])('with %s, refuses only a newer stored version', async (_label, stored, version, refused) => {
    const respond: Responder = (rendered) =>
      rendered.text.startsWith('SELECT max(source_version)')
        ? { rows: [{ version: stored }] }
        : healthy()(rendered);
    const { store, statements } = await opened(respond);
    statements.length = 0;
    const write = store.replaceSource(
      spec,
      'tenant-a',
      's1',
      [{ id: 'r1', vector: [1, 0, 0], sourceId: 's1' }],
      version,
    );
    if (refused) {
      await expect(write).rejects.toThrow(VectorVersionConflictError);
      // Nothing is written after the refusal: the transaction rolls back at the read.
      expect(statements.map((s) => s.text.slice(0, 6))).toEqual(['SELECT', 'SELECT']);
    } else {
      await write;
      expect(statements).toHaveLength(4);
    }
  });

  it('treats a source with no rows as unversioned', async () => {
    const { store } = await opened();
    await expect(store.replaceSource(spec, 'tenant-a', 's1', [], 3)).resolves.toBeUndefined();
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
      'SELECT candidates.id, candidates.source_id, candidates.content, candidates.metadata, candidates.score FROM (SELECT id, source_id, content, metadata, 1 - (embedding <=> $1::vector) AS score FROM "vs_documents" WHERE scope = $2 AND (metadata -> $3::text) = $4::jsonb ORDER BY embedding <=> $5::vector LIMIT $6) AS candidates WHERE candidates.score >= $7 ORDER BY candidates.score DESC, candidates.id COLLATE "C" ASC',
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

describe('PgVectorStore.isHealthy', () => {
  it('runs SELECT 1 through the database and rejects when it fails', async () => {
    const h = await opened();
    h.statements.length = 0;
    expect(await h.store.isHealthy()).toBe(true);
    expect(h.statements.map((s) => s.text)).toEqual(['SELECT 1']);
    let fail = false;
    const down = await opened((rendered) =>
      fail && rendered.text === 'SELECT 1'
        ? new Error('connection terminated')
        : healthy()(rendered),
    );
    fail = true;
    await expect(down.store.isHealthy()).rejects.toThrow();
  });

  /** A store over a pool reporting `counters`, opened with a clock the test moves. */
  async function saturatedStore(
    counters: Record<string, unknown> | undefined,
    respond: Responder = healthy(),
  ) {
    const recording = recordingDb(respond);
    if (counters !== undefined) Object.assign(recording.db, { $client: counters });
    const store = new PgVectorStore({ db: recording.db });
    let now = 0;
    await store.open({ hrtime: () => now } as never);
    return { store, ...recording, advance: (ms: number) => (now += ms) };
  }

  it('probes a pool with an idle connection, or no waiter, or no counters', async () => {
    for (const counters of [
      { idleCount: 0, waitingCount: 0 },
      { idleCount: 2, waitingCount: 3 },
      undefined,
    ]) {
      const h = await saturatedStore(counters);
      h.statements.length = 0;
      expect(await h.store.isHealthy()).toBe(true);
      expect(h.statements.map((s) => s.text)).toEqual(['SELECT 1']);
    }
  });

  it('answers it could not tell for a saturated pool while statements complete, and false once they stop', async () => {
    // No statement of its own in flight: the pool is busy with the application's work.
    const idle = await saturatedStore({ idleCount: 0, waitingCount: 3 });
    idle.statements.length = 0;
    expect(await idle.store.isHealthy()).toBeUndefined();
    expect(idle.statements).toEqual([]);

    // A statement in flight, and one completed within the window: still serving.
    let release: () => void = () => {};
    const hanging = new Promise<{ rows: [] }>((resolve) => (release = () => resolve({ rows: [] })));
    const busy = await saturatedStore({ idleCount: 0, waitingCount: 3 }, (rendered) =>
      rendered.text.startsWith('DELETE') ? hanging : healthy()(rendered),
    );
    const pending = busy.store.delete(spec, 'tenant-a', ['r1']);
    busy.advance(QUERY_PROGRESS_WINDOW_MS);
    expect(await busy.store.isHealthy()).toBeUndefined();
    // Past the window with that statement still running: stopped.
    busy.advance(1);
    expect(await busy.store.isHealthy()).toBe(false);
    release();
    await pending;
  });

  it('skips the probe for a full pool with no waiter yet, and judges by its counters', async () => {
    for (const [counters, saturated] of [
      [{ idleCount: 0, waitingCount: 0, totalCount: 10 }, true],
      [{ idleCount: 0, waitingCount: 0, totalCount: 4, options: { max: 4 } }, true],
      [{ idleCount: 0, waitingCount: 0, totalCount: 3, options: { max: 4 } }, false],
      [{ idleCount: 1, waitingCount: 0, totalCount: 10 }, false],
    ] as const) {
      expect(poolSaturated(counters)).toBe(saturated);
      const h = await saturatedStore(counters);
      h.statements.length = 0;
      expect(await h.store.isHealthy()).toBe(saturated ? undefined : true);
      expect(h.statements.length).toBe(saturated ? 0 : 1);
    }
    expect(poolSaturated(null)).toBe(false);
    expect(poolSaturated({ waitingCount: 3 })).toBe(false);
  });

  it('gives the first statement of a busy spell one window before it reads as stalled', async () => {
    let release: () => void = () => {};
    const hanging = new Promise<{ rows: [] }>((resolve) => (release = () => resolve({ rows: [] })));
    const h = await saturatedStore({ idleCount: 0, waitingCount: 2 }, (rendered) =>
      rendered.text.startsWith('DELETE') ? hanging : healthy()(rendered),
    );
    h.advance(60_000);
    const pending = h.store.delete(spec, 'tenant-a', ['r1']);
    expect(await h.store.isHealthy()).toBeUndefined();
    h.advance(QUERY_PROGRESS_WINDOW_MS + 1);
    expect(await h.store.isHealthy()).toBe(false);
    release();
    await pending;
  });

  it('reads a probe left outstanding past the window as a stall once its checkouts fill the pool', async () => {
    let release: () => void = () => {};
    const hanging = new Promise<{ rows: [] }>((resolve) => (release = () => resolve({ rows: [] })));
    const counters = { idleCount: 1, waitingCount: 0, totalCount: 1, options: { max: 3 } };
    const h = await saturatedStore(counters, (rendered) =>
      rendered.text === 'SELECT 1' ? hanging : healthy()(rendered),
    );
    // The indicator gives up on this probe; its checkout stays pending.
    const abandoned = h.store.isHealthy();
    Object.assign(counters, { idleCount: 0, totalCount: 3 });
    h.advance(QUERY_PROGRESS_WINDOW_MS);
    expect(await h.store.isHealthy()).toBeUndefined();
    h.advance(1);
    expect(await h.store.isHealthy()).toBe(false);
    // Once it settles the pool is serving again, and a full pool reads as unknown.
    release();
    expect(await abandoned).toBe(true);
    expect(await h.store.isHealthy()).toBeUndefined();
  });

  it('keeps a later probe outstanding after an earlier one settles', async () => {
    const releases: (() => void)[] = [];
    const counters = { idleCount: 1, waitingCount: 0, totalCount: 1, options: { max: 3 } };
    const h = await saturatedStore(counters, (rendered) =>
      rendered.text === 'SELECT 1'
        ? new Promise<{ rows: [] }>((resolve) => releases.push(() => resolve({ rows: [] })))
        : healthy()(rendered),
    );
    const first = h.store.isHealthy();
    h.advance(5_000);
    const second = h.store.isHealthy();
    releases[0]!();
    expect(await first).toBe(true);
    // Only the second probe is outstanding now; its own start is what counts.
    Object.assign(counters, { idleCount: 0, totalCount: 3 });
    h.advance(QUERY_PROGRESS_WINDOW_MS);
    expect(await h.store.isHealthy()).toBeUndefined();
    h.advance(1);
    expect(await h.store.isHealthy()).toBe(false);
    releases[1]!();
    expect(await second).toBe(true);
  });

  it('reads a probe queued behind statements that keep completing as unknown, not a stall', async () => {
    const releases: (() => void)[] = [];
    const counters = { idleCount: 1, waitingCount: 0, totalCount: 1, options: { max: 3 } };
    const h = await saturatedStore(counters, (rendered) =>
      rendered.text === 'SELECT 1'
        ? new Promise<{ rows: [] }>((resolve) => releases.push(() => resolve({ rows: [] })))
        : healthy()(rendered),
    );
    const queued = h.store.isHealthy();
    Object.assign(counters, { idleCount: 0, totalCount: 3 });
    h.advance(QUERY_PROGRESS_WINDOW_MS + 1);
    // A statement completes now: the pool is serving, so the old probe is queued, not stalled.
    await h.store.delete(spec, 'tenant-a', ['r1']);
    expect(await h.store.isHealthy()).toBeUndefined();
    // Once no statement has completed for a whole window, the old probe is a stall again.
    h.advance(QUERY_PROGRESS_WINDOW_MS + 1);
    expect(await h.store.isHealthy()).toBe(false);
    releases[0]!();
    expect(await queued).toBe(true);
  });

  it('counts each completed statement of a long replaceSource as progress', async () => {
    const releases: (() => void)[] = [];
    const h = await saturatedStore({ idleCount: 0, waitingCount: 2 }, (rendered) =>
      rendered.inTransaction
        ? new Promise<{ rows: [] }>((resolve) => releases.push(() => resolve({ rows: [] })))
        : healthy()(rendered),
    );
    const pending = h.store.replaceSource(spec, 'tenant-a', 'doc-1', [
      { id: 'r1', vector: [1, 0, 0] },
    ]);
    // The lock completes nine seconds in, then the upsert waits.
    h.advance(9_000);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    h.advance(9_000);
    // Eighteen seconds into the transaction, nine since a statement completed.
    expect(await h.store.isHealthy()).toBeUndefined();
    h.advance(QUERY_PROGRESS_WINDOW_MS - 9_000 + 1);
    expect(await h.store.isHealthy()).toBe(false);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await pending;
  });

  it("reads the probe's own pool-acquire timeout as saturation, but not an answer with a code", async () => {
    const timeout = Object.assign(new Error('timeout exceeded when trying to connect'), {});
    const h = await saturatedStore({ idleCount: 0, waitingCount: 0 }, (rendered) =>
      rendered.text === 'SELECT 1' ? timeout : healthy()(rendered),
    );
    expect(await h.store.isHealthy()).toBeUndefined();
    // The same timeout with a statement stalled past the window: stopped.
    let release: () => void = () => {};
    const hanging = new Promise<{ rows: [] }>((resolve) => (release = () => resolve({ rows: [] })));
    const stalled = await saturatedStore({ idleCount: 0, waitingCount: 0 }, (rendered) =>
      rendered.text === 'SELECT 1'
        ? timeout
        : rendered.text.startsWith('DELETE')
          ? hanging
          : healthy()(rendered),
    );
    const pending = stalled.store.delete(spec, 'tenant-a', ['r1']);
    stalled.advance(QUERY_PROGRESS_WINDOW_MS + 1);
    expect(await stalled.store.isHealthy()).toBe(false);
    release();
    await pending;
    expect(isPoolAcquireTimeout(new Error('wrapped', { cause: timeout }))).toBe(true);
    expect(
      isPoolAcquireTimeout(
        Object.assign(new Error('timeout exceeded when trying to connect'), { code: '57014' }),
      ),
    ).toBe(false);
    expect(isPoolAcquireTimeout(new Error('connection terminated'))).toBe(false);
    const refused = await saturatedStore(undefined, (rendered) =>
      rendered.text === 'SELECT 1' ? new Error('connection terminated') : healthy()(rendered),
    );
    await expect(refused.store.isHealthy()).rejects.toThrow();
  });

  it('answers it could not tell for a saturated pool when opened without a clock', async () => {
    const recording = recordingDb(healthy());
    Object.assign(recording.db, { $client: { idleCount: 0, waitingCount: 1 } });
    const store = new PgVectorStore({ db: recording.db });
    await store.open();
    expect(await store.isHealthy()).toBeUndefined();
  });

  it('refuses before open()', async () => {
    const store = new PgVectorStore({ db: recordingDb().db });
    await expect(store.isHealthy()).rejects.toThrow('open() must run before any other call');
  });
});
