/**
 * Unit tests for MemoryAdapter — composite keys (T2).
 *
 * Tests cover:
 * - composite store matching (findById/update/delete on a two-column key)
 * - overlay semantics with a composite key (update shadow, delete tombstone, commit/rollback)
 * - scalar store is byte-identical to pre-T2 behavior (pinned regression cases)
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IAdapterTransaction } from '@setu-ts/common';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('MemoryAdapter — composite keys', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('composite store matching', () => {
    it('findEntityById matches on every named column', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
      await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob' });
      await ds.create({ tenantId: 't2', userId: 'u1', name: 'Carol' });

      const found = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(found?.name).toBe('Alice');

      const missing = await ds.findById({ tenantId: 't2', userId: 'u2' });
      expect(missing).toBeNull();
    });

    it('findEntityById is order-independent for composite keys', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      // Record literal property order differs but should match the same row.
      const found = await ds.findById({ userId: 'u1', tenantId: 't1' });
      expect(found?.name).toBe('Alice');
    });

    it('updateEntity merges on composite key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice', active: true });

      const updated = await ds.update({ tenantId: 't1', userId: 'u1' }, { name: 'Alicia' });
      expect(updated.name).toBe('Alicia');
      expect(updated.active).toBe(true);

      const found = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(found?.name).toBe('Alicia');
    });

    it('updateEntity rejects when composite row is absent', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      await expect(
        ds.update({ tenantId: 't2', userId: 'u9' }, { name: 'X' }),
      ).rejects.toThrow('not found');
    });

    it('deleteEntity removes on composite key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });
      await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob' });

      const deleted = await ds.delete({ tenantId: 't1', userId: 'u1' });
      expect(deleted).toBe(true);

      const remaining = await ds.findAll({
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(remaining.length).toBe(1);
      expect(remaining[0].name).toBe('Bob');
    });

    it('deleteEntity returns false when composite row is absent', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const deleted = await ds.delete({ tenantId: 't2', userId: 'u9' });
      expect(deleted).toBe(false);
    });
  });

  describe('overlay semantics with composite key', () => {
    it('update shadow in tx is visible inside tx and restored after rollback', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await txDs.update({ tenantId: 't1', userId: 'u1' }, { name: 'Updated' });

      const inside = await txDs.findById({ tenantId: 't1', userId: 'u1' });
      expect(inside?.name).toBe('Updated');

      await txn.rollback();
      const outside = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(outside?.name).toBe('Alice');
    });

    it('delete tombstone in tx is invisible after rollback', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await txDs.delete({ tenantId: 't1', userId: 'u1' });

      const inside = await txDs.findById({ tenantId: 't1', userId: 'u1' });
      expect(inside).toBeNull();

      await txn.rollback();
      const outside = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(outside?.name).toBe('Alice');
    });

    it('commit flushes a composite tombstone and removes the committed row', async () => {
      // The commit path re-parses each composite tombstone key back into its
      // named columns (string and numeric values take different parse arms).
      await adapter.connect();
      const ds = adapter.createDataSource('Item', ['tenantId', 'position']);
      await ds.create({ tenantId: 't1', position: 7, name: 'Keep' });
      await ds.create({ tenantId: 't1', position: 8, name: 'Drop' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('Item');
      await txDs.delete({ tenantId: 't1', position: 8 });
      await txn.commit();

      const remaining = await ds.findAll({
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(remaining.map((r) => r.name)).toEqual(['Keep']);
    });

    it('commit applies composite overlay to committed store', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      await txDs.update({ tenantId: 't1', userId: 'u1' }, { name: 'Committed' });
      await txn.commit();

      const outside = await ds.findById({ tenantId: 't1', userId: 'u1' });
      expect(outside?.name).toBe('Committed');
    });

    it('overlay findAll honors a where filter on composite key', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['tenantId', 'userId']);
      await ds.create({ tenantId: 't1', userId: 'u1', name: 'Alice', role: 'admin' });
      await ds.create({ tenantId: 't1', userId: 'u2', name: 'Bob', role: 'user' });

      const txn = await adapter.beginTransaction();
      const txDs: DataSource = (txn as IAdapterTransaction).createDataSource('User');
      const admins = await txDs.findAll({
        where: { role: 'admin' },
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(admins.map((r) => r.name)).toEqual(['Alice']);
      await txn.rollback();
    });
  });

  describe('scalar store — regression cases', () => {
    it('findEntityById with scalar key is unchanged', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const found = await adapter.findEntityById('User', '1');
      expect(found?.name).toBe('Alice');
      const missing = await adapter.findEntityById('User', '999');
      expect(missing).toBeNull();
    });

    it('updateEntity with scalar key is unchanged', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Bob' });
      expect(updated.name).toBe('Bob');
    });

    it('deleteEntity with scalar key is unchanged', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      expect(await adapter.deleteEntity('User', '1')).toBe(true);
      expect(await adapter.deleteEntity('User', '1')).toBe(false);
    });

    it('createDataSource defaults primaryKey to ["id"]', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User');
      await ds.create({ id: '1', name: 'Alice' });
      const found = await ds.findById('1');
      expect(found?.name).toBe('Alice');
    });

    it('getStore with string primaryKey creates a scalar store', async () => {
      await adapter.connect();
      const store = adapter.getStore('User', 'id');
      expect(store.primaryKey).toEqual(['id']);
    });

    it('getStore with array primaryKey creates a composite store', async () => {
      await adapter.connect();
      const store = adapter.getStore('User', ['tenantId', 'userId']);
      expect(store.primaryKey).toEqual(['tenantId', 'userId']);
    });
  });

  describe('overlayKey composition', () => {
    it('produces the same key regardless of record property order', async () => {
      await adapter.connect();
      const ds = adapter.createDataSource('User', ['a', 'b']);
      await ds.create({ a: 'x', b: 'y', v: 1 });

      // Both orders should find the same row.
      const found1 = await ds.findById({ a: 'x', b: 'y' });
      const found2 = await ds.findById({ b: 'y', a: 'x' });
      expect(found1).not.toBeNull();
      expect(found2).not.toBeNull();
      expect(found1).toEqual(found2);
    });
  });
});

describe('transaction overlay preserves key identity (CodeRabbit #3896481569)', () => {
  /**
   * The tombstone commit path used to reconstruct the key from the overlay's
   * own map key, coercing any numeric-looking segment with `Number()`. A
   * STRING key such as '42' came back as the number 42, matched no record, and
   * the delete silently survived commit — the row was still there.
   */
  it('commits a delete for a numeric-LOOKING string key', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Doc');
    await source.create({ id: '42', title: 'forty-two' });
    await source.create({ id: '0042', title: 'padded' });

    const tx = await adapter.beginTransaction();
    expect(await tx.createDataSource('Doc').delete('42')).toBe(true);
    await tx.commit();

    expect(await source.findById('42')).toBeNull();
    // The padded sibling is untouched: '0042' and '42' are different keys, and
    // numeric coercion would have collapsed them.
    expect(await source.findById('0042')).not.toBeNull();
  });

  it('commits a delete for a composite key whose values contain the delimiters', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource('Pair', ['a', 'b']);
    await source.create({ a: 'x=1|y', b: '2', v: 'first' });
    await source.create({ a: 'x', b: '1|y=2', v: 'second' });

    const tx = await adapter.beginTransaction();
    expect(await tx.createDataSource('Pair').delete({ a: 'x=1|y', b: '2' })).toBe(true);
    await tx.commit();

    expect(await source.findById({ a: 'x=1|y', b: '2' })).toBeNull();
    expect(await source.findById({ a: 'x', b: '1|y=2' })).not.toBeNull();
  });
});

describe('memory findPage honours the resolved keyset sort in the projected path', () => {
  /**
   * The projected path used to be a full re-run of the pipeline, and the
   * keyset-sort fix reached only the unprojected copy — so a `findPage`
   * carrying a non-empty `select` ordered by `query.orderBy` while its
   * predicate was expanded over `orderBy` + the key columns. On a tied sort
   * key the two disagree and the walk skips or repeats rows.
   *
   * The tie group is deliberately seeded DESCENDING by id, so ordering
   * without the key tiebreaker does NOT coincide with the order the predicate
   * assumes — the vacuity trap the five-source conformance fixture fell into.
   */
  it('walks a tied fixture with a projection, returning every row exactly once', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('Widget');
    // Two tie groups of three, each seeded in DESCENDING id order.
    for (const id of ['a3', 'a2', 'a1']) await ds.create({ id, score: 10, note: `n-${id}` });
    for (const id of ['b3', 'b2', 'b1']) await ds.create({ id, score: 20, note: `n-${id}` });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const result = await ds.findPage!({
        where: {},
        orderBy: { score: 'asc' },
        limit: 2,
        offset: 0,
        // The projection is the whole point: this is the branch the earlier
        // build left ordering by the unresolved sort.
        select: ['id', 'note'],
        ...(cursor === null ? {} : { cursor }),
      });
      pages += 1;
      seen.push(...result.rows.map((r) => String(r.id)));
      // The caller's projection is what comes back — the key column is here
      // only because it was asked for, and `score` is absent.
      for (const row of result.rows) {
        expect(Object.keys(row).sort()).toEqual(['id', 'note']);
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect([...seen].sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBe(3);
  });

  it('mints a cursor from a projection naming neither the sort nor the key', async () => {
    // The cursor is minted from the UNPROJECTED rows, so a projection that
    // names neither the ordered column nor the key column can still page.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('Widget');
    for (const id of ['a3', 'a2', 'a1']) await ds.create({ id, score: 10, note: `n-${id}` });
    for (const id of ['b2', 'b1']) await ds.create({ id, score: 20, note: `n-${id}` });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await ds.findPage!({
        where: {},
        orderBy: { score: 'asc' },
        limit: 2,
        offset: 0,
        select: ['note'],
        ...(cursor === null ? {} : { cursor }),
      });
      for (const row of result.rows) {
        expect(Object.keys(row)).toEqual(['note']);
        seen.push(String(row.note));
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect([...seen].sort()).toEqual(['n-a1', 'n-a2', 'n-a3', 'n-b1', 'n-b2']);
  });
});

describe('memory findPage applies the caller where (outside-diff review, M79)', () => {
  /**
   * `findPageInternal` applied the cursor predicate and `query.filter` but NOT
   * `query.where`, while `findAll` applied all three — so a page scoped by
   * tenant, owner or role returned rows outside the caller's own criteria.
   * More rows than asked for, so no assertion on a row COUNT alone would
   * necessarily have caught it.
   */
  it('returns only rows matching where, as findAll does', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('W');
    await ds.create({ id: 'u1', role: 'admin' });
    await ds.create({ id: 'u2', role: 'user' });
    await ds.create({ id: 'u3', role: 'admin' });

    const page = await ds.findPage!({
      where: { role: 'admin' },
      orderBy: { id: 'asc' },
      limit: 10,
      offset: 0,
      select: [],
    });
    expect(page.rows.map((r) => r.id)).toEqual(['u1', 'u3']);
    // The two read paths agree, which is the property that was broken.
    const all = await ds.findAll({
      where: { role: 'admin' },
      orderBy: { id: 'asc' },
      limit: -1,
      offset: 0,
      select: [],
    });
    expect(page.rows.map((r) => r.id)).toEqual(all.map((r) => r.id));
  });

  it('conjoins where with the keyset predicate across a walk', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('W');
    for (const i of [1, 2, 3, 4, 5, 6]) {
      await ds.create({ id: `u${i}`, role: i % 2 === 0 ? 'user' : 'admin', score: i });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await ds.findPage!({
        where: { role: 'admin' },
        orderBy: { score: 'asc' },
        limit: 2,
        offset: 0,
        select: [],
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...result.rows.map((r) => String(r.id)));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    // Only the three admins, each once — the where survives paging.
    expect(seen).toEqual(['u1', 'u3', 'u5']);
  });
});

describe('overlay keys are collision-free (outside-diff review, M79)', () => {
  /** Every row currently visible, whether inside a transaction or not. */
  async function visible(
    source: { findAll: (q: never) => Promise<Record<string, unknown>[]> },
  ): Promise<Record<string, unknown>[]> {
    return await source.findAll(
      { where: {}, orderBy: {}, limit: -1, offset: 0, select: [] } as never,
    );
  }

  it('distinguishes a string key from the numerically equal number key', async () => {
    // Record lookup compares with `===`, so `'42'` and `42` are different
    // rows — but both encoded to `W::42`, so deleting one hid BOTH inside the
    // transaction and then committed a delete for only one. The transaction
    // reported a state that never existed.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('W');
    await ds.create({ id: '42', tag: 'string-key' });
    await ds.create({ id: 42, tag: 'number-key' });

    const tx = await adapter.beginTransaction();
    const tds: DataSource = (tx as IAdapterTransaction).createDataSource('W');
    expect(await tds.delete('42')).toBe(true);
    expect((await visible(tds)).map((r) => r.tag)).toEqual(['number-key']);
    await tx.commit();
    expect((await visible(ds)).map((r) => r.tag)).toEqual(['number-key']);
  });

  it('does not let a delimiter inside a value forge a composite key', async () => {
    // `{ a: 'x|b=y', b: 'z' }` and `{ a: 'x', b: 'y|b=z' }` both encoded to
    // `W::a=x|b=y|b=z` under the old `col=value` join.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('W', ['a', 'b']);
    await ds.create({ a: 'x|b=y', b: 'z', tag: 'first' });
    await ds.create({ a: 'x', b: 'y|b=z', tag: 'second' });

    const tx = await adapter.beginTransaction();
    const tds: DataSource = (tx as IAdapterTransaction).createDataSource('W');
    expect(await tds.delete({ a: 'x|b=y', b: 'z' })).toBe(true);
    expect((await visible(tds)).map((r) => r.tag)).toEqual(['second']);
    await tx.commit();
    expect((await visible(ds)).map((r) => r.tag)).toEqual(['second']);
  });

  it('is independent of the caller key order, as record lookup is', async () => {
    // The key is canonicalized by the mapping's declared column order, not by
    // the caller's object-key order, so overlay identity agrees with lookup.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('W', ['a', 'b']);
    await ds.create({ a: 'p', b: 'q', tag: 'only' });

    const tx = await adapter.beginTransaction();
    const tds: DataSource = (tx as IAdapterTransaction).createDataSource('W');
    await tds.update({ b: 'q', a: 'p' }, { tag: 'updated' });
    expect((await visible(tds)).map((r) => r.tag)).toEqual(['updated']);
    await tx.commit();
    expect((await visible(ds)).map((r) => r.tag)).toEqual(['updated']);
  });

  it('keeps a partial composite key distinct from a complete one', async () => {
    // An absent column is tagged distinctly, so a partial key cannot encode to
    // the same string as a complete one and shadow a row it does not name.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const ds = adapter.createDataSource('W', ['a', 'b']);
    await ds.create({ a: 'p', b: 'q', tag: 'complete' });

    const tx = await adapter.beginTransaction();
    const tds: DataSource = (tx as IAdapterTransaction).createDataSource('W');
    // A partial key matches no record, so the delete reports false and the
    // overlay records nothing.
    expect(await tds.delete({ a: 'p' } as never)).toBe(false);
    expect((await visible(tds)).map((r) => r.tag)).toEqual(['complete']);
    await tx.commit();
    expect((await visible(ds)).map((r) => r.tag)).toEqual(['complete']);
  });
});
