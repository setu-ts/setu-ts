/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * One conformance table, as data, run through the validating service on every
 * adapter: memory (the oracle), the Vectorize fake, and — when `PGVECTOR_URL`
 * / `QDRANT_URL` are set — real pgvector and real Qdrant. Every read row
 * asserts the same ids in the same order and scores within 1e-4 of memory's;
 * tenant-leak rows assert scope B never sees scope A; operation rows cover
 * `replaceSource` re-run and shrink, `delete`, and `deleteScope` above 1,000
 * records. Vectorize's two unsupported operations are REFUSED cells.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { QdrantClient } from '@qdrant/js-client-rest';
import { VectorizeVectorStore } from '@setu-ts/cloudflare-plugin';
import { VectorOperationUnsupportedError, VectorVersionConflictError } from '@setu-ts/common';
import type {
  IRuntimeServices,
  IVectorStoreAdapter,
  VectorFilter,
  VectorMatch,
  VectorRecord,
} from '@setu-ts/common';
import { MemoryVectorStore } from '../../src/adapters/memory/memory-vector-store.ts';
import { PgVectorStore } from '../../src/adapters/pgvector/pgvector-store.ts';
import type { PgVectorDatabase } from '../../src/adapters/pgvector/pgvector-store.ts';
import { QdrantVectorStore } from '../../src/adapters/qdrant/qdrant-store.ts';
import type { QdrantClientLike } from '../../src/adapters/qdrant/qdrant-store.ts';
import { resolveCollections } from '../../src/services/collection-spec.ts';
import { VectorStoreService } from '../../src/services/vector-store-service.ts';
import { vectorizeFake } from '../fixtures/vectorize-fake.ts';

const PGVECTOR_URL = process.env['PGVECTOR_URL'];
const QDRANT_URL = process.env['QDRANT_URL'];
const runtime = { subtle: globalThis.crypto.subtle } as IRuntimeServices;
const RUN = Math.floor(Math.random() * 1e9).toString(36);
const COLLECTION = `conf_${RUN}`;
// `constructor` is the one Object.prototype member the field grammar admits;
// an accumulator built on `{}` once dropped its clause (M135 review).
const FILTERABLE = {
  tag: 'string',
  year: 'number',
  public: 'boolean',
  constructor: 'string',
} as const;

const A = 'tenant-a';
const B = 'tenant-b';
const QUERY = [1, 0, 0, 0];

/** Neighbouring scores differ by far more than 1e-3; a4 and a5 tie at 0. */
const SEED_A: readonly VectorRecord[] = [
  {
    id: 'a1',
    vector: [1, 0, 0, 0],
    sourceId: 's1',
    content: 'one',
    metadata: { tag: 'x', year: 2020, public: true },
  },
  {
    id: 'a2',
    vector: [0.8, 0.6, 0, 0],
    sourceId: 's1',
    metadata: { tag: 'y', year: 2021, public: false },
  },
  { id: 'a3', vector: [0.6, 0.8, 0, 0], sourceId: 's2', metadata: { tag: 'x', year: 2022 } },
  { id: 'a4', vector: [0, 1, 0, 0], metadata: { tag: 'z', year: 2023, public: true } },
  { id: 'a5', vector: [0, 0, 1, 0], metadata: { tag: 'x', year: 2024 } },
];
const SEED_B: readonly VectorRecord[] = [
  { id: 'a1', vector: [1, 0, 0, 0], metadata: { tag: 'b' } },
  { id: 'b2', vector: [0.9, 0.1, 0, 0], metadata: { tag: 'b' } },
];

interface ReadCase {
  readonly label: string;
  readonly scope?: string;
  readonly topK?: number;
  readonly filter?: VectorFilter;
  readonly minScore?: number;
  readonly expected: readonly string[];
}

const READS: readonly ReadCase[] = [
  { label: 'no filter, ties by id', expected: ['a1', 'a2', 'a3', 'a4', 'a5'] },
  { label: 'topK', topK: 2, expected: ['a1', 'a2'] },
  {
    label: 'string eq',
    filter: { field: 'tag', op: 'eq', value: 'x' },
    expected: ['a1', 'a3', 'a5'],
  },
  {
    label: 'string in',
    filter: { field: 'tag', op: 'in', value: ['y', 'z'] },
    expected: ['a2', 'a4'],
  },
  { label: 'number eq', filter: { field: 'year', op: 'eq', value: 2021 }, expected: ['a2'] },
  {
    label: 'number in',
    filter: { field: 'year', op: 'in', value: [2020, 2024] },
    expected: ['a1', 'a5'],
  },
  { label: 'gt', filter: { field: 'year', op: 'gt', value: 2021 }, expected: ['a3', 'a4', 'a5'] },
  {
    label: 'gte',
    filter: { field: 'year', op: 'gte', value: 2021 },
    expected: ['a2', 'a3', 'a4', 'a5'],
  },
  { label: 'lt', filter: { field: 'year', op: 'lt', value: 2022 }, expected: ['a1', 'a2'] },
  { label: 'lte', filter: { field: 'year', op: 'lte', value: 2022 }, expected: ['a1', 'a2', 'a3'] },
  {
    label: 'boolean eq true',
    filter: { field: 'public', op: 'eq', value: true },
    expected: ['a1', 'a4'],
  },
  {
    label: 'boolean eq false',
    filter: { field: 'public', op: 'eq', value: false },
    expected: ['a2'],
  },
  {
    label: 'and',
    filter: {
      and: [
        { field: 'tag', op: 'eq', value: 'x' },
        { field: 'year', op: 'gte', value: 2022 },
      ],
    },
    expected: ['a3', 'a5'],
  },
  { label: 'minScore', minScore: 0.7, expected: ['a1', 'a2'] },
  { label: 'tenant B sees only its own rows', scope: B, expected: ['a1', 'b2'] },
  {
    label: 'tenant B filter never reaches tenant A',
    scope: B,
    filter: { field: 'tag', op: 'eq', value: 'x' },
    expected: [],
  },
];

interface Arm {
  readonly name: string;
  readonly enabled: boolean;
  readonly refuses: ReadonlySet<'replaceSource' | 'deleteScope'>;
  create(): Promise<IVectorStoreAdapter>;
  cleanup?(): Promise<void>;
}

let pool: pg.Pool | undefined;
let qdrant: QdrantClient | undefined;

const ARMS: readonly Arm[] = [
  {
    name: 'memory',
    enabled: true,
    refuses: new Set(),
    create: async () => new MemoryVectorStore(),
  },
  {
    name: 'vectorize (fake)',
    enabled: true,
    refuses: new Set(['replaceSource', 'deleteScope']),
    create: async () => new VectorizeVectorStore({ index: vectorizeFake(4) }),
  },
  {
    name: 'pgvector',
    enabled: PGVECTOR_URL !== undefined,
    refuses: new Set(),
    create: async () => {
      pool = new pg.Pool({ connectionString: PGVECTOR_URL });
      return new PgVectorStore({ db: drizzle(pool) as unknown as PgVectorDatabase });
    },
    cleanup: async () => {
      await pool?.query(`DROP TABLE IF EXISTS "vs_${COLLECTION}"`);
      await pool?.end();
    },
  },
  {
    name: 'qdrant',
    enabled: QDRANT_URL !== undefined,
    refuses: new Set(),
    create: async () => {
      qdrant = new QdrantClient({ url: QDRANT_URL!, checkCompatibility: false });
      return new QdrantVectorStore({ client: qdrant as unknown as QdrantClientLike });
    },
    cleanup: async () => {
      await qdrant?.deleteCollection(`vs_${COLLECTION}`);
    },
  },
];

const collections = resolveCollections([
  { name: COLLECTION, dimensions: 4, filterable: FILTERABLE },
]);

async function storeFor(adapter: IVectorStoreAdapter): Promise<VectorStoreService> {
  await adapter.open(runtime);
  await adapter.ensureCollection(collections.get(COLLECTION)!.spec);
  return new VectorStoreService(adapter, collections, 'required');
}

async function read(store: VectorStoreService, c: ReadCase): Promise<readonly VectorMatch[]> {
  return await store.query(COLLECTION, c.scope ?? A, {
    vector: QUERY,
    topK: c.topK ?? 10,
    ...(c.filter === undefined ? {} : { filter: c.filter }),
    ...(c.minScore === undefined ? {} : { minScore: c.minScore }),
  });
}

const oracle = new Map<string, readonly VectorMatch[]>();

beforeAll(async () => {
  const store = await storeFor(new MemoryVectorStore());
  await store.upsert(COLLECTION, A, SEED_A);
  await store.upsert(COLLECTION, B, SEED_B);
  for (const c of READS) oracle.set(c.label, await read(store, c));
});

describe.each(ARMS.filter((arm) => arm.enabled).map((arm) => [arm.name, arm] as const))(
  'conformance: %s',
  (_name, arm) => {
    let store: VectorStoreService;

    beforeAll(async () => {
      store = await storeFor(await arm.create());
      await store.upsert(COLLECTION, A, SEED_A);
      await store.upsert(COLLECTION, B, SEED_B);
    });

    afterAll(async () => {
      await arm.cleanup?.();
    });

    it.each(READS.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
      const matches = await read(store, c);
      expect(matches.map((m) => m.id)).toEqual(c.expected);
      const expected = oracle.get(c.label)!;
      matches.forEach((match, i) => {
        expect(Math.abs(match.score - expected[i]!.score)).toBeLessThan(1e-4);
        expect(match.metadata).toEqual(expected[i]!.metadata);
        expect(match.sourceId).toBe(expected[i]!.sourceId);
        expect(match.content).toBe(expected[i]!.content);
      });
    });

    it('delete in one scope leaves the other scope’s same id', async () => {
      await store.delete(COLLECTION, B, ['a1']);
      const a = await read(store, { label: '', expected: [] });
      expect(a.map((m) => m.id)).toContain('a1');
      await store.upsert(COLLECTION, B, [SEED_B[0]!]);
    });

    it('replaceSource re-run leaves one copy, shrink removes stale chunks, other scopes untouched', async () => {
      const next: VectorRecord[] = [
        {
          id: 'a1',
          vector: [1, 0, 0, 0],
          sourceId: 's1',
          content: 'one',
          metadata: { tag: 'x', year: 2020, public: true },
        },
        { id: 'a6', vector: [0, 0, 0, 1], sourceId: 's1', metadata: { tag: 'w' } },
      ];
      if (arm.refuses.has('replaceSource')) {
        await expect(store.replaceSource(COLLECTION, A, 's1', next)).rejects.toThrow(
          VectorOperationUnsupportedError,
        );
        return;
      }
      await store.replaceSource(COLLECTION, A, 's1', next);
      await store.replaceSource(COLLECTION, A, 's1', next);
      const ids = (await read(store, { label: '', expected: [] })).map((m) => m.id).sort();
      expect(ids).toEqual(['a1', 'a3', 'a4', 'a5', 'a6']);
      expect((await read(store, { label: '', scope: B, expected: [] })).map((m) => m.id)).toEqual([
        'a1',
        'b2',
      ]);
    });

    it('versioned replaceSource refuses an older version and settles on the newest', async () => {
      const scope = 'tenant-versions';
      const chunks = (label: string, count: number): VectorRecord[] =>
        Array.from({ length: count }, (_, i) => ({
          id: `d${i}`,
          vector: [1, i + 1, 0, 0],
          sourceId: 'doc',
          content: label,
        }));
      const stored = async () =>
        (await read(store, { label: '', scope, expected: [] }))
          .map((m) => `${m.id}:${m.content}`)
          .sort();
      const write = (label: string, count: number, version?: number) =>
        store.replaceSource(
          COLLECTION,
          scope,
          'doc',
          chunks(label, count),
          version === undefined ? undefined : { version },
        );
      if (arm.refuses.has('replaceSource')) {
        await expect(write('v2', 3, 2)).rejects.toThrow(VectorOperationUnsupportedError);
        return;
      }
      await write('v2', 3, 2);
      // An older retry with MORE chunks writes nothing: no overwrite and no extra id.
      await expect(write('v1', 4, 1)).rejects.toThrow(VectorVersionConflictError);
      expect(await stored()).toEqual(['d0:v2', 'd1:v2', 'd2:v2']);
      // The same version again is a retry of the same submission and succeeds.
      await write('v2', 2, 2);
      expect(await stored()).toEqual(['d0:v2', 'd1:v2']);
      // Racing writes settle on the higher version, whichever lands first.
      const raced = await Promise.allSettled([write('v5', 2, 5), write('v4', 4, 4)]);
      expect(raced[0].status).toBe('fulfilled');
      expect(await stored()).toEqual(['d0:v5', 'd1:v5']);
      // An unversioned write leaves the source unversioned, so any version is accepted after it.
      await write('plain', 1);
      await write('v3', 1, 3);
      expect(await stored()).toEqual(['d0:v3']);
      // A newer version of ANOTHER source does not stop an id being reassigned.
      await store.replaceSource(
        COLLECTION,
        scope,
        'other',
        [{ id: 'd0', vector: [1, 1, 0, 0], sourceId: 'other', content: 'other' }],
        { version: 1 },
      );
      expect(await stored()).toEqual(['d0:other']);
    });

    it('filters on a field named constructor instead of dropping the clause', async () => {
      const scope = 'tenant-ctor';
      await store.upsert(COLLECTION, scope, [
        { id: 'c1', vector: [1, 0, 0, 0], metadata: { constructor: 'x', tag: 't' } },
        { id: 'c2', vector: [1, 0, 0, 0], metadata: { constructor: 'y', tag: 't' } },
      ]);
      const filter: VectorFilter = {
        and: [
          { field: 'constructor', op: 'eq', value: 'x' },
          { field: 'tag', op: 'eq', value: 't' },
        ],
      };
      const found = await store.query(COLLECTION, scope, { vector: QUERY, topK: 10, filter });
      expect(found.map((m) => m.id)).toEqual(['c1']);
    });

    it('scores a vector with a tiny norm by direction alone (audit R1)', async () => {
      const scope = 'tenant-tiny';
      await store.upsert(COLLECTION, scope, [{ id: 't1', vector: [1e-4, 1e-4, 0, 0] }]);
      const [match] = await store.query(COLLECTION, scope, { vector: [1e-4, 1e-4, 0, 0], topK: 1 });
      expect(match?.id).toBe('t1');
      expect(Math.abs(match!.score - 1)).toBeLessThan(1e-4);
    });

    it('breaks score ties by id in code-unit order, punctuation included', async () => {
      const scope = 'tenant-ties';
      const ids = ['ab#0', 'a-b#0', 'a#2', 'a-1', 'B'];
      await store.upsert(
        COLLECTION,
        scope,
        ids.map((id) => ({ id, vector: [1, 0, 0, 0] })),
      );
      const found = await store.query(COLLECTION, scope, { vector: QUERY, topK: 10 });
      expect(found.map((m) => m.id)).toEqual(['B', 'a#2', 'a-1', 'a-b#0', 'ab#0']);
    });

    it('deleteScope removes every record of one scope above 1,000 records and leaves others', async () => {
      const scope = 'tenant-bulk';
      if (arm.refuses.has('deleteScope')) {
        await expect(store.deleteScope(COLLECTION, scope)).rejects.toThrow(
          VectorOperationUnsupportedError,
        );
        return;
      }
      for (let batch = 0; batch < 3; batch++) {
        const size = batch < 2 ? 500 : 100;
        await store.upsert(
          COLLECTION,
          scope,
          Array.from({ length: size }, (_, i) => ({
            id: `bulk-${batch}-${i}`,
            vector: [1, (batch * 500 + i + 1) / 2000, 0, 0],
          })),
        );
      }
      expect(await read(store, { label: '', scope, topK: 50, expected: [] })).toHaveLength(50);
      await store.deleteScope(COLLECTION, scope);
      expect(await read(store, { label: '', scope, expected: [] })).toEqual([]);
      expect((await read(store, { label: '', scope: B, expected: [] })).length).toBe(2);
    });
  },
);
