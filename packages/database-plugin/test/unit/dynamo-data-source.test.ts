// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
describe('DynamoDB data source writes', () => {
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
