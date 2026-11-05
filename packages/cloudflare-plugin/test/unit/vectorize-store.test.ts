/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The Vectorize adapter against a fake binding that implements only the
 * documented semantics of the current `Vectorize` API, each cited:
 *
 * - namespaces are applied before metadata filters
 *   (developers.cloudflare.com/vectorize/reference/metadata-filtering/);
 * - a filter is an implicit AND of `{ field: { $op: value } }` objects with
 *   `$eq $ne $lt $lte $gt $gte $in $nin` (same page);
 * - vector ids are unique per INDEX, not per namespace (/platform/limits/:
 *   "Maximum vector ID length" is per index; upsert replaces by id);
 * - `describe()` reports dimensions, not the metric (workers-types
 *   `VectorizeIndexInfo`).
 *
 * The fake applies writes synchronously; the real service does not, so no
 * live test reads its own write.
 */
import { describe, expect, it } from 'vitest';
import {
  VectorCollectionMismatchError,
  VectorFilterError,
  VectorOperationUnsupportedError,
  vectorRecordKey,
} from '@setu-ts/common';
import type { IRuntimeServices, VectorCollectionSpec } from '@setu-ts/common';
import { translateFilter, VectorizeVectorStore } from '../../src/vectorize/vectorize-store.ts';
import type {
  VectorizeIndexLike,
  VectorizeVectorLike,
} from '../../src/vectorize/vectorize-store.ts';

const runtime = { subtle: globalThis.crypto.subtle } as IRuntimeServices;
const spec: VectorCollectionSpec = Object.freeze({
  name: 'documents',
  dimensions: 2,
  filterable: Object.freeze({ tag: 'string', year: 'number' }),
});

function matches(value: unknown, condition: Record<string, unknown>): boolean {
  return Object.entries(condition).every(([op, operand]) => {
    switch (op) {
      case '$eq':
        return value === operand;
      case '$in':
        return (operand as unknown[]).includes(value);
      case '$gt':
        return typeof value === 'number' && value > (operand as number);
      case '$gte':
        return typeof value === 'number' && value >= (operand as number);
      case '$lt':
        return typeof value === 'number' && value < (operand as number);
      case '$lte':
        return typeof value === 'number' && value <= (operand as number);
      default:
        throw new Error(`fake: unexpected operator ${op}`);
    }
  });
}

function fakeIndex(
  dimensions = 2,
): VectorizeIndexLike & { readonly vectors: Map<string, VectorizeVectorLike> } {
  const vectors = new Map<string, VectorizeVectorLike>();
  return {
    vectors,
    async describe() {
      return { dimensions };
    },
    async query(vector, options) {
      const norm = Math.hypot(...vector);
      const found = [...vectors.values()]
        .filter((v) => (v.namespace ?? '') === options.namespace)
        .filter((v) =>
          Object.entries(options.filter ?? {}).every(([field, condition]) =>
            matches(v.metadata?.[field], condition as Record<string, unknown>),
          ),
        )
        .map((v) => ({
          id: v.id,
          score:
            v.values.reduce((sum, x, i) => sum + x * vector[i]!, 0) /
            (norm * Math.hypot(...v.values)),
          metadata: { ...v.metadata },
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches: found };
    },
    async upsert(batch) {
      for (const v of batch) vectors.set(v.id, v);
      return { mutationId: 'm' };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: 'm' };
    },
  };
}

async function opened(index = fakeIndex()) {
  const store = new VectorizeVectorStore({ index });
  await store.open(runtime);
  await store.ensureCollection(spec);
  return { store, index };
}

describe('VectorizeVectorStore', () => {
  it('refuses a binding missing a method, and calls before open()', async () => {
    expect(() => new VectorizeVectorStore({ index: {} as never })).toThrow('missing describe');
    expect(() => new VectorizeVectorStore(undefined as never)).toThrow('missing index');
    const unopened = new VectorizeVectorStore({ index: fakeIndex() });
    await expect(unopened.query(spec, 't', { vector: [1, 0], topK: 1 })).rejects.toThrow(
      'ensureCollection() must run',
    );
    await unopened.ensureCollection(spec);
    await expect(unopened.delete(spec, 't', ['r'])).rejects.toThrow('open() must run');
  });

  it('serves one collection: a second name is refused at ensure and on every data call', async () => {
    const { store, index } = await opened();
    const notes: VectorCollectionSpec = { ...spec, name: 'notes' };
    await expect(store.ensureCollection(notes)).rejects.toThrow(
      "collection 'notes' needs its own index (this one serves 'documents')",
    );
    await store.ensureCollection(spec);
    for (const call of [
      () => store.upsert(notes, 't', [{ id: 'r1', vector: [1, 0], metadata: {} }]),
      () => store.query(notes, 't', { vector: [1, 0], topK: 1 }),
      () => store.delete(notes, 't', ['r1']),
    ]) {
      await expect(call()).rejects.toThrow(VectorOperationUnsupportedError);
    }
    expect(index.vectors.size).toBe(0);
  });

  it('verifies dimensions through describe() and refuses more than 1,536', async () => {
    const { store } = await opened();
    await store.ensureCollection(spec);
    await expect(store.ensureCollection({ ...spec, dimensions: 3 })).rejects.toThrow(
      VectorCollectionMismatchError,
    );
    await expect(store.ensureCollection({ ...spec, dimensions: 1537 })).rejects.toThrow(
      VectorOperationUnsupportedError,
    );
  });

  it('stores scope-hashed ids in the scope namespace, so equal ids in two scopes never collide', async () => {
    const { store, index } = await opened();
    await store.upsert(spec, 'tenant-a', [
      { id: 'doc', vector: [1, 0], sourceId: 's1', content: 'a text', metadata: { tag: 'x' } },
    ]);
    await store.upsert(spec, 'tenant-b', [{ id: 'doc', vector: [0, 1], metadata: { tag: 'y' } }]);
    expect(index.vectors.size).toBe(2);
    const stored = index.vectors.get(await vectorRecordKey(runtime.subtle, 'tenant-a', 'doc'))!;
    expect(stored).toEqual({
      id: await vectorRecordKey(runtime.subtle, 'tenant-a', 'doc'),
      values: [1, 0],
      namespace: 'tenant-a',
      metadata: { tag: 'x', _id: 'doc', _source: 's1', _content: 'a text' },
    });
    const a = await store.query(spec, 'tenant-a', { vector: [1, 0], topK: 5 });
    expect(a).toEqual([
      { id: 'doc', score: 1, sourceId: 's1', content: 'a text', metadata: { tag: 'x' } },
    ]);
    const b = await store.query(spec, 'tenant-b', { vector: [1, 0], topK: 5 });
    expect(b.map((m) => [m.id, m.metadata])).toEqual([['doc', { tag: 'y' }]]);
  });

  it('applies filters, minScore and the portable tie order', async () => {
    const { store } = await opened();
    await store.upsert(spec, 't', [
      { id: 'b', vector: [1, 0], metadata: { tag: 'x', year: 2020 } },
      { id: 'a', vector: [1, 0], metadata: { tag: 'x', year: 2022 } },
      { id: 'c', vector: [0, 1], metadata: { tag: 'y', year: 2024 } },
    ]);
    expect((await store.query(spec, 't', { vector: [1, 0], topK: 5 })).map((m) => m.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const filtered = await store.query(spec, 't', {
      vector: [1, 0],
      topK: 5,
      filter: {
        and: [
          { field: 'tag', op: 'in', value: ['x', 'y'] },
          { field: 'year', op: 'gte', value: 2021 },
          { field: 'year', op: 'lt', value: 2024 },
        ],
      },
    });
    expect(filtered.map((m) => m.id)).toEqual(['a']);
    expect(
      (await store.query(spec, 't', { vector: [1, 0], topK: 5, minScore: 0.5 })).map((m) => m.id),
    ).toEqual(['a', 'b']);
  });

  it('falls back to the stored id when metadata lacks one', async () => {
    const index = fakeIndex();
    index.vectors.set('raw', { id: 'raw', values: [1, 0], namespace: 't' });
    const { store } = await opened(index);
    expect(await store.query(spec, 't', { vector: [1, 0], topK: 1 })).toEqual([
      { id: 'raw', score: 1, metadata: {} },
    ]);
  });

  it('maps a match without metadata to its stored id and keeps equal matches stable', async () => {
    const index = fakeIndex();
    index.query = async () => ({
      matches: [
        { id: 'stored', score: 0.5 },
        { id: 'stored', score: 0.5 },
      ],
    });
    const { store } = await opened(index);
    expect(await store.query(spec, 't', { vector: [1, 0], topK: 2 })).toEqual([
      { id: 'stored', score: 0.5, metadata: {} },
      { id: 'stored', score: 0.5, metadata: {} },
    ]);
  });

  it('deletes by scope-hashed ids only', async () => {
    const { store, index } = await opened();
    await store.upsert(spec, 'tenant-a', [{ id: 'doc', vector: [1, 0] }]);
    await store.upsert(spec, 'tenant-b', [{ id: 'doc', vector: [1, 0] }]);
    await store.delete(spec, 'tenant-b', ['doc']);
    expect([...index.vectors.keys()]).toEqual([
      await vectorRecordKey(runtime.subtle, 'tenant-a', 'doc'),
    ]);
  });

  it('refuses replaceSource and deleteScope by name', async () => {
    const { store } = await opened();
    await expect(store.replaceSource()).rejects.toThrow(VectorOperationUnsupportedError);
    await expect(store.deleteScope()).rejects.toThrow(VectorOperationUnsupportedError);
  });

  it('calls onClose once', async () => {
    let closed = 0;
    await new VectorizeVectorStore({ index: fakeIndex(), onClose: () => void closed++ }).close();
    await new VectorizeVectorStore({ index: fakeIndex() }).close();
    expect(closed).toBe(1);
  });
});

describe('Vectorize filter translation', () => {
  it('merges different operators on one field into one object', () => {
    expect(
      translateFilter({
        and: [
          { field: 'year', op: 'gt', value: 1 },
          { field: 'year', op: 'lte', value: 5 },
          { field: 'tag', op: 'eq', value: 'x' },
        ],
      }),
    ).toEqual({ year: { $gt: 1, $lte: 5 }, tag: { $eq: 'x' } });
  });

  it('refuses the same operator twice on one field, an over-size filter and unknown operators', () => {
    expect(() =>
      translateFilter({
        and: [
          { field: 'tag', op: 'eq', value: 'x' },
          { field: 'tag', op: 'eq', value: 'y' },
        ],
      }),
    ).toThrow(VectorFilterError);
    const big = {
      field: 'tag',
      op: 'in' as const,
      value: Array.from({ length: 100 }, (_, i) => `${'v'.repeat(40)}-${i}`),
    };
    expect(() => translateFilter(big)).toThrow('2 KB or more');
    expect(() => translateFilter({ field: 'tag', op: 'contains', value: 'x' } as never)).toThrow(
      "unsupported filter operator 'contains'",
    );
  });
});
