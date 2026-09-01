// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
/**
 * Coverage for the {@linkcode DynamoAdapter} deferred transaction.
 *
 * The transaction contract (M80 plan §3.17): writes buffer through
 * transaction-scoped data sources into one {@linkcode IDynamoTransactionBuffer}
 * and flush as exactly ONE `TransactWriteItems` call at commit, in call order;
 * `rollback` discards the buffer and sends nothing. The buffer itself refuses a
 * duplicate physical item key and a 101st write, each by name, before any
 * adapter call is made — so the assertions here prove those refusals PROPAGATE
 * through the adapter's transaction seam with the SDK client never called,
 * rather than re-enforcing them a second time.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DynamoAdapter } from '../../src/adapters/dynamo/dynamo-adapter.ts';
import type {
  DynamoTransactWriteItemsCommandInput,
  IDynamoClient,
} from '../../src/adapters/dynamo/dynamo-client-types.ts';

/** A spy client exposing the full driven surface plus the calls it recorded. */
interface SpyClient extends IDynamoClient {
  transactCalls: DynamoTransactWriteItemsCommandInput[];
  destroyed: number;
}

/** Builds a spy client; individual members are replaced via `overrides`. */
function fakeClient(overrides: Partial<IDynamoClient> = {}): SpyClient {
  const client: SpyClient = {
    transactCalls: [],
    destroyed: 0,
    query: async () => ({}),
    scan: async () => ({}),
    getItem: async () => ({}),
    putItem: async () => ({}),
    updateItem: async () => ({}),
    deleteItem: async () => ({}),
    transactWriteItems: async (input) => {
      client.transactCalls.push(input);
      return {};
    },
    destroy: () => {
      client.destroyed += 1;
    },
  };
  return Object.assign(client, overrides);
}

/** A connected adapter over `client`, mapped for the entities these tests use. */
async function connectedAdapter(client: IDynamoClient): Promise<DynamoAdapter> {
  const adapter = new DynamoAdapter({
    client,
    entities: {
      Order: { partitionKey: 'pk' },
      Shipment: { partitionKey: 'pk' },
    },
  });
  await adapter.connect();
  return adapter;
}

describe('DynamoDB adapter — deferred TransactWriteItems transactions', () => {
  it('flushes buffered writes across entities as exactly one TransactWriteItems at commit', async () => {
    const client = fakeClient({
      getItem: async () => ({ Item: { pk: { S: 'k' }, status: { S: 'open' } } }),
    });
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();

    await tx.createDataSource('Order').create({ pk: 'a', total: 1 });
    await tx.createDataSource('Shipment').update('k', { status: 'shipped' });
    await tx.createDataSource('Order').delete('k');

    await tx.commit();

    expect(client.transactCalls).toHaveLength(1);
    const items = client.transactCalls[0].TransactItems;
    expect(items).toHaveLength(3);
    // Call order is preserved: the Put, then the Update, then the Delete.
    expect(items[0].Put?.TableName).toBe('Order');
    expect(items[0].Put?.Item).toEqual({ pk: { S: 'a' }, total: { N: '1' } });
    expect(items[1].Update?.TableName).toBe('Shipment');
    expect(items[1].Update?.Key).toEqual({ pk: { S: 'k' } });
    expect(items[2].Delete?.TableName).toBe('Order');
    expect(items[2].Delete?.Key).toEqual({ pk: { S: 'k' } });
  });

  it('rollback discards the buffer and sends nothing, and a later commit stays silent', async () => {
    const client = fakeClient();
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    await tx.createDataSource('Order').create({ pk: 'a' });

    await tx.rollback();
    expect(client.transactCalls).toHaveLength(0);

    // The handle is finalized by the rollback, so a late commit is a no-op
    // that still sends nothing.
    await tx.commit();
    expect(client.transactCalls).toHaveLength(0);
  });

  it('commit with no buffered writes sends nothing', async () => {
    const client = fakeClient();
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    await tx.commit();
    expect(client.transactCalls).toHaveLength(0);
  });

  it('a failed commit finalizes the handle — a retry sends no second batch', async () => {
    let attempts = 0;
    const client = fakeClient({
      transactWriteItems: async () => {
        attempts += 1;
        return Promise.reject(new Error('transaction cancelled'));
      },
    });
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    await tx.createDataSource('Order').create({ pk: 'a' });

    await expect(tx.commit()).rejects.toThrow('transaction cancelled');
    await tx.commit();
    expect(attempts).toBe(1);
  });

  it('refuses a duplicate item key by name before any SDK call', async () => {
    const client = fakeClient();
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    const ds = tx.createDataSource('Order');

    await ds.create({ pk: 'same' });
    // The buffer refuses the second operation on one physical item key — the
    // measured ValidationException (M80 plan §1A T2) — and the adapter never
    // reaches the SDK.
    await expect(ds.create({ pk: 'same' })).rejects.toThrow(
      /already contains an operation for key/,
    );
    expect(client.transactCalls).toHaveLength(0);
  });

  it('refuses the 101st write by name before any SDK call', async () => {
    const client = fakeClient();
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    const ds = tx.createDataSource('Order');

    for (let index = 0; index < 100; index += 1) {
      await ds.create({ pk: `key-${index}` });
    }
    // The buffer enforces the API's own 100-item ceiling (M80 plan §1A T3)
    // before any call, naming the condition.
    await expect(ds.create({ pk: 'key-100' })).rejects.toThrow(
      /more than 100 write operations/,
    );
    expect(client.transactCalls).toHaveLength(0);
  });

  it('refuses createDataSource after the transaction is finalized', async () => {
    const client = fakeClient();
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    await tx.commit();
    expect(() => tx.createDataSource('Order')).toThrow(/already finalized/);
  });

  it('reads inside a transaction hit committed state, not the buffer', async () => {
    let reads = 0;
    const client = fakeClient({
      getItem: async () => {
        reads += 1;
        return {};
      },
    });
    const adapter = await connectedAdapter(client);
    const tx = await adapter.beginTransaction();
    const ds = tx.createDataSource('Order');

    await ds.create({ pk: 'buffered' });
    // The create is buffered, not visible: the read goes to the client and
    // comes back committed-state empty — read-your-own-writes is documented
    // as not emulated (M80 plan §3.17).
    expect(await ds.findById('buffered')).toBeNull();
    expect(reads).toBe(1);
  });
});
