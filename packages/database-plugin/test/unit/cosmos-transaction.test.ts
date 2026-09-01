/**
 * Unit tests for the Cosmos deferred-batch transaction: buffering, the flush
 * shape, the three scope refusals, and a rollback that sends nothing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CosmosTransaction,
  MAX_PATCH_OPERATIONS,
} from '../../src/adapters/cosmos/cosmos-data-source.ts';
import type { CosmosEntityMapping } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { resolveCosmosTarget } from '../../src/adapters/cosmos/cosmos-mapping.ts';
import { PartitionKeyResolver } from '../../src/adapters/cosmos/cosmos-partition-key.ts';
import type { BufferedWrite } from '../../src/adapters/cosmos/cosmos-transaction.ts';
import {
  BatchBuffer,
  itemIdOf,
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

describe('itemIdOf', () => {
  // The buffer reads a candidate replace against every buffered operation, so
  // each arm has to answer for the kind it is given.
  it('reads a Delete and a Patch from the operation itself', () => {
    expect(itemIdOf({ operationType: 'Delete', id: 'd1' })).toBe('d1');
    expect(itemIdOf({
      operationType: 'Patch',
      id: 'p1',
      resourceBody: { operations: [{ op: 'set', path: '/a', value: 1 }] },
    })).toBe('p1');
  });

  it('prefers a document body id, and falls back to the operation id', () => {
    expect(itemIdOf({ operationType: 'Create', resourceBody: { id: 'body' }, id: 'op' }))
      .toBe('body');
    // A non-string body id is not an id Cosmos would accept, so the operation's
    // own value is used instead.
    expect(itemIdOf({ operationType: 'Upsert', resourceBody: { id: 7 }, id: 'op' })).toBe('op');
  });

  it('reports no id for a create whose id the service will mint', () => {
    expect(itemIdOf({ operationType: 'Create', resourceBody: { total: 1 } })).toBeUndefined();
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
    // The update is a `Patch`, not a `Replace`: it writes only the fields the
    // payload names, so it neither clobbers a concurrent writer's other fields
    // nor discards an earlier buffered update of the same row.
    expect(fake.recorder.batches[0]?.operations.map((operation) => operation.operationType))
      .toEqual(['Create', 'Patch', 'Delete']);
  });

  it('buffers a narrow update as set operations naming only the payload fields', async () => {
    const { transaction, fake } = makeTransaction();
    await transaction.createDataSource('Order')
      .update({ id: 'existing', tenantId: 't1' }, { total: 5, note: 'x' });
    await transaction.commit();
    const [operation] = fake.recorder.batches[0]?.operations ?? [];
    expect(operation?.operationType).toBe('Patch');
    expect(operation).toEqual({
      operationType: 'Patch',
      id: 'existing',
      resourceBody: {
        operations: [
          { op: 'set', path: '/total', value: 5 },
          { op: 'set', path: '/note', value: 'x' },
        ],
      },
    });
  });

  it('lets two updates of one row both reach the batch, neither discarding the other', async () => {
    // The defect this replaced: both updates were whole-document replaces
    // built from the same committed read, so the second silently dropped the
    // first one's field while the batch still answered 200.
    const { transaction, fake } = makeTransaction();
    const orders = transaction.createDataSource('Order');
    await orders.update({ id: 'existing', tenantId: 't1' }, { total: 5 });
    await orders.update({ id: 'existing', tenantId: 't1' }, { note: 'second' });
    await transaction.commit();
    const operations = fake.recorder.batches[0]?.operations ?? [];
    expect(operations.map((operation) => operation.operationType)).toEqual(['Patch', 'Patch']);
    // Neither operation carries the other's field, so neither can undo it.
    expect(JSON.stringify(operations)).toContain('/total');
    expect(JSON.stringify(operations)).toContain('/note');
  });

  it('buffers nothing when an update payload carries only the key', async () => {
    // `id` and the partition key are stripped before the write is built, so an
    // update naming only those has nothing left to write — sending an empty
    // patch would be a write that changes nothing.
    const { transaction, fake } = makeTransaction();
    const row = await transaction.createDataSource('Order')
      .update({ id: 'existing', tenantId: 't1' }, { id: 'existing', tenantId: 't1' });
    expect(row).toEqual({ id: 'existing', tenantId: 't1', total: 1 });
    await transaction.commit();
    expect(fake.recorder.batches).toEqual([]);
  });

  it('buffers a whole-document replace for an update too wide for one patch', async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PATCH_OPERATIONS; i++) wide[`f${i}`] = i;
    const { transaction, fake } = makeTransaction();
    await transaction.createDataSource('Order').update({ id: 'existing', tenantId: 't1' }, wide);
    await transaction.commit();
    const [operation] = fake.recorder.batches[0]?.operations ?? [];
    expect(operation?.operationType).toBe('Replace');
    // The replace carries the committed row merged with the payload, which is
    // exactly why a second write to this row cannot be allowed after it.
    expect((operation as { resourceBody: Record<string, unknown> }).resourceBody)
      .toMatchObject({ id: 'existing', tenantId: 't1', total: 1, f0: 0 });
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

  it('rolls back idempotently after a commit, so a catch block cannot mask the cause', async () => {
    // `DatabaseService.transaction()` rolls back inside the SAME catch that
    // sees a failed commit, and `commit()` marks the handle settled before it
    // awaits the batch. A refusal here would replace the batch's own
    // diagnostic on every throttled or rejected batch.
    const { transaction } = makeTransaction();
    await transaction.commit();
    await expect(transaction.rollback()).resolves.toBeUndefined();
    await expect(transaction.rollback()).resolves.toBeUndefined();
  });

  it('reports the batch failure, not a rollback complaint, through the service call shape', async () => {
    // The exact shape `DatabaseService.transaction()` uses: commit inside a
    // `try`, roll back inside the `catch`, rethrow the original. Without an
    // idempotent rollback the caller sees "already settled" and never learns
    // which operation failed.
    const { fake, transaction } = makeTransaction({ batchCode: 207 });
    expect(fake).toBeDefined();
    const source = transaction.createDataSource('Order');
    await source.create({ id: 'o1', tenantId: 't1' });
    let seen: Error | undefined;
    try {
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      seen = error as Error;
    }
    expect(seen?.message).toMatch(/failed with status 207/);
    expect(seen?.message).toMatch(/per-operation: 424/);
    expect(seen?.message).not.toMatch(/already settled/);
  });

  it('refuses a wide update that would discard an earlier write to the same row', () => {
    // A replace carries a whole document built from COMMITTED state, so a
    // second one silently throws the first away — measured on the emulator as
    // two 200s with the first change gone.
    const buffer = new BatchBuffer();
    const wide = (id: string): BufferedWrite => ({
      container: 'orders',
      partitionKey: 't1',
      operation: { operationType: 'Replace', id, resourceBody: { id, tenantId: 't1' } },
    });
    buffer.add(wide('o1'));
    expect(() => buffer.add(wide('o1'))).toThrow(CosmosTransactionScopeError);
    expect(() => buffer.add(wide('o1'))).toThrow(/silently discard the earlier write/);
    // A different row is untouched by the rule.
    buffer.add(wide('o2'));
    expect(buffer.operations()).toHaveLength(2);
  });

  it('refuses a wide update after a narrow one, reading the buffered patch id', () => {
    // The realistic ordering: a narrow update buffers a Patch, then a wider one
    // for the SAME row cannot compose with it. This is also the only path that
    // reads a Patch operation's own id rather than a document body's.
    const buffer = new BatchBuffer();
    buffer.add({
      container: 'orders',
      partitionKey: 't1',
      operation: {
        operationType: 'Patch',
        id: 'o1',
        resourceBody: { operations: [{ op: 'set', path: '/a', value: 1 }] },
      },
    });
    expect(() =>
      buffer.add({
        container: 'orders',
        partitionKey: 't1',
        operation: { operationType: 'Replace', id: 'o1', resourceBody: { id: 'o1' } },
      })
    ).toThrow(/already writes to 'o1'/);
  });

  it('allows the pairings that compose', () => {
    const buffer = new BatchBuffer();
    const patch = (id: string, field: string): BufferedWrite => ({
      container: 'orders',
      partitionKey: 't1',
      operation: {
        operationType: 'Patch',
        id,
        resourceBody: { operations: [{ op: 'set', path: `/${field}`, value: 1 }] },
      },
    });
    // Two patches compose; a delete after a patch is unambiguous.
    buffer.add(patch('o1', 'a'));
    buffer.add(patch('o1', 'b'));
    buffer.add({
      container: 'orders',
      partitionKey: 't1',
      operation: { operationType: 'Delete', id: 'o1' },
    });
    expect(buffer.operations().map((operation) => operation.operationType))
      .toEqual(['Patch', 'Patch', 'Delete']);
  });
});
