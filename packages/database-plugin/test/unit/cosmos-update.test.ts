/**
 * Unit tests for the Cosmos update path: patch below the per-request operation
 * limit, read-merge-replace above it with its `IfMatch` guard, and the two
 * refusals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createCosmosDataSource,
  MAX_PATCH_OPERATIONS,
} from '../../src/adapters/cosmos/cosmos-data-source.ts';
import type { CosmosEntityMapping } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import { CosmosConcurrentModificationError } from '../../src/errors.ts';
import { createFakeCosmosClient, type FakeCosmosOptions } from '../fixtures/fake-cosmos-client.ts';

const withTenant: Record<string, CosmosEntityMapping> = {
  Order: { container: 'Order', partitionKey: 'tenantId' },
};

function makeSource(
  options: FakeCosmosOptions,
  mapping: Record<string, CosmosEntityMapping> = withTenant,
) {
  const fake = createFakeCosmosClient(options);
  const database = fake.client.database('db');
  const source = createCosmosDataSource({
    database,
    target: resolveCosmosTarget('Order', mapping),
    partitionKeys: new PartitionKeyResolver(database),
  });
  return { fake, source };
}

const seeded: FakeCosmosOptions = {
  containers: {
    Order: {
      partitionKeyPaths: ['/tenantId'],
      documents: { 't1|o1': { id: 'o1', tenantId: 't1', total: 1, keep: 'yes' } },
    },
  },
};

describe('update — patch path', () => {
  it('sends one set operation per field and returns the patched row', async () => {
    const { source, fake } = makeSource(seeded);
    const updated = await source.update({ id: 'o1', tenantId: 't1' }, { total: 9, note: 'x' });
    expect(updated).toEqual({ id: 'o1', tenantId: 't1', total: 9, keep: 'yes', note: 'x' });
    expect(fake.recorder.patches).toEqual([[
      { op: 'set', path: '/total', value: 9 },
      { op: 'set', path: '/note', value: 'x' },
    ]]);
    expect(fake.recorder.replaces).toEqual([]);
  });

  it('takes the patch path at exactly the operation limit', async () => {
    const { source, fake } = makeSource(seeded);
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) payload[`f${i}`] = i;
    await source.update({ id: 'o1', tenantId: 't1' }, payload);
    expect(fake.recorder.patches).toHaveLength(1);
    expect(fake.recorder.replaces).toEqual([]);
  });

  it('never writes the primary key, so a row is not moved to a new key', async () => {
    const { source, fake } = makeSource(seeded);
    await source.update({ id: 'o1', tenantId: 't1' }, { id: 'other', total: 2 });
    expect(fake.recorder.patches[0]).toEqual([{ op: 'set', path: '/total', value: 2 }]);
  });

  it('drops a restated partition key rather than refusing it', async () => {
    const { source, fake } = makeSource(seeded);
    await source.update({ id: 'o1', tenantId: 't1' }, { tenantId: 't1', total: 3 });
    expect(fake.recorder.patches[0]).toEqual([{ op: 'set', path: '/total', value: 3 }]);
  });

  it('reads the row rather than sending an empty patch when nothing is left to write', async () => {
    const { source, fake } = makeSource(seeded);
    const row = await source.update({ id: 'o1', tenantId: 't1' }, { id: 'ignored' });
    expect(row).toEqual({ id: 'o1', tenantId: 't1', total: 1, keep: 'yes' });
    expect(fake.recorder.patches).toEqual([]);
  });

  it('throws when no row carries the key', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    });
    await expect(source.update({ id: 'ghost', tenantId: 't1' }, { total: 1 }))
      .rejects.toThrow(/no Order row with id/);
  });

  it('throws when the cross-partition lookup addresses nothing', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
      queryResults: [[]],
    });
    await expect(source.update('ghost', { total: 1 })).rejects.toThrow(/no Order row with id/);
  });
});

describe('update — replace path', () => {
  it('reads, merges and replaces conditionally above the patch limit', async () => {
    const { source, fake } = makeSource(seeded);
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) payload[`f${i}`] = i;
    const updated = await source.update({ id: 'o1', tenantId: 't1' }, payload);
    expect(updated['f10']).toBe(10);
    expect(updated['keep']).toBe('yes');
    expect(fake.recorder.patches).toEqual([]);
    expect(fake.recorder.replaces).toHaveLength(1);
    expect(fake.recorder.replaces[0]?.ifMatch).toMatch(/^etag-/);
  });

  it('reports a concurrent writer rather than overwriting it', async () => {
    // The competing write lands BETWEEN this update's read and its conditional
    // replace, which is the only sequence that reaches the 412.
    let raced = false;
    const fake = createFakeCosmosClient({
      ...seeded,
      afterPointRead: () => {
        if (raced) return;
        raced = true;
        const key = [...fake.documents.keys()][0] as string;
        const current = fake.documents.get(key) as Record<string, unknown>;
        fake.documents.set(key, { ...current, _etag: 'written-by-someone-else' });
      },
    });
    const database = fake.client.database('db');
    const source = createCosmosDataSource({
      database,
      target: resolveCosmosTarget('Order', withTenant),
      partitionKeys: new PartitionKeyResolver(database),
    });
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) payload[`f${i}`] = i;
    await expect(source.update({ id: 'o1', tenantId: 't1' }, payload))
      .rejects.toThrow(CosmosConcurrentModificationError);
  });

  it('sends no access condition when the document carries no etag', async () => {
    const fake = createFakeCosmosClient({
      containers: { Order: { partitionKeyPaths: ['/tenantId'] } },
    });
    // Seed a document directly, without the etag the fake normally stamps.
    fake.documents.set('Order|"t1"|o1', { id: 'o1', tenantId: 't1' });
    const database = fake.client.database('db');
    const source = createCosmosDataSource({
      database,
      target: resolveCosmosTarget('Order', withTenant),
      partitionKeys: new PartitionKeyResolver(database),
    });
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 11; i++) payload[`f${i}`] = i;
    await source.update({ id: 'o1', tenantId: 't1' }, payload);
    expect(fake.recorder.replaces[0]?.ifMatch).toBeUndefined();
  });
});

describe('update — partition-key refusal', () => {
  it('refuses a payload that would move the row to another partition', async () => {
    const { source, fake } = makeSource(seeded);
    await expect(source.update({ id: 'o1', tenantId: 't1' }, { tenantId: 't2' }))
      .rejects.toThrow(/would change the partition key \/tenantId.*cannot move an item/s);
    expect(fake.recorder.patches).toEqual([]);
    expect(fake.recorder.replaces).toEqual([]);
  });

  it('refuses a hierarchical partition-key change by the offending path', async () => {
    const { source } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/tenantId', '/region'],
          documents: { '["t1","in"]|o1': { id: 'o1', tenantId: 't1', region: 'in' } },
        },
      },
    }, { Order: { container: 'Order', partitionKey: [['tenantId'], ['region']] } });
    await expect(
      source.update({ id: 'o1', tenantId: 't1', region: 'in' }, { region: 'us' }),
    ).rejects.toThrow(/change the partition key \/region/);
  });

  it('keeps a nested partition-key parent in the payload when its value is unchanged', async () => {
    const { source, fake } = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/address/city'],
          documents: { 'Kolkata|o1': { id: 'o1', address: { city: 'Kolkata' } } },
        },
      },
    }, { Order: { container: 'Order', partitionKey: ['address', 'city'] } });
    await source.update(
      { id: 'o1', 'address.city': 'Kolkata' },
      { address: { city: 'Kolkata', zip: '700001' } },
    );
    expect(fake.recorder.patches[0]).toEqual([
      { op: 'set', path: '/address', value: { city: 'Kolkata', zip: '700001' } },
    ]);
  });
});

/** A container that partitions by its own primary key, so no read resolves the address. */
const byId: Record<string, CosmosEntityMapping> = { Order: { container: 'Order' } };

describe('update — the row disappears mid-operation', () => {
  // `addressOf` answers without a read when the container partitions BY the
  // primary key, so these are the paths where the row is gone by the time the
  // write is built. Each reports the contract's missing-row error rather than
  // a bare 404 from the driver.
  it('reports a missing row when the payload carries only the key', async () => {
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    }, byId);
    await expect(source.update('gone', { id: 'gone' }))
      .rejects.toThrow(/no Order row with id "gone"/);
  });

  it('reports a missing row for a payload too wide for one patch', async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PATCH_OPERATIONS; i++) wide[`f${i}`] = i;
    const { source } = makeSource({
      containers: { Order: { partitionKeyPaths: ['/id'] } },
    }, byId);
    await expect(source.update('gone', wide)).rejects.toThrow(/no Order row with id "gone"/);
  });

  it('reports a missing row when the conditional replace answers 404', async () => {
    // Read succeeds, then the row is deleted before the replace lands — the
    // 404 arm beside the 412 one.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PATCH_OPERATIONS; i++) wide[`f${i}`] = i;
    // The hook is supplied at construction, so it reads the store through a
    // holder the constructed fake fills in afterwards.
    const holder: { store?: Map<string, Record<string, unknown>> } = {};
    const built = makeSource({
      containers: {
        Order: {
          partitionKeyPaths: ['/id'],
          documents: { 'o1|o1': { id: 'o1', total: 1 } },
        },
      },
      afterPointRead: () => {
        holder.store?.clear();
      },
    }, byId);
    holder.store = built.fake.documents;
    await expect(built.source.update('o1', wide)).rejects.toThrow(/no Order row with id "o1"/);
  });
});
