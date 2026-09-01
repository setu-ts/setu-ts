// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
import { encodeCursor } from '@setu-ts/common';
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
});
