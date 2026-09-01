// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
describe('DynamoDB data source writes', () => {
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
