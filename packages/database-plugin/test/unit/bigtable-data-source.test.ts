/**
 * The Bigtable data source, driven through the fake client.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDataSource, NormalizedQuery } from '@setu-ts/common';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { createBigtableDataSource } from '../../src/adapters/bigtable/bigtable-data-source.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import type { BigtableEntityMapping } from '../../src/adapters/bigtable/bigtable-mapping.ts';

/** Builds a fully-resolved query. */
function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
    ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
  };
}

/** Builds a store, a client and a data source over one entity. */
function setup(
  entity = 'User',
  mapping?: Readonly<Record<string, BigtableEntityMapping>>,
): { store: FakeBigtableStore; source: IDataSource; table: string } {
  const store = new FakeBigtableStore();
  const client = createFakeBigtableClient(store);
  const target = resolveBigtableTarget(entity, mapping);
  const source = createBigtableDataSource(
    client.instance('i').table(target.table),
    target,
  );
  return { store, source, table: target.table };
}

describe('create', () => {
  it('writes cells and reads them back with every type intact', async () => {
    const { source } = setup();
    const when = new Date('2026-08-31T00:00:00.000Z');
    await source.create({
      id: 'u1',
      name: 'ada',
      age: 36,
      active: true,
      joined: when,
      tags: ['x'],
    });
    const read = await source.findById('u1');
    expect(read).toEqual({
      id: 'u1',
      name: 'ada',
      age: 36,
      active: true,
      joined: when,
      tags: ['x'],
    });
  });

  it('keeps a NUMERIC key field a number, because its cell wins over the row key', async () => {
    const { source } = setup();
    await source.create({ id: 7, name: 'ada' });
    const read = await source.findById(7);
    expect(read?.id).toBe(7);
  });

  it('refuses to overwrite an existing row', async () => {
    const { source } = setup();
    await source.create({ id: 'u1', name: 'ada' });
    await expect(source.create({ id: 'u1', name: 'bob' })).rejects.toThrow(/does not overwrite/);
    expect((await source.findById('u1'))?.name).toBe('ada');
  });

  it('writes no cell for an undefined field but does write null', async () => {
    const { store, source, table } = setup();
    await source.create({ id: 'u1', missing: undefined, blank: null });
    const cells = store.snapshot(table, 'u1');
    expect(cells?.cf.missing).toBeUndefined();
    expect(cells?.cf.blank).toBe('z:');
    expect((await source.findById('u1'))?.blank).toBe(null);
  });

  it('refuses two fields that would share one qualifier', async () => {
    const { source } = setup('User', { User: { columns: { alias: 'cf:name' } } });
    await expect(source.create({ id: 'u1', name: 'ada', alias: 'a' }))
      .rejects.toThrow(UnsupportedQueryFeatureError);
  });
});

describe('findById', () => {
  it('answers null for an absent row', async () => {
    const { source } = setup();
    expect(await source.findById('nope')).toBe(null);
  });

  it('recovers key fields from the ROW KEY for a row written outside the framework', async () => {
    const { store, source } = setup('Order', {
      Order: { table: 'orders', rowKey: { fields: ['tenantId', 'orderId'] }, valueEncoding: 'raw' },
    });
    // No key cells at all — the interop shape.
    store.seed('orders', 't1#o9', { cf: { total: '42' } });
    expect(await source.findById({ tenantId: 't1', orderId: 'o9' })).toEqual({
      tenantId: 't1',
      orderId: 'o9',
      total: '42',
    });
  });
});

describe('update', () => {
  it('merges into an existing row and returns the merged result', async () => {
    const { source } = setup();
    await source.create({ id: 'u1', name: 'ada', age: 36 });
    const updated = await source.update('u1', { age: 37 });
    expect(updated).toEqual({ id: 'u1', name: 'ada', age: 37 });
  });

  it('refuses an absent row by name', async () => {
    const { source } = setup();
    await expect(source.update('nope', { age: 1 })).rejects.toThrow(/no row keyed 'nope'/);
  });

  it('refuses an empty payload against an absent row and returns the row otherwise', async () => {
    const { source } = setup();
    await expect(source.update('nope', {})).rejects.toThrow(/no row keyed/);
    await source.create({ id: 'u1', name: 'ada' });
    expect(await source.update('u1', {})).toEqual({ id: 'u1', name: 'ada' });
  });

  it('ignores a cell whose version list is empty', async () => {
    // A conformant service never answers with a versionless qualifier, but a
    // hand-written facade can, and reading `[0]` off it would be `undefined`.
    const { store, source } = setup();
    store.seed('User', 'u1', { cf: { id: 's:u1' } });
    const rows = store.tables.get('User') as Map<string, Map<string, Map<string, unknown[]>>>;
    (rows.get('u1') as Map<string, Map<string, unknown[]>>).get('cf')?.set('ghost', []);
    expect(await source.findById('u1')).toEqual({ id: 'u1' });
  });

  it('accepts a composite key restating its own values, and an undefined key field', async () => {
    const { source } = setup('Order', {
      Order: { table: 'orders', rowKey: { fields: ['tenantId', 'orderId'] } },
    });
    await source.create({ tenantId: 't1', orderId: 'o1', total: 1 });
    const key = { tenantId: 't1', orderId: 'o1' };
    expect(await source.update(key, { tenantId: 't1', total: 2 }))
      .toEqual({ tenantId: 't1', orderId: 'o1', total: 2 });
    // An explicitly-undefined key field is not a move; it writes no cell.
    expect(await source.update(key, { orderId: undefined, total: 3 }))
      .toEqual({ tenantId: 't1', orderId: 'o1', total: 3 });
    await expect(source.update(key, { tenantId: 't2' })).rejects.toThrow(/cannot move a row/);
  });

  it('refuses a payload that would move the row to a different key', async () => {
    const { source } = setup();
    await source.create({ id: 'u1', name: 'ada' });
    await expect(source.update('u1', { id: 'u2' })).rejects.toThrow(/cannot move a row/);
  });

  it('accepts a payload restating the SAME key value', async () => {
    const { source } = setup();
    await source.create({ id: 'u1', name: 'ada' });
    expect(await source.update('u1', { id: 'u1', name: 'bo' })).toEqual({ id: 'u1', name: 'bo' });
  });
});

describe('delete', () => {
  it('reports true for a row it removed and false for an absent one', async () => {
    const { source } = setup();
    await source.create({ id: 'u1' });
    expect(await source.delete('u1')).toBe(true);
    expect(await source.findById('u1')).toBe(null);
    expect(await source.delete('u1')).toBe(false);
  });
});

describe('findAll', () => {
  /** Seeds four users across two cities. */
  async function seedUsers(source: IDataSource): Promise<void> {
    await source.create({ id: 'u1', name: 'ada', age: 36, city: 'london' });
    await source.create({ id: 'u2', name: 'bob', age: 41, city: 'paris' });
    await source.create({ id: 'u3', name: 'cyd', age: 29, city: 'london' });
    await source.create({ id: 'u4', name: 'dee', age: 55, city: 'berlin' });
  }

  it('returns every row in row-key order', async () => {
    const { source } = setup();
    await seedUsers(source);
    expect((await source.findAll(query())).map((r) => r.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('answers a pushed-down equality with the WHOLE row, not only the matching cell', async () => {
    const { source } = setup();
    await seedUsers(source);
    const rows = await source.findAll(query({ where: { city: 'london' } }));
    expect(rows.map((r) => r.id)).toEqual(['u1', 'u3']);
    expect(rows[0]).toEqual({ id: 'u1', name: 'ada', age: 36, city: 'london' });
  });

  it('evaluates an ordered comparison client-side against decoded values', async () => {
    const { source } = setup();
    await seedUsers(source);
    const rows = await source.findAll(query({
      filter: { type: 'comparison', field: 'age', operator: 'gt', value: 35 },
    }));
    expect(rows.map((r) => r.id)).toEqual(['u1', 'u2', 'u4']);
  });

  it('projects to the selected fields after evaluating the filter', async () => {
    const { source } = setup();
    await seedUsers(source);
    const rows = await source.findAll(query({
      select: ['name'],
      filter: { type: 'comparison', field: 'city', operator: 'contains', value: 'lon' },
    }));
    expect(rows).toEqual([{ name: 'ada' }, { name: 'cyd' }]);
  });

  it('applies the limit client-side when the server could not be trusted with it', async () => {
    const { store, source } = setup();
    await seedUsers(source);
    store.reads.length = 0;
    const rows = await source.findAll(query({ limit: 1, where: { city: 'london' } }));
    expect(rows.map((r) => r.id)).toEqual(['u1']);
    expect(store.reads[0].options.limit).toBeUndefined();
  });

  it('keeps a row carrying NONE of the projected columns', async () => {
    // A filter that removes every cell of a row removes the ROW — the service
    // does not answer with an empty row — so a bare projection would silently
    // drop this row instead of returning it projected. Only reachable on a
    // table this adapter did not write, whose rows carry no key cell.
    const { store, source } = setup('Order', {
      Order: { table: 'orders', rowKey: { fields: ['id'] }, valueEncoding: 'raw' },
    });
    store.seed('orders', 'o1', { cf: { name: 'ada' } });
    store.seed('orders', 'o2', { cf: { other: 'x' } });
    const rows = await source.findAll(query({ select: ['name'] }));
    expect(rows).toEqual([{ name: 'ada' }, {}]);
  });

  it('answers a constraint on a field that cannot be a column, projected or not', async () => {
    // A `select` or `orderBy` naming an unusable identifier is refused, because
    // projecting or sorting by a column that cannot exist is meaningless. A
    // `where` or `filter` on one is an ordinary "no row matches" — and the two
    // read paths must AGREE, which they did not while the projected path
    // resolved constraint fields strictly and threw.
    const { source } = setup();
    await source.create({ id: 'u1', name: 'ada' });
    expect(await source.findAll(query({ where: { 'a b': 1 } }))).toEqual([]);
    expect(await source.findAll(query({ select: ['name'], where: { 'a b': 1 } }))).toEqual([]);
    expect(await source.count({ 'a b': 1 })).toBe(0);
    await expect(source.findAll(query({ select: ['a b'] }))).rejects.toThrow(
      /not a usable column identifier/,
    );
  });

  it('issues no read at all for a self-contradictory query', async () => {
    const { store, source } = setup();
    await seedUsers(source);
    store.reads.length = 0;
    expect(
      await source.findAll(query({
        where: { id: 'u1' },
        filter: { type: 'comparison', field: 'id', operator: 'eq', value: 'u2' },
      })),
    ).toEqual([]);
    expect(store.reads).toHaveLength(0);
  });
});

describe('count', () => {
  it('strips cell values when nothing needs them', async () => {
    const { store, source } = setup();
    await source.create({ id: 'u1' });
    await source.create({ id: 'u2' });
    store.reads.length = 0;
    expect(await source.count({})).toBe(2);
    expect(store.reads[0].options.filter).toEqual({ value: { strip: true } });
  });

  it('reads only the columns its predicate needs, never every column', async () => {
    const { store, source } = setup();
    await source.create({ id: 'u1', age: 30, bio: 'x'.repeat(64) });
    await source.create({ id: 'u2', age: 40, bio: 'y'.repeat(64) });
    store.reads.length = 0;
    expect(await source.count({}, { type: 'comparison', field: 'age', operator: 'gt', value: 35 }))
      .toBe(1);
    // On a wide-column store, shipping every column to answer a number IS the
    // cost of the operation.
    const filter = store.reads[0].options.filter as {
      interleave: readonly (readonly { column?: readonly string[] }[])[];
    };
    expect([...(filter.interleave[0][0].column as readonly string[])].sort())
      .toEqual(['age', 'id']);
  });

  it('counts an equality-scoped subset', async () => {
    const { source } = setup();
    await source.create({ id: 'u1', city: 'london' });
    await source.create({ id: 'u2', city: 'paris' });
    expect(await source.count({ city: 'london' })).toBe(1);
  });

  it('answers zero without a read for a contradictory count', async () => {
    const { store, source } = setup();
    await source.create({ id: 'u1' });
    store.reads.length = 0;
    expect(
      await source.count({ id: 'u1' }, {
        type: 'comparison',
        field: 'id',
        operator: 'eq',
        value: 'x',
      }),
    ).toBe(0);
    expect(store.reads).toHaveLength(0);
  });
});
