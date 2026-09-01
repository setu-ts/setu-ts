// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
import { createDynamoTransactionBuffer } from '../../src/adapters/dynamo/dynamo-transaction-buffer.ts';
describe('DynamoDB data source writes', () => {
  it('reports the selected primary, GSI, and scan access paths', async () => {
    const client: IDynamoClient = {
      query: async () => ({}),
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
        indexes: { byStatus: { partitionKey: 'status' } },
      },
    });

    await ds.findAll({ where: { pk: 'p' }, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(ds.getLastAccessPath()).toBe('Query');

    await ds.findAll({ where: { status: 'open' }, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(ds.getLastAccessPath()).toBe('byStatus');

    await ds.findAll({ where: { value: 1 }, orderBy: {}, limit: -1, offset: 0, select: [] });
    expect(ds.getLastAccessPath()).toBe('Scan');
  });

  it('findAll follows pages, applies limits/projection, and refuses offset', async () => {
    let calls = 0;
    const client: IDynamoClient = {
      query: async () => {
        calls++;
        return calls === 1
          ? { Items: [{ pk: { S: 'p' }, value: { N: '1' } }], LastEvaluatedKey: { pk: { S: 'p' } } }
          : { Items: [{ pk: { S: 'q' }, value: { N: '2' } }] };
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
    expect(
      await ds.findAll({ where: { pk: 'p' }, orderBy: {}, limit: 1, offset: 0, select: ['value'] }),
    ).toStrictEqual([{ value: 1 }]);
    expect(calls).toBe(1);
    await expect(ds.findAll({ where: {}, orderBy: {}, limit: -1, offset: 1, select: [] })).rejects
      .toThrow('offset');
  });
  it('handles empty scan/findById results and count filters', async () => {
    const client: IDynamoClient = {
      query: async () => ({}),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    expect(await ds.findAll({ where: {}, orderBy: {}, limit: -1, offset: 0, select: [] })).toEqual(
      [],
    );
    expect(await ds.findById('none')).toBeNull();
    expect(await ds.count({}, { type: 'comparison', field: 'x', operator: 'eq', value: 1 })).toBe(
      0,
    );
  });
  it('uses conditional create, update and ALL_OLD delete', async () => {
    const calls: unknown[] = [];
    const client: IDynamoClient = {
      query: async () => ({ Items: [] }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async (input) => {
        calls.push(input);
        return {};
      },
      updateItem: async (input) => {
        calls.push(input);
        return { Attributes: { pk: { S: 'p' }, value: { N: '2' } } };
      },
      deleteItem: async (input) => {
        calls.push(input);
        return { Attributes: { pk: { S: 'p' } } };
      },
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    await ds.create({ pk: 'p', value: 1 });
    expect(await ds.update('p', { value: 2 })).toStrictEqual({ pk: 'p', value: 2 });
    expect(await ds.delete('p')).toBe(true);
    expect(calls).toMatchObject([{ ConditionExpression: 'attribute_not_exists(#n0)' }, {
      ConditionExpression: 'attribute_exists(#n1)',
      ReturnValues: 'ALL_NEW',
    }, { ReturnValues: 'ALL_OLD' }]);
  });
  it('buffers transaction writes without immediate mutation and leaves reads committed', async () => {
    const calls: string[] = [];
    let reads = 0;
    const client: IDynamoClient = {
      query: async () => ({}),
      scan: async () => ({}),
      getItem: async () => {
        calls.push('get');
        reads += 1;
        return reads === 2
          ? { Item: { pk: { S: 'updated' }, value: { N: '1' }, status: { S: 'open' } } }
          : { Item: { pk: { S: 'p' }, value: { N: '1' } } };
      },
      putItem: async () => {
        calls.push('put');
        return {};
      },
      updateItem: async () => {
        calls.push('update');
        return {};
      },
      deleteItem: async () => {
        calls.push('delete');
        return {};
      },
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const buffer = createDynamoTransactionBuffer();
    const ds = createDynamoDataSource(
      client,
      'Item',
      { Item: { partitionKey: 'pk' } },
      undefined,
      buffer,
    );

    expect(await ds.create({ pk: 'created', value: 1 })).toStrictEqual({ pk: 'created', value: 1 });
    expect(await ds.findById('created')).toStrictEqual({ pk: 'p', value: 1 });
    expect(await ds.update('updated', { value: 2 })).toStrictEqual({
      pk: 'updated',
      value: 2,
      status: 'open',
    });
    expect(await ds.delete('p')).toBe(true);
    expect(calls).toEqual(['get', 'get', 'get']);
    expect(buffer.getWrites()).toStrictEqual([
      {
        Put: {
          TableName: 'Item',
          Item: { pk: { S: 'created' }, value: { N: '1' } },
          ConditionExpression: 'attribute_not_exists(#n0)',
          ExpressionAttributeNames: { '#n0': 'pk' },
        },
      },
      {
        Update: {
          TableName: 'Item',
          Key: { pk: { S: 'updated' } },
          UpdateExpression: 'SET #n0 = :v0',
          ConditionExpression: 'attribute_exists(#n1)',
          ExpressionAttributeNames: { '#n0': 'value', '#n1': 'pk' },
          ExpressionAttributeValues: { ':v0': { N: '2' } },
        },
      },
      { Delete: { TableName: 'Item', Key: { pk: { S: 'p' } } } },
    ]);
  });
  it('translates conditional write failures', async () => {
    const failure = new Error('no');
    failure.name = 'ConditionalCheckFailedException';
    const client: IDynamoClient = {
      query: async () => ({}),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => Promise.reject(failure),
      updateItem: async () => Promise.reject(failure),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    await expect(ds.create({ pk: 'p' })).rejects.toThrow('already exists');
    await expect(ds.update('p', { x: 1 })).rejects.toThrow('does not exist');
  });
  it('preserves non-conditional errors and refuses empty updates', async () => {
    const failure = new Error('network');
    const client: IDynamoClient = {
      query: async () => ({}),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => Promise.reject(failure),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    await expect(ds.create({ pk: 'p' })).rejects.toBe(failure);
    await expect(ds.update('p', { pk: 'p' })).rejects.toThrow('non-key');
    await expect(ds.update('p', { value: 1 })).rejects.toThrow('returned no row');
  });
  it('counts every server page', async () => {
    let calls = 0;
    const client: IDynamoClient = {
      query: async () => {
        calls++;
        return calls === 1 ? { Count: 2, LastEvaluatedKey: { pk: { S: 'p' } } } : { Count: 3 };
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
    expect(await ds.count({ pk: 'p' })).toBe(5);
    expect(calls).toBe(2);
  });
});
