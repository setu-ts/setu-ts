import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createBigtableDataSource } from '../../src/adapters/bigtable/bigtable-data-source.ts';
import { resolveBigtableTarget } from '../../src/adapters/bigtable/bigtable-mapping.ts';
import { preconditionTest } from '../../src/adapters/bigtable/bigtable-scan.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';

const target = resolveBigtableTarget('User', undefined);
describe('Bigtable newest-cell conditional writes', () => {
  it('caps every field before value comparison in one- and three-field nested conditions', () => {
    for (const where of [{ name: 'a' }, { name: 'a', role: 'owner', n: 2 }]) {
      let chain = preconditionTest(target, where)!;
      for (const [field, value] of Object.entries(where)) {
        const condition = chain[0]!;
        expect('condition' in condition).toBe(true);
        if (!('condition' in condition)) throw new Error('missing condition');
        const encoded = `${typeof value === 'number' ? 'n' : 's'}:${value}`;
        expect(condition.condition.test).toEqual([{ family: 'cf' }, { column: [field] }, {
          row: { cellLimit: 1 },
        }, { value: { start: encoded, end: encoded } }]);
        chain = [...condition.condition.pass!];
      }
      expect(chain).toEqual([{ all: true }]);
    }
  });
  it('refuses retained historical matches for update and delete without writing', async () => {
    const store = new FakeBigtableStore();
    const table = createFakeBigtableClient(store).instance('i').table('User');
    const source = createBigtableDataSource(table, target);
    store.seed('User', 'a', { cf: { id: 's:a', role: 's:owner', name: 's:old' } });
    store.seed('User', 'a', { cf: { role: 's:other', name: 's:new' } });
    expect(await source.findById('a')).toMatchObject({ role: 'other', name: 'new' });
    expect(await source.updateWhere!('a', { role: 'owner', name: 'old' }, { name: 'bad' }))
      .toBeNull();
    expect(await source.deleteWhere!('a', { role: 'owner', name: 'old' })).toBe(false);
    expect(await source.findById('a')).toMatchObject({ role: 'other', name: 'new' });
    expect(await source.updateWhere!('a', { role: 'other', name: 'new' }, { name: 'applied' }))
      .toMatchObject({ name: 'applied' });
    expect(await source.deleteWhere!('a', { name: 'applied' })).toBe(true);
  });
  it('answers not matched for an unaddressable column without an RPC', async () => {
    const store = new FakeBigtableStore();
    const table = createFakeBigtableClient(store).instance('i').table('User');
    table.row = () => {
      throw new Error('unexpected RPC');
    };
    const source = createBigtableDataSource(table, target);
    expect(await source.updateWhere!('a', { 'bad/column': 1 }, { name: 'bad' })).toBeNull();
    expect(await source.deleteWhere!('a', { 'bad/column': 1 })).toBe(false);
  });
});
