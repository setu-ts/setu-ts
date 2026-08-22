/**
 * X12-5 — the default adapter refuses an unknown `select` / `orderBy` column.
 *
 * Memory used to accept both silently: a projection quietly lost the field and
 * a sort quietly returned rows in insertion order, while Drizzle and Prisma
 * answered 500 for the identical call. Develop against the default, deploy
 * against a real backend, and each became a production failure.
 *
 * Only `select` and `orderBy` are checked. A `where` or `filter` on a column no
 * row carries is an ordinary "no row matches" query, and this adapter — which
 * is never given a schema — cannot tell an unknown column from one that is
 * absent everywhere.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NormalizedQuery } from '@setu-ts/common';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { unknownColumnError } from '../../src/query/query-builder.ts';

function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
  };
}

async function seeded(): Promise<MemoryAdapter> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  const source = adapter.createDataSource('Product');
  await source.create({ id: 'p1', name: 'Bolt', qty: 3 });
  await source.create({ id: 'p2', name: 'Nut', qty: 1 });
  return adapter;
}

describe('the observed column set', () => {
  it("is the union of every row's keys, not just the first row's", () => {
    // A sparse optional column appears on some rows and not others; treating
    // the first row as authoritative would reject a real column.
    const rows = [{ id: 'a' }, { id: 'b', deletedAt: 1 }];
    expect(unknownColumnError('Product', rows, query({ select: ['deletedAt'] })))
      .toBeUndefined();
  });

  it('reports every observed column in the diagnostic', () => {
    const rows = [{ id: 'a' }, { id: 'b', deletedAt: 1 }];
    expect(unknownColumnError('Product', rows, query({ select: ['sku'] }))?.message)
      .toContain('Known columns: deletedAt, id.');
  });
});

describe('unknownColumnError', () => {
  it('reports nothing when the query names no select or orderBy field', () => {
    expect(unknownColumnError('Product', [{ id: 'p1' }], query({ where: { anything: 1 } })))
      .toBeUndefined();
  });

  it('reports nothing when every named field is known', () => {
    expect(unknownColumnError('Product', [{ id: 'p1' }], query({ select: ['id'] })))
      .toBeUndefined();
  });

  it('names the entity, the clause and the field it rejected', () => {
    const error = unknownColumnError(
      'Product',
      [{ id: 'p1', name: 'Bolt' }],
      query({ select: ['sku'] }),
    );
    expect(error?.message).toContain("entity 'Product' has no 'sku' column for select.");
  });

  it('lists the columns it did observe, so the typo is visible', () => {
    const error = unknownColumnError(
      'Product',
      [{ id: 'p1', name: 'Bolt' }],
      query({ orderBy: { nme: 'asc' } }),
    );
    expect(error?.message).toContain('Known columns: id, name.');
  });

  it('returns rather than throws, so a Promise-returning caller can reject', () => {
    // A synchronous throw out of a method typed `Promise<...>` bypasses any
    // caller using `.catch()` — the defect class this repository has shipped
    // more than once, most recently in M52c and M52b.
    let returned: unknown = 'not-called';
    let threw = false;
    try {
      returned = unknownColumnError('Product', [{ id: 'p1' }], query({ select: ['sku'] }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(returned).toBeInstanceOf(Error);
  });
});

describe('MemoryAdapter column validation', () => {
  it('projects a known column', async () => {
    const adapter = await seeded();
    const rows = await adapter.createDataSource('Product').findAll(query({ select: ['name'] }));
    expect(rows).toEqual([{ name: 'Bolt' }, { name: 'Nut' }]);
  });

  it('refuses an unknown select column instead of dropping it silently', async () => {
    const adapter = await seeded();
    await expect(
      adapter.createDataSource('Product').findAll(query({ select: ['id', 'sku'] })),
    ).rejects.toThrow("has no 'sku' column for select");
  });

  it('orders by a known column', async () => {
    const adapter = await seeded();
    const rows = await adapter.createDataSource('Product').findAll(
      query({ orderBy: { qty: 'asc' } }),
    );
    expect(rows.map((row) => row.id)).toEqual(['p2', 'p1']);
  });

  it('refuses an unknown orderBy column instead of returning rows unordered', async () => {
    const adapter = await seeded();
    await expect(
      adapter.createDataSource('Product').findAll(query({ orderBy: { sku: 'desc' } })),
    ).rejects.toThrow("has no 'sku' column for orderBy");
  });

  it('accepts a column carried by only some rows', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Product');
    await source.create({ id: 'p1', name: 'Bolt' });
    await source.create({ id: 'p2', name: 'Nut', deletedAt: 12 });
    const rows = await source.findAll(query({ select: ['id', 'deletedAt'] }));
    expect(rows).toEqual([{ id: 'p1' }, { id: 'p2', deletedAt: 12 }]);
  });

  it('accepts any column against an empty store, where there is nothing to observe', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const rows = await adapter.createDataSource('Product').findAll(
      query({ select: ['whatever'], orderBy: { alsoWhatever: 'asc' } }),
    );
    expect(rows).toEqual([]);
  });

  it('leaves where and filter unchecked, so an unknown field still matches nothing', async () => {
    const adapter = await seeded();
    const source = adapter.createDataSource('Product');
    expect(await source.findAll(query({ where: { sku: 'X' } }))).toEqual([]);
    expect(
      await source.findAll(query({
        filter: { type: 'comparison', field: 'sku', operator: 'eq', value: 'X' },
      })),
    ).toEqual([]);
    expect(await source.count({ sku: 'X' })).toBe(0);
  });

  describe('inside a transaction overlay', () => {
    it('refuses an unknown select column on the overlay read path', async () => {
      const adapter = await seeded();
      const txn = await adapter.beginTransaction();
      await expect(
        txn.createDataSource('Product').findAll(query({ select: ['sku'] })),
      ).rejects.toThrow("has no 'sku' column for select");
      await txn.rollback();
    });

    it('refuses an unknown orderBy column on the overlay read path', async () => {
      const adapter = await seeded();
      const txn = await adapter.beginTransaction();
      await expect(
        txn.createDataSource('Product').findAll(query({ orderBy: { sku: 'asc' } })),
      ).rejects.toThrow("has no 'sku' column for orderBy");
      await txn.rollback();
    });

    it('counts a column created inside the transaction as known', async () => {
      const adapter = await seeded();
      const txn = await adapter.beginTransaction();
      const source = txn.createDataSource('Product');
      await source.create({ id: 'p3', name: 'Washer', sku: 'W-1' });
      const rows = await source.findAll(query({ select: ['id', 'sku'] }));
      expect(rows).toContainEqual({ id: 'p3', sku: 'W-1' });
      await txn.rollback();
    });

    it('accepts any column against an empty overlay', async () => {
      const adapter = new MemoryAdapter();
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      expect(
        await txn.createDataSource('Product').findAll(query({ select: ['whatever'] })),
      ).toEqual([]);
      await txn.rollback();
    });
  });
});
