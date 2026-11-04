/**
 * The memory adapter is the conformance oracle: exact cosine scores, ties
 * broken by id, filters evaluated by declared type, scopes kept apart.
 */
import { describe, expect, it } from 'vitest';
import type { VectorCollectionSpec } from '@setu-ts/common';
import { MemoryVectorStore } from '../../src/adapters/memory/memory-vector-store.ts';

const spec: VectorCollectionSpec = Object.freeze({
  name: 'documents',
  dimensions: 2,
  filterable: Object.freeze({ tag: 'string', year: 'number', public: 'boolean' }),
});

async function seeded(): Promise<MemoryVectorStore> {
  const store = new MemoryVectorStore();
  await store.open();
  await store.ensureCollection(spec);
  await store.ensureCollection(spec);
  await store.upsert(spec, 'tenant-a', [
    {
      id: 'a1',
      vector: [1, 0],
      sourceId: 's1',
      content: 'one',
      metadata: { tag: 'x', year: 2020, public: true },
    },
    {
      id: 'a2',
      vector: [0.6, 0.8],
      sourceId: 's1',
      metadata: { tag: 'y', year: 2022, public: false },
    },
    { id: 'a3', vector: [0, 1], sourceId: 's2', metadata: { tag: 'x', year: 2024 } },
    { id: 'a0', vector: [1, 0], metadata: {} },
  ]);
  await store.upsert(spec, 'tenant-b', [{ id: 'a1', vector: [1, 0], metadata: { tag: 'x' } }]);
  return store;
}

describe('MemoryVectorStore', () => {
  it('orders by cosine similarity, then id, and returns stored fields', async () => {
    const store = await seeded();
    const matches = await store.query(spec, 'tenant-a', { vector: [1, 0], topK: 3 });
    expect(matches.map((m) => m.id)).toEqual(['a0', 'a1', 'a2']);
    expect(matches[0]!.score).toBeCloseTo(1, 10);
    expect(matches[2]!.score).toBeCloseTo(0.6, 10);
    expect(matches[1]).toEqual({
      id: 'a1',
      score: 1,
      sourceId: 's1',
      content: 'one',
      metadata: { tag: 'x', year: 2020, public: true },
    });
    expect(matches[0]).toEqual({ id: 'a0', score: 1, metadata: {} });
  });

  it('applies each operator and minScore', async () => {
    const store = await seeded();
    const ids = async (
      filter: Parameters<MemoryVectorStore['query']>[2]['filter'],
      minScore?: number,
    ) =>
      (
        await store.query(spec, 'tenant-a', {
          vector: [1, 1],
          topK: 10,
          ...(filter === undefined ? {} : { filter }),
          ...(minScore === undefined ? {} : { minScore }),
        })
      )
        .map((m) => m.id)
        .sort();
    expect(await ids({ field: 'tag', op: 'eq', value: 'x' })).toEqual(['a1', 'a3']);
    expect(await ids({ field: 'tag', op: 'in', value: ['y', 'z'] })).toEqual(['a2']);
    expect(await ids({ field: 'year', op: 'gt', value: 2020 })).toEqual(['a2', 'a3']);
    expect(await ids({ field: 'year', op: 'gte', value: 2022 })).toEqual(['a2', 'a3']);
    expect(await ids({ field: 'year', op: 'lt', value: 2022 })).toEqual(['a1']);
    expect(await ids({ field: 'year', op: 'lte', value: 2022 })).toEqual(['a1', 'a2']);
    expect(await ids({ field: 'public', op: 'eq', value: false })).toEqual(['a2']);
    expect(
      await ids({
        and: [
          { field: 'tag', op: 'eq', value: 'x' },
          { field: 'year', op: 'gt', value: 2021 },
        ],
      }),
    ).toEqual(['a3']);
    // A record without the field never matches a comparison on it.
    expect(await ids({ field: 'year', op: 'lt', value: 9999 })).not.toContain('a0');
    expect(await ids(undefined, 0.98)).toEqual(['a2']);
  });

  it('keeps scopes apart for reads and writes', async () => {
    const store = await seeded();
    expect(
      (await store.query(spec, 'tenant-b', { vector: [1, 0], topK: 10 })).map((m) => m.id),
    ).toEqual(['a1']);
    expect(await store.query(spec, 'tenant-none', { vector: [1, 0], topK: 10 })).toEqual([]);
    await store.delete(spec, 'tenant-b', ['a1']);
    expect(
      (await store.query(spec, 'tenant-a', { vector: [1, 0], topK: 10 })).map((m) => m.id),
    ).toContain('a1');
    await store.delete(spec, 'tenant-none', ['a1']);
    await store.deleteScope(spec, 'tenant-a');
    expect(await store.query(spec, 'tenant-a', { vector: [1, 0], topK: 10 })).toEqual([]);
  });

  it('replaceSource writes the new set and removes only that source’s stale records', async () => {
    const store = await seeded();
    await store.replaceSource(spec, 'tenant-a', 's1', [
      { id: 'a1', vector: [1, 0], sourceId: 's1', metadata: {} },
    ]);
    await store.replaceSource(spec, 'tenant-a', 's1', [
      { id: 'a1', vector: [1, 0], sourceId: 's1', metadata: {} },
    ]);
    const ids = (await store.query(spec, 'tenant-a', { vector: [1, 1], topK: 10 }))
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['a0', 'a1', 'a3']);
    await store.replaceSource(spec, 'tenant-new', 's9', []);
  });

  it('copies stored values so callers cannot change them later', async () => {
    const store = new MemoryVectorStore();
    await store.ensureCollection(spec);
    const vector = [1, 0];
    const metadata = { tag: 'x' };
    await store.upsert(spec, 't', [{ id: 'r', vector, metadata }]);
    vector[0] = 0;
    metadata.tag = 'changed';
    const [match] = await store.query(spec, 't', { vector: [1, 0], topK: 1 });
    expect(match).toEqual({ id: 'r', score: 1, metadata: { tag: 'x' } });
  });

  it('works on a collection it was never asked to ensure, and closes', async () => {
    let closed = 0;
    const store = new MemoryVectorStore({ onClose: () => void closed++ });
    expect(await store.query(spec, 't', { vector: [1, 0], topK: 1 })).toEqual([]);
    await store.deleteScope(spec, 't');
    await store.close();
    await new MemoryVectorStore().close();
    expect(closed).toBe(1);
  });
});
