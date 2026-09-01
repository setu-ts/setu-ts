/**
 * Unit tests for the Cosmos deferred-batch transaction: buffering, the flush
 * shape, the three scope refusals, and a rollback that sends nothing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CosmosTransaction } from '../../src/adapters/cosmos/cosmos-data-source.ts';
import type { CosmosEntityMapping } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import {
  BatchBuffer,
  MAX_BATCH_OPERATIONS,
  renderPartitionKey,
  samePartitionKey,
} from '../../src/adapters/cosmos/cosmos-transaction.ts';
import { CosmosTransactionScopeError } from '../../src/errors.ts';
import { createFakeCosmosClient, type FakeCosmosOptions } from '../fixtures/fake-cosmos-client.ts';

const mapping: Record<string, CosmosEntityMapping> = {
  Order: { container: 'orders', partitionKey: 'tenantId' },
  Invoice: { container: 'invoices', partitionKey: 'tenantId' },
};

function makeTransaction(options?: Partial<FakeCosmosOptions>) {
  const fake = createFakeCosmosClient({
    containers: {
      orders: {
        partitionKeyPaths: ['/tenantId'],
        documents: { 't1|existing': { id: 'existing', tenantId: 't1', total: 1 } },
      },
      invoices: { partitionKeyPaths: ['/tenantId'] },
    },
    ...options,
  });
  const database = fake.client.database('db');
  const transaction = new CosmosTransaction(
    database,
    new PartitionKeyResolver(database),
    (entity) => resolveCosmosTarget(entity, mapping),
  );
  return { fake, transaction };
}

describe('BatchBuffer', () => {
  it('reports an empty buffer and no scope until something is written', () => {
    const buffer = new BatchBuffer();
    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.container()).toBeUndefined();
    expect(buffer.partitionKey()).toBeUndefined();
    expect(buffer.operations()).toEqual([]);
  });

  it('refuses the operation that exceeds the batch cap', () => {
    const buffer = new BatchBuffer();
    for (let i = 0; i < MAX_BATCH_OPERATIONS; i++) {
      buffer.add({
        container: 'orders',
        partitionKey: 't1',
        operation: { operationType: 'Create', resourceBody: { id: `o${i}` } },
      });
    }
    expect(() =>
      buffer.add({
        container: 'orders',
        partitionKey: 't1',
        operation: { operationType: 'Create', resourceBody: { id: 'one-too-many' } },
      })
    ).toThrow(CosmosTransactionScopeError);
  });

  it('clears every buffered write', () => {
    const buffer = new BatchBuffer();
    buffer.add({
      container: 'orders',
      partitionKey: 't1',
      operation: { operationType: 'Create', resourceBody: { id: 'o1' } },
    });
    buffer.clear();
    expect(buffer.isEmpty()).toBe(true);
  });
});

describe('samePartitionKey', () => {
  it('compares scalars and hierarchical arrays element-wise', () => {
    expect(samePartitionKey('t1', 't1')).toBe(true);
    expect(samePartitionKey('t1', 't2')).toBe(false);
    expect(samePartitionKey(['t1', 'in'], ['t1', 'in'])).toBe(true);
    expect(samePartitionKey(['t1', 'in'], ['t1', 'us'])).toBe(false);
    expect(samePartitionKey(['t1'], ['t1', 'in'])).toBe(false);
    expect(samePartitionKey(['t1'], 't1')).toBe(false);
    expect(samePartitionKey('t1', ['t1'])).toBe(false);
  });
});

describe('renderPartitionKey', () => {
  it('renders every value a diagnostic may name', () => {
    expect(renderPartitionKey('t1')).toBe('"t1"');
    expect(renderPartitionKey(['t1', 'in'])).toBe('["t1","in"]');
    expect(renderPartitionKey(null)).toBe('null');
  });
});

describe('CosmosTransaction', () => {
  it('buffers every write and flushes them as ONE batch in order', async () => {
    const { transaction, fake } = makeTransaction();
    const orders = transaction.createDataSource('Order');
    await orders.create({ id: 'o1', tenantId: 't1' });
    await orders.update({ id: 'existing', tenantId: 't1' }, { total: 5 });
    await orders.delete({ id: 'existing', tenantId: 't1' });
    // Nothing has been sent yet.
    expect(fake.recorder.batches).toEqual([]);

    await transaction.commit();
    expect(fake.recorder.batches).toHaveLength(1);
    expect(fake.recorder.batches[0]?.container).toBe('orders');
    expect(fake.recorder.batches[0]?.partitionKey).toBe('t1');
    expect(fake.recorder.batches[0]?.operations.map((operation) => operation.operationType))
      .toEqual(['Create', 'Replace', 'Delete']);
  });

  it('returns the row that WILL be written, before the flush', async () => {
    const { transaction } = makeTransaction();
    const created = await transaction.createDataSource('Order').create({
      id: 'o1',
      tenantId: 't1',
    });
    expect(created).toEqual({ id: 'o1', tenantId: 't1' });
    await transaction.rollback();
  });

  it('reports a deferred delete honestly from committed state', async () => {
    const { transaction } = makeTransaction();
    const orders = transaction.createDataSource('Order');
    expect(await orders.delete({ id: 'existing', tenantId: 't1' })).toBe(true);
    expect(await orders.delete({ id: 'never-existed', tenantId: 't1' })).toBe(false);
    await transaction.rollback();
  });

  it('throws when a deferred update addresses no committed row', async () => {
    const { transaction } = makeTransaction();
    await expect(
      transaction.createDataSource('Order').update({ id: 'ghost', tenantId: 't1' }, { total: 1 }),
    ).rejects.toThrow(/no orders row with id/);
    await transaction.rollback();
  });

  it('sends nothing at all on rollback', async () => {
    const { transaction, fake } = makeTransaction();
    await transaction.createDataSource('Order').create({ id: 'o1', tenantId: 't1' });
    await transaction.rollback();
    expect(fake.recorder.batches).toEqual([]);
  });

  it('sends nothing for an empty commit rather than an empty batch', async () => {
    const { transaction, fake } = makeTransaction();
    await transaction.commit();
    expect(fake.recorder.batches).toEqual([]);
  });

  it('refuses a second container by name, at the write that causes it', async () => {
    const { transaction } = makeTransaction();
    await transaction.createDataSource('Order').create({ id: 'o1', tenantId: 't1' });
    await expect(transaction.createDataSource('Invoice').create({ id: 'i1', tenantId: 't1' }))
      .rejects.toThrow(/cannot span containers.*'orders'.*'invoices'/s);
  });

  it('refuses a second partition-key value by name', async () => {
    const { transaction } = makeTransaction();
    const orders = transaction.createDataSource('Order');
    await orders.create({ id: 'o1', tenantId: 't1' });
    await expect(orders.create({ id: 'o2', tenantId: 't2' }))
      .rejects.toThrow(/single partition-key value.*"t1".*"t2"/s);
  });

  it('surfaces a failed batch with its per-operation statuses', async () => {
    const { transaction } = makeTransaction({ batchCode: 207 });
    await transaction.createDataSource('Order').create({ id: 'o1', tenantId: 't1' });
    await expect(transaction.commit())
      .rejects.toThrow(/batch on 'orders' failed with status 207 \(per-operation: 424\)/);
  });

  it('treats a batch response carrying no code as a success', async () => {
    const fake = createFakeCosmosClient({
      containers: { orders: { partitionKeyPaths: ['/tenantId'] } },
    });
    const database = fake.client.database('db');
    const silent = {
      read: database.read.bind(database),
      container: (id: string) => {
        const inner = database.container(id);
        return {
          ...inner,
          items: { ...inner.items, batch: () => Promise.resolve({}) },
        };
      },
    };
    const transaction = new CosmosTransaction(
      silent,
      new PartitionKeyResolver(silent),
      (entity) => resolveCosmosTarget(entity, mapping),
    );
    await transaction.createDataSource('Order').create({ id: 'o1', tenantId: 't1' });
    await transaction.commit();
  });

  it('reports a failed batch that carries no per-operation detail', async () => {
    const fake = createFakeCosmosClient({
      containers: { orders: { partitionKeyPaths: ['/tenantId'] } },
    });
    const database = fake.client.database('db');
    const terse = {
      read: database.read.bind(database),
      container: (id: string) => {
        const inner = database.container(id);
        return {
          ...inner,
          items: { ...inner.items, batch: () => Promise.resolve({ code: 500 }) },
        };
      },
    };
    const transaction = new CosmosTransaction(
      terse,
      new PartitionKeyResolver(terse),
      (entity) => resolveCosmosTarget(entity, mapping),
    );
    await transaction.createDataSource('Order').create({ id: 'o1', tenantId: 't1' });
    await expect(transaction.commit())
      .rejects.toThrow(/failed with status 500 \(per-operation: \)/);
  });

  it('refuses a second settlement of the same handle', async () => {
    const { transaction } = makeTransaction();
    await transaction.commit();
    await expect(transaction.commit()).rejects.toThrow(/already settled/);
  });

  it('refuses a rollback after a commit', async () => {
    const { transaction } = makeTransaction();
    await transaction.commit();
    await expect(transaction.rollback()).rejects.toThrow(/already settled/);
  });
});
