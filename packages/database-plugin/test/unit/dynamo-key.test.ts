// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDynamoClient } from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
function client(): IDynamoClient {
  const noop = async () => ({});
  return {
    query: async () => ({}),
    scan: async () => ({}),
    getItem: async (input) => ({ Item: input.Key }),
    putItem: noop,
    updateItem: async () => ({ Attributes: { pk: { S: 'p' }, sk: { S: 's' } } }),
    deleteItem: async () => ({}),
    transactWriteItems: noop,
    destroy() {},
  };
}
describe('DynamoDB key handling', () => {
  it('projects composite keys to mapped columns', async () => {
    const ds = createDynamoDataSource(client(), 'Order', {
      Order: { partitionKey: 'pk', sortKey: 'sk' },
    });
    expect(await ds.findById({ ignored: 'x', sk: 's', pk: 'p' })).toStrictEqual({
      pk: 'p',
      sk: 's',
    });
  });
  it('refuses scalar and incomplete composite keys', async () => {
    const ds = createDynamoDataSource(client(), 'Order', {
      Order: { partitionKey: 'pk', sortKey: 'sk' },
    });
    await expect(ds.findById('p')).rejects.toThrow('pk');
    await expect(ds.findById({ pk: 'p' })).rejects.toThrow('sk');
  });
  it('refuses empty key values', async () => {
    const ds = createDynamoDataSource(client(), 'Order', { Order: { partitionKey: 'pk' } });
    await expect(ds.findById('')).rejects.toThrow('non-empty');
  });
});
