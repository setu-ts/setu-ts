// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
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
});
