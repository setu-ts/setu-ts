// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  DynamoQueryCommandInput,
  IDynamoClient,
} from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
import { decodeCursor, encodeCursor } from '@setu-ts/common';
const query = (partial = {}) => ({
  where: { pk: 'p' },
  orderBy: {},
  limit: 2,
  offset: 0,
  select: [],
  ...partial,
});
describe('DynamoDB cursor pages', () => {
  it('uses LastEvaluatedKey, including on an empty non-terminal page', async () => {
    const client: IDynamoClient = {
      query: async () => ({ Items: [], LastEvaluatedKey: { pk: { S: 'next' } } }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    const page = await ds.findPage!(query());
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
  });
  it('returns null only without LastEvaluatedKey and refuses offset', async () => {
    const client: IDynamoClient = {
      query: async () => ({ Items: [] }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    expect((await ds.findPage!(query())).nextCursor).toBeNull();
    await expect(ds.findPage!(query({ offset: 1 }))).rejects.toThrow('offset');
  });
  it('restores a valid cursor, refuses malformed tokens, and stops at its fetch bound', async () => {
    let calls = 0;
    const client: IDynamoClient = {
      query: async () => {
        calls++;
        return { Items: [], LastEvaluatedKey: { pk: { S: `p${calls}` } } };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } }, 2);
    const cursor = encodeCursor({ orderedValues: ['p'], keyValues: ['p'], sortFingerprint: '' });
    expect((await ds.findPage!(query({ cursor }))).nextCursor).not.toBeNull();
    expect(calls).toBe(2);
    await expect(ds.findPage!(query({ cursor: 'bad' }))).rejects.toThrow('malformed');
  });

  it('uses the remaining page budget as the native DynamoDB Limit', async () => {
    const inputs: DynamoQueryCommandInput[] = [];
    let calls = 0;
    const client: IDynamoClient = {
      query: async (input) => {
        inputs.push(input);
        calls += 1;
        return calls < 3
          ? {
            Items: [{ pk: { S: 'p' }, value: { N: String(calls) } }],
            LastEvaluatedKey: { pk: { S: `p${calls}` } },
          }
          : { Items: [{ pk: { S: 'p' }, value: { N: '3' } }] };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });

    const page = await ds.findPage!(query({ limit: 3 }));

    expect(page.rows.map((row) => row.value)).toEqual([1, 2, 3]);
    expect(inputs.map((input) => input.Limit)).toEqual([3, 2, 1]);
  });

  it('round-trips every GSI and table key through a cursor', async () => {
    const inputs: DynamoQueryCommandInput[] = [];
    let calls = 0;
    const client: IDynamoClient = {
      query: async (input) => {
        inputs.push(input);
        calls += 1;
        return calls === 1
          ? {
            Items: [{
              gpk: { S: 'customer' },
              gsk: { S: 'created' },
              pk: { S: 'tenant' },
              sk: { S: 'order' },
            }],
            LastEvaluatedKey: {
              gpk: { S: 'customer' },
              gsk: { S: 'created' },
              pk: { S: 'tenant' },
              sk: { S: 'order' },
            },
          }
          : { Items: [] };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', {
      Item: {
        partitionKey: 'pk',
        sortKey: 'sk',
        indexes: { byCustomer: { partitionKey: 'gpk', sortKey: 'gsk' } },
      },
    });

    const first = await ds.findPage!(query({ where: { gpk: 'customer' }, limit: 1 }));
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('GSI page must have a continuation cursor');
    expect(decodeCursor(cursor)?.keyValues).toEqual(['customer', 'created', 'tenant', 'order']);

    await ds.findPage!(query({ where: { gpk: 'customer' }, cursor, limit: 1 }));
    expect(inputs[1]).toMatchObject({
      ExclusiveStartKey: {
        gpk: { S: 'customer' },
        gsk: { S: 'created' },
        pk: { S: 'tenant' },
        sk: { S: 'order' },
      },
    });
  });

  it('keeps primary-key Query and Scan cursor shapes to table keys', async () => {
    const primaryClient: IDynamoClient = {
      query: async () => ({ Items: [], LastEvaluatedKey: { pk: { S: 'p' }, sk: { S: 's' } } }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const scanClient: IDynamoClient = {
      query: async () => ({}),
      scan: async () => ({ Items: [], LastEvaluatedKey: { pk: { S: 'p' }, sk: { S: 's' } } }),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const mapping = { Item: { partitionKey: 'pk', sortKey: 'sk' } };

    const primary = await createDynamoDataSource(primaryClient, 'Item', mapping)
      .findPage!(query({ limit: 1 }));
    const scan = await createDynamoDataSource(scanClient, 'Item', mapping)
      .findPage!(query({ where: {}, limit: 1 }));

    expect(decodeCursor(primary.nextCursor ?? '')?.keyValues).toEqual(['p', 's']);
    expect(decodeCursor(scan.nextCursor ?? '')?.keyValues).toEqual(['p', 's']);
  });
});
