import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createCosmosDataSource } from '../../src/adapters/cosmos/cosmos-data-source.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import { createFakeCosmosClient, FakeCosmosError } from '../fixtures/fake-cosmos-client.ts';
import { CosmosConcurrentModificationError } from '../../src/errors.ts';

function setup(afterRead?: () => void) {
  const fake = createFakeCosmosClient({
    containers: {
      User: {
        partitionKeyPaths: ['/id'],
        documents: { 'a|a': { id: 'a', role: 'owner', name: 'old' } },
      },
    },
    ...(afterRead === undefined ? {} : { afterPointRead: afterRead }),
  });
  const database = fake.client.database('db');
  return {
    fake,
    database,
    source: createCosmosDataSource({
      database,
      target: resolveCosmosTarget('User', undefined),
      partitionKeys: new PartitionKeyResolver(database),
    }),
  };
}
describe('Cosmos guarded conditional writes', () => {
  for (const operation of ['update', 'delete'] as const) {
    it(`${operation}: delete-and-recreate cannot use the original etag`, async () => {
      let swapped = false;
      const fixture = setup(() => {
        if (swapped) return;
        swapped = true;
        fixture.fake.documents.set('User|"a"|a', {
          id: 'a',
          role: 'other',
          name: 'secret',
          _etag: 'recreated',
        });
      });
      const result = operation === 'update'
        ? await fixture.source.updateWhere!('a', { role: 'owner' }, { name: 'bad' })
        : await fixture.source.deleteWhere!('a', { role: 'owner' });
      expect(result).toBe(operation === 'update' ? null : false);
      expect(await fixture.source.findById('a')).toMatchObject({ role: 'other', name: 'secret' });
    });
    it(`${operation}: retries 412, then succeeds after re-checking`, async () => {
      let n = 0;
      const fixture = setup(() => {
        if (++n === 1) fixture.fake.documents.get('User|"a"|a')!._etag = 'concurrent';
      });
      const result = operation === 'update'
        ? await fixture.source.updateWhere!('a', { role: 'owner' }, { name: 'new' })
        : await fixture.source.deleteWhere!('a', { role: 'owner' });
      expect(result).toBeTruthy();
      expect(n).toBe(2);
      expect(await fixture.source.findById('a')).toEqual(
        operation === 'update' ? { id: 'a', role: 'owner', name: 'new' } : null,
      );
      if (operation === 'update') {
        expect(fixture.fake.recorder.replaces.map((call) => call.ifMatch)).toEqual([
          'etag-1',
          'concurrent',
        ]);
      }
    });
    it(`${operation}: rejects after exactly three 412 rounds`, async () => {
      let reads = 0;
      const fixture = setup(() => {
        fixture.fake.documents.get('User|"a"|a')!._etag = `edit-${++reads}`;
      });
      const promise = operation === 'update'
        ? fixture.source.updateWhere!('a', { role: 'owner' }, { name: 'new' })
        : fixture.source.deleteWhere!('a', { role: 'owner' });
      await expect(promise).rejects.toBeInstanceOf(CosmosConcurrentModificationError);
      expect(reads).toBe(3);
    });
  }
  it('refuses partition moves and unguardable documents, maps 404, and propagates other faults', async () => {
    const fixture = setup();
    await expect(
      fixture.source.updateWhere!('a', { role: 'owner' }, { id: 'ignored', name: 'new' }),
    ).resolves.toMatchObject({ id: 'a' });
    delete fixture.fake.documents.get('User|"a"|a')!._etag;
    await expect(fixture.source.deleteWhere!('a', { role: 'owner' })).rejects.toThrow(/_etag/);
    const fake = createFakeCosmosClient({
      containers: {
        User: {
          partitionKeyPaths: ['/tenant'],
          documents: { 't|a': { id: 'a', tenant: 't', name: 'old' } },
        },
      },
    });
    const database = fake.client.database('db');
    const source = createCosmosDataSource({
      database,
      target: resolveCosmosTarget('User', { User: { partitionKey: 'tenant' } }),
      partitionKeys: new PartitionKeyResolver(database),
    });
    await expect(
      source.updateWhere!({ id: 'a', tenant: 't' }, { name: 'old' }, { tenant: 'other' }),
    ).rejects.toThrow(/partition key/);
    for (const code of [404, 500]) {
      const current = setup();
      const container = current.database.container('User');
      current.database.container = () => container;
      const item = container.item.bind(container);
      container.item = (...args) => ({
        ...item(...args),
        replace: () => Promise.reject(new FakeCosmosError(code, 'fault')),
        delete: () => Promise.reject(new FakeCosmosError(code, 'fault')),
      });
      for (const operation of ['update', 'delete'] as const) {
        const promise = operation === 'update'
          ? current.source.updateWhere!('a', { role: 'owner' }, { name: 'new' })
          : current.source.deleteWhere!('a', { role: 'owner' });
        if (code === 404) expect(await promise).toBeFalsy();
        else await expect(promise).rejects.toThrow('fault');
      }
    }
  });
});
