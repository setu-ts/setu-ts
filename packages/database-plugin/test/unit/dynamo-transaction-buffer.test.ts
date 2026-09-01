import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDynamoTransactionBuffer } from '../../src/adapters/dynamo/dynamo-transaction-buffer.ts';

describe('DynamoDB transaction write buffer', () => {
  it('retains ordered writes and discards them for rollback', () => {
    const buffer = createDynamoTransactionBuffer();
    buffer.add({ Put: { TableName: 'Widget', Item: { id: { S: 'one' } } } }, { id: { S: 'one' } });
    buffer.add({ Delete: { TableName: 'Widget', Key: { id: { S: 'two' } } } }, {
      id: { S: 'two' },
    });

    expect(buffer.getWrites()).toHaveLength(2);
    buffer.discard();
    expect(buffer.getWrites()).toEqual([]);

    buffer.add({ Delete: { TableName: 'Widget', Key: { id: { S: 'two' } } } }, {
      id: { S: 'two' },
    });
    expect(buffer.getWrites()).toHaveLength(1);
  });

  it('refuses duplicate keys and a 101st write before an adapter sends anything', () => {
    const duplicate = createDynamoTransactionBuffer();
    duplicate.add({ Put: { TableName: 'Widget', Item: { id: { S: 'same' } } } }, {
      id: { S: 'same' },
    });
    expect(() =>
      duplicate.add({ Delete: { TableName: 'Widget', Key: { id: { S: 'same' } } } }, {
        id: { S: 'same' },
      })
    ).toThrow('key \'{"id":{"S":"same"}}\'');

    const full = createDynamoTransactionBuffer();
    for (let index = 0; index < 100; index += 1) {
      const id = String(index);
      full.add({ Put: { TableName: 'Widget', Item: { id: { S: id } } } }, { id: { S: id } });
    }
    expect(() =>
      full.add({ Put: { TableName: 'Widget', Item: { id: { S: '101' } } } }, { id: { S: '101' } })
    ).toThrow('100 write operations');
  });
});
